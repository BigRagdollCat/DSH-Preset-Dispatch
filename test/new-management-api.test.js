import test from 'node:test';
import assert from 'node:assert/strict';
import { createDispatcher } from '../core.js';
import { gate } from '../settings-api.js';
import { managementOperations } from '../management-api.js';
import { GROUP_ID, initialDefinitions, revisionOf } from '../managed-presets.js';

// ---------------------------------------------------------------------------
// request helpers: the gate must reject before route handlers or socket work.
// ---------------------------------------------------------------------------
const LOOPBACK = { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' };

function request({ method = 'GET', host = LOOPBACK.host, origin = undefined, remoteAddress = '127.0.0.1', contentType = 'application/json' } = {}) {
  const headers = { host };
  if (origin !== undefined) headers.origin = origin;
  if (contentType !== undefined) headers['content-type'] = contentType;
  return { method, headers, socket: { remoteAddress } };
}
const rejecting = () => ({ requestRejection: () => ({ status: 401 }) });
const accepting = () => ({ requestRejection: () => undefined });
const acceptPost = { ...request({ method: 'POST', origin: LOOPBACK.origin }), socket: { remoteAddress: '127.0.0.1' } };

// ---------------------------------------------------------------------------
// settings gate (management + settings routes share it)
// ---------------------------------------------------------------------------
test('gate rejects an unauthenticated operator request even from a valid loopback/origin request', () => {
  for (const req of [request(), acceptPost]) {
    assert.throws(() => gate(req, req.method, rejecting()), /Authenticated operator request required/);
  }
  assert.throws(() => gate(acceptPost, 'POST', undefined), /Authenticated operator request required/);
});

test('gate accepts a recognized loopback same-origin operator request', () => {
  assert.doesNotThrow(() => gate(request(), 'GET', accepting()));
  assert.doesNotThrow(() => gate(acceptPost, 'POST', accepting()));
});

test('gate defers Origin trust to Connection, and still rejects a wrong method and non-loopback peer', () => {
  // The deployment owns Origin trust: the desktop app's renderer runs at `dsh-app://app`, which an
  // http-only same-origin rule here would refuse for every state-changing request.
  assert.doesNotThrow(() => gate(request({ method: 'POST', origin: 'dsh-app://app' }), 'POST', accepting()));
  assert.throws(() => gate(request({ method: 'POST', origin: 'dsh-app://app' }), 'POST', rejecting()), /Authenticated operator request required/);
  assert.throws(() => gate(request({ method: 'GET', origin: LOOPBACK.origin }), 'POST', accepting()), /Method not allowed/);
  assert.throws(() => gate(request({ remoteAddress: '10.0.0.9' }), 'GET', accepting()), /Loopback access required/);
});

// ---------------------------------------------------------------------------
// management operations fixture (group rows are the native definition rows)
// ---------------------------------------------------------------------------
function rowsFor(defs) {
  return defs.map(d => ({
    id: 'preset-' + d.id,
    name: '@deepseek-ai/dsh-agent-preset',
    config: {
      id: d.id, name: d.name, description: d.description, order: 20,
      plugins: [{ id: 'role-policy', name: 'file:///role-managed.js', config: { role: d.template, definition: d } }],
    },
  }));
}

function usage(preset) {
  return preset ? [{ id: 'agent-1', usage: [preset], ctx: { composedPreset: () => preset } }] : [];
}

function managementFixture(options = {}) {
  const state = { rows: rowsFor(initialDefinitions().slice(0,2).map((d,i)=>({...d,id:i?'beta':'alpha'}))), edits: 0 };
  let revision = revisionOf(state.rows);
  const entry = {
    options: {
      id: GROUP_ID,
      get config() { return state.rows; },
      set config(value) { state.rows = value; revision = revisionOf(value); },
    },
  };
  entry.revision = () => revision;
  const ctx = {
    configEditor: {
      entries: () => [entry],
      async edit(target, callback) {
        state.edits++;
        const current = target.options.config;
        const next = await callback(current);
        target.options.config = next;
      },
    },
    agents: { list: () => (options.agents ?? (() => usage()))() },
    agentPresets: {
      async remoteExportList() { return { presets: [{ id: 'alpha', isDefault: false }, { id: 'beta', isDefault: false }, { id: 'external', isDefault: false }] }; },
      composedPreset(agentCtx) { return agentCtx?.composedPreset?.() ?? null; },
      async resolve(id) { return id === 'beta' ? { id, broken: 'import failed' } : { id }; },
      async mount() {},
      async acquireScope() { return { key: 'scope', [Symbol.asyncDispose]: async () => {} }; },
    },
    tools: { get: () => undefined, guard() {} },
    get(key) { return this[key]; },
    effect(callback) { return callback(); },
  };
  const ops = managementOperations(ctx);
  return { ctx, ops, state, entry };
}

const created = (overrides = {}) => ({ id: 'gamma', name: 'Gamma', description: '', prompt: 'Gamma prompt', template: 'readonly', version: 1, ...overrides });

test('coordinate serializes concurrent mutations and keeps accepting work after a rejection', async () => {
  const f = managementFixture();
  let releaseFirst;
  const gate = new Promise(resolve => { releaseFirst = resolve; });
  let secondSettled = false;
  const originalEdit=f.ctx.configEditor.edit.bind(f.ctx.configEditor);
  f.ctx.configEditor.edit=async(target,callback)=>{await gate;return originalEdit(target,callback);};
  const first = f.ops.mutate({ action: 'update', id:'alpha', revision: revisionOf(f.state.rows), definition: created({id:'wrong-id'}) }).catch(e=>e);
  const second = f.ops.mutate({ action: 'delete', revision: revisionOf(f.state.rows), id: 'alpha' })
    .finally(() => { secondSettled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.state.edits, 0, 'second mutation must wait at the held commit slot');
  assert.equal(secondSettled, false, 'the second mutation waits for the first');
  releaseFirst();
  assert.match((await first).message,/immutable/);
  const deletion = await second;
  await f.ops.mutate({action:'create',revision:revisionOf(f.state.rows),definition:created()});
  assert.equal(deletion.deleted, true);
  assert.equal(f.ops.owned().some(d => d.id === 'alpha'), false);
  await assert.rejects(f.ops.mutate({ action: 'delete', revision: revisionOf(f.state.rows), id: 'external' }), /not owned/);
  const afterRejection = await f.ops.mutate({ action: 'update', revision: revisionOf(f.state.rows), id: 'gamma', definition: created({ prompt: 'Gamma v2' }) });
  assert.equal(afterRejection.saved, true);
  assert.equal(f.ops.get('gamma').version, 2);
});

test('delete waits for a failing earlier mutation and then succeeds', async () => {
  const f = managementFixture();
  let releaseInsert;
  const inserted = new Promise(resolve => { releaseInsert = resolve; });
  const originalEdit = f.ctx.configEditor.edit.bind(f.ctx.configEditor);
  let firstPass = true;
  f.ctx.configEditor.edit = async (target, callback) => {
    if (firstPass) { firstPass = false; await inserted; }
    return originalEdit(target, callback);
  };
  const failing = f.ops.mutate({ action: 'update', revision: revisionOf(f.state.rows), id: 'alpha', definition: created({ id: 'wrong-id' }) });
  const deletion = f.ops.mutate({ action: 'delete', revision: revisionOf(f.state.rows), id: 'alpha' });
  releaseInsert();
  await assert.rejects(failing, /immutable/);
  const result = await deletion;
  assert.equal(result.deleted, true);
  assert.equal(f.ops.owned().some(d => d.id === 'alpha'), false);
});

test('mutate refuses to commit a delete while the preset gains an active session', async () => {
  const f = managementFixture();
  const originalEdit = f.ctx.configEditor.edit.bind(f.ctx.configEditor);
  f.ctx.configEditor.edit = async (target, callback) => {
    f.ctx.agents.list = () => usage('beta');
    return originalEdit(target, callback);
  };
  await assert.rejects(f.ops.mutate({ action: 'delete', revision: revisionOf(f.state.rows), id: 'beta' }), /active sessions/);
  assert.equal(f.ops.owned().some(d => d.id === 'beta'), true, 'rejected delete must not remove the row');
  assert.equal(f.ops.owned().some(d => d.id === 'alpha'), true);
});

test('mutate rejects a commit whose rows changed since the revision was read', async () => {
  const f = managementFixture();
  const stale = revisionOf(f.state.rows);
  await f.ops.mutate({ action: 'delete', revision: stale, id: 'alpha' });
  await assert.rejects(f.ops.mutate({ action: 'delete', revision: stale, id: 'beta' }), /changed since it was read/);
  assert.equal(f.ops.owned().some(d => d.id === 'beta'), true);
});

test('mutate reports broken presets exposed by resolve after a commit', async () => {
  const f = managementFixture();
  const result = await f.ops.mutate({ action: 'update', revision: revisionOf(f.state.rows), id: 'beta', definition: created({ id: 'beta', prompt: 'Beta v2' }) });
  assert.equal(result.saved, true);
  assert.equal(result.broken, 'import failed');
  assert.equal(f.ops.get('beta').version, 2);
});

// ---------------------------------------------------------------------------
// dispatch startup: tickets bind the managed revision seen at request time
// ---------------------------------------------------------------------------
function dispatcherFixture() {
  const state = { creates: [], children: [], disposed: 0, preflights: [], definitions: [{ id: 'minimal', template: 'readonly', version: 1 }], looks: 0 };
  let lockTail = Promise.resolve();
  const lock = { async run(fn) { const task = lockTail.then(fn); lockTail = task.catch(() => {}); return task; } };
  const ctx = {
    get(key) { return this[key]; },
    sandboxPolicy: { resolve: () => ({ mode: 'workspace-write' }) },
    approval: {}, permissionPresets: {},
    agentPresets: {
      async resolve(id) { return { id }; },
      async remoteExportList() { return { presets: [{ id: 'minimal', isDefault: false }] }; },
      async mount() {}, async acquireScope() { return { key: 'scope', [Symbol.asyncDispose]: async () => {} }; },
    },
    subagentModelSelection: { current: () => ({ enabled: true, allowedModels: [{ provider: 'p', model: 'm' }] }) },
    llm: { async resolveCallConfig(config) { state.preflights.push(config); } },
    subagents: { resolveMaxDepth: () => 2, async start(_name, req) { return runtime.provider.start({ ...req, descriptor: { mode: 'one-shot', version: 1, provider: 'local-preset-dispatch' } }); } },
    tools: { get: () => undefined, guard() {} },
    presetLock: lock,
  };
  ctx.agents = {
    async create(spec) {
      state.creates.push(spec);
      const childCtx = Object.create(ctx);
      childCtx.on = () => {};
      childCtx.systemPrompt = { context() {}, getContextOrder() { return 1; } };
      const child = {
        id: spec.sessionId, ctx: childCtx, cancelled: false,
        session: { events: [], append() {}, snapshotEvents() { return [{ data: { reason: { kind: 'completed' } } }]; } },
        followup() {}, async whenIdle() { if (state.stall) await state.stall; }, cancel() { child.cancelled = true; },
      };
      state.children.push(child);
      await spec.setup(childCtx, child);
      if (state.duringCreate) state.duringCreate();
      return { agent: child, async dispose() { state.disposed += 1; } };
    },
  };
  let n = 0;
  const api = {
    serviceIdentity: value => value,
    randomUUID: () => `child-${++n}`, brandString: x => x, createUserMessage: x => x, SessionLogOffset: x => x,
    foldConsumedWork: events => ({ end: events.at(-1) }), finalAssistantOutput: () => [{ type: 'text', text: 'OK' }],
    captureDelegatedPolicyOverrides: () => ({ approvalPolicy: 'never' }),
    appendDelegatedPolicyOverrides: () => {},
    parentAgentOptionsForDelegation: () => ({ provider: 'p', model: 'm' }),
    childSessionMeta: () => ({ cwd: 'C:\\workspace', origin: 'subagent' }),
    resolveChildDepth: (_parent, max) => (max < 1 ? (() => { throw new Error('depth limit'); })() : 1),
    resolveChildAgentOptions: (_parent, requested, depth) => ({ provider: 'p', model: 'm', ...requested, subagentDepth: depth }),
    async settleRun(run) { return { status: 'completed', result: 'OK' }; },
    getManagedDefinition(id) { state.looks++; return structuredClone(state.definitions.find(d => d.id === id) ?? null); },
    withPresetLock: fn => lock.run(fn),
  };
  const parent = { id: 'parent', depth: 0, ctx, session: { header: { id: 'parent', cwd: 'C:\\workspace' } } };
  const config = { allowedPresets: ['minimal'], maxDepth: 2, allowModelSelection: true, presetPolicies: [] };
  const runtime = createDispatcher(ctx, config, api);
  const exec = { agent: parent, signal: new AbortController().signal };
  const call = args => runtime.dispatchTool.execute({ preset: 'minimal', task: 'Return OK', ...args }, exec);
  return { runtime, state, call, ctx, config };
}

test('dispatch startup rejects a ticket whose managed definition changed after admission', async () => {
  const f = dispatcherFixture();
  const original = f.runtime.provider.start;
  f.runtime.provider.start = request => {
    f.state.definitions[0].version = 2;
    return original.call(f.runtime.provider, request);
  };
  await assert.rejects(f.call({}), /preset changed during dispatch; retry only after reviewing the new revision/);
  assert.equal(f.state.creates.length, 0, 'no child may be created for a stale ticket');
});

test('a preset disabled while the ticket is in flight cannot start', async () => {
  const f = dispatcherFixture();
  const original = f.runtime.provider.start;
  f.runtime.provider.start = request => { f.config.presetPolicies = [{ preset: 'minimal', enabled: false }]; return original.call(f.runtime.provider, request); };
  await assert.rejects(f.call({}), /no longer allowed to dispatch/);
  assert.equal(f.state.creates.length, 0, 'a revoked preset must not create a child');
});

test('a model revoked from the Host pool while the ticket is in flight cannot start', async () => {
  const f = dispatcherFixture();
  const original = f.runtime.provider.start;
  f.runtime.provider.start = request => { f.ctx.subagentModelSelection = { current: () => ({ enabled: true, allowedModels: [] }) }; return original.call(f.runtime.provider, request); };
  await assert.rejects(f.call({}), /is no longer authorized by Host settings/);
  assert.equal(f.state.creates.length, 0, 'the effective route must be re-authorized, not silently replaced');
});

test('a policy that narrows the allowed models while the ticket is in flight cannot start', async () => {
  const f = dispatcherFixture();
  const original = f.runtime.provider.start;
  f.runtime.provider.start = request => {
    f.config.presetPolicies = [{ preset: 'minimal', enabled: true, modelScope: 'selected', allowedModels: [{ provider: 'other', model: 'x' }], allowedEfforts: [] }];
    return original.call(f.runtime.provider, request);
  };
  await assert.rejects(f.call({}), /Effective model is outside preset allowed models/);
  assert.equal(f.state.creates.length, 0);
});

test('a depth limit lowered while the ticket is in flight refuses the dispatch', async () => {
  const f = dispatcherFixture();
  const original = f.runtime.provider.start;
  f.runtime.provider.start = request => { f.config.maxDepth = 0; return original.call(f.runtime.provider, request); };
  await assert.rejects(f.call({}), /depth limit was lowered during dispatch/);
  assert.equal(f.state.creates.length, 0);
});

test('a child created while the authorization moved is released, not started', async () => {
  const f = dispatcherFixture();
  // The authorization is revoked while the child is being built, so only the post-create
  // check can catch it: it must refuse and release what was just created.
  f.state.duringCreate = () => { f.config.presetPolicies = [{ preset: 'minimal', enabled: false }]; };
  await assert.rejects(f.call({}), /no longer allowed to dispatch/);
  assert.equal(f.state.children.length, 1, 'the child really was created before the check');
  assert.equal(f.state.disposed, 1, 'a refused child must be released instead of left behind');
});

test('a start boundary refusal leaves a still-running child alone', async () => {
  const f = dispatcherFixture();
  const original = f.runtime.provider.start;
  let release;
  // The first child stays genuinely running: its turn is gated until the test releases it.
  f.state.stall = new Promise(resolve => { release = resolve; });
  const first = f.call({});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.state.creates.length, 1, 'the first dispatch must still be running');

  f.runtime.provider.start = request => { f.config.presetPolicies = [{ preset: 'minimal', enabled: false }]; return original.call(f.runtime.provider, request); };
  await assert.rejects(f.call({}), /no longer allowed to dispatch/);
  assert.equal(f.state.children.length, 1, 'the refused dispatch must not create a second child');
  assert.equal(f.state.children[0].cancelled, false, 'no running child may be cancelled by a later refusal');

  release();
  assert.equal((await first).stopReason, 'completed', 'the running child finishes normally');
});

test('dispatch admission shares the management lock with mutations', async () => {  const f = dispatcherFixture();
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const mutation = f.ctx.presetLock.run(async () => { await held; });
  let settled = false;
  const dispatch = f.call({}).finally(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false, 'dispatch cannot start while a mutation holds the lock');
  release();
  await mutation;
  const result = await dispatch;
  assert.equal(result.stopReason, 'completed');
});
