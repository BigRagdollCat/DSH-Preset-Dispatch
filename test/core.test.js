import test from 'node:test';
import assert from 'node:assert/strict';
import { createDispatcher } from '../core.js';

function fixture(options = {}) {
  const state = { creates: [], disposed: 0, preflights: [], jobs: [], captured: [], children: [], policy: 'workspace-write' };
  let runtime;
  const ctx = {
    get(key) {
      const value = this[key];
      if (options.traceProxies && ['sandboxPolicy', 'approval', 'permissionPresets'].includes(key)) return new Proxy(value, { get: (target, prop) => prop === 'original' ? target : target[prop] });
      return value;
    },
    sandboxPolicy: { resolve: () => ({ mode: state.policy }) }, approval: {}, permissionPresets: {},
    agentPresets: {
      async resolve(id) { if (id === 'missing') throw new Error('Unknown agent preset'); return { id, ...(id === 'broken' ? { broken: 'bad import' } : {}) }; },
      async remoteExportList() { return { presets: [{ id: 'minimal', name: 'Minimal', description: 'Small', isDefault: false }, { id: 'broken', broken: 'bad import', isDefault: false }] }; },
      async mount(childCtx, id) { childCtx.preset = id; if (options.shadowSecurity) childCtx.sandboxPolicy = {}; },
    },
    subagentModelSelection: { current: () => ({ enabled: options.selectionEnabled ?? true, allowedModels: [{ provider: 'p', model: 'm' }, { provider: 'p', model: 'new' }] }) },
    llm: { async resolveCallConfig(config) { state.preflights.push(config); if (config.reasoningEffort === 'bad') throw new Error('unsupported effort'); } },
    subagents: {
      resolveMaxDepth: () => options.hostDepth ?? 2,
      async start(_name, req) { return runtime.provider.start({ ...req, descriptor: { mode: 'one-shot', version: 3, provider: 'local-preset-dispatch' } }); },
    },
    jobs: { start(spec) { const hooks = spec.run(); state.jobs.push({ spec, hooks }); return 'subagent-1'; } },
  };
  let n = 0;
  ctx.agents = { async create(spec) {
    state.creates.push(spec);
    if (options.delayCreate) await new Promise(resolve => { state.releaseCreate = resolve; });
    const childCtx = Object.create(ctx);
    const listeners = [];
    childCtx.on = (_name, handler) => listeners.push(handler);
    childCtx.systemPrompt = { context() {}, getContextOrder() { return 1; } };
    let release;
    const idle = options.hold ? new Promise(resolve => { release = resolve; }) : Promise.resolve();
    const child = { id: spec.sessionId, ctx: childCtx, cancelled: false,
      session: { events: [], append(type, data) { this.events.push({ type, data }); }, snapshotEvents() { return [{ data: { reason: { kind: child.cancelled ? 'aborted' : 'completed' } } }]; } },
      followup() { for (const listener of listeners) listener({ agent: child }, async () => ({ kind: 'enter', messages: [] })); },
      async whenIdle() { await idle; }, cancel() { child.cancelled = true; release?.(); },
    };
    await spec.setup(childCtx, child);
    state.children.push(child);
    return { agent: child, async dispose() { state.disposed++; child.cancel(); } };
  } };
  const api = {
    serviceIdentity: value => value.original ?? value,
    randomUUID: () => `child-${++n}`, brandString: x => x, createUserMessage: x => x, SessionLogOffset: x => x,
    foldConsumedWork: events => ({ end: events.at(-1) }), finalAssistantOutput: () => [{ type: 'text', text: 'OK' }],
    captureDelegatedPolicyOverrides: () => ({ approvalPolicy: 'never' }),
    appendDelegatedPolicyOverrides: (_session, policy) => state.captured.push({ ...policy }),
    parentAgentOptionsForDelegation: () => ({ provider: 'p', model: 'm', reasoningEffort: 'high' }),
    childSessionMeta: parent => ({ cwd: parent.session.header.cwd, parentSession: parent.id, origin: 'subagent', isSeeded: false }),
    resolveChildDepth(parent, max) { const depth = (parent.depth ?? 0) + 1; if (depth > max) throw new Error('depth limit'); return depth; },
    resolveChildAgentOptions(parent, requested, depth) { const out = { provider: 'p', model: 'm', reasoningEffort: 'high', ...requested, subagentDepth: depth }; if ((out.provider !== 'p' || out.model !== 'm') && requested.reasoningEffort === undefined) delete out.reasoningEffort; return out; },
    async settleRun(run) { try { const result = await run.result; return { status: result.stopReason === 'aborted' ? 'killed' : 'completed', result: 'OK' }; } finally { await run.dispose(); } },
  };
  const parent = { id: 'parent', ctx, depth: options.depth ?? 0, session: { header: { id: 'parent', cwd: 'C:\\workspace' } } };
  runtime = createDispatcher(ctx, { allowedPresets: ['minimal', 'standard', 'missing', 'broken'], maxDepth: options.maxDepth ?? 2, allowModelSelection: options.allowModelSelection ?? true, presetPolicies: options.presetPolicies ?? [] }, api);
  const controller = new AbortController();
  const exec = { agent: parent, signal: controller.signal };
  const call = args => runtime.dispatchTool.execute({ preset: 'minimal', task: 'Return OK', ...args }, exec);
  return { runtime, state, controller, call, parent, ctx };
}

test('preset policy disables dispatch and list metadata', async () => {
  const f = fixture({ presetPolicies: [{ preset: 'minimal', enabled: false }] });
  assert.equal((await f.runtime.listTool.execute()).presets[0].dispatchable, false);
  await assert.rejects(f.call({}), /not allowed/); assert.equal(f.state.creates.length, 0);
});
test('preset defaults cannot bypass disabled Host selection', async () => {
  const f = fixture({ selectionEnabled: false, presetPolicies: [{ preset: 'minimal', enabled: true, defaultModel: { provider: 'p', model: 'new' }, allowedModels: [], allowedEfforts: [] }] });
  await assert.rejects(f.call({}), /disabled/); assert.equal(f.state.creates.length, 0);
});
test('preset locked default is forwarded and rejects override', async () => {
  const f = fixture({ presetPolicies: [{ preset: 'minimal', enabled: true, defaultModel: { provider: 'p', model: 'new' }, lockModel: true, allowedModels: [{ provider: 'p', model: 'new' }], allowedEfforts: ['low'], defaultEffort: 'low' }] });
  await f.call({}); assert.equal(f.state.preflights[0].model, 'new'); assert.equal(f.state.preflights[0].reasoningEffort, 'low');
  await assert.rejects(f.call({ provider: 'p', model: 'm' }), /locked/);
});
test('list preserves metadata and activation failures', async () => {
  const f = fixture(); const value = await f.runtime.listTool.execute();
  assert.equal(value.presets[0].description, 'Small'); assert.equal(value.presets[0].dispatchable, true); assert.equal(value.presets[1].loaded, false);
});
// The advertised model sets must equal what dispatch will actually accept, otherwise a
// dispatch agent picks a route the very next call refuses.
test('advertised models are empty whenever explicit selection is unavailable', async () => {
  const live = await fixture().runtime.listTool.execute();
  assert.equal(live.explicitSelectionAvailable, true);
  assert.equal(live.models.length, 2, 'an enabled pool advertises its routes');
  assert.equal('note' in live, false, 'no note key when explicit selection is available');
  assert.deepEqual(JSON.parse(JSON.stringify(live)), live, 'the tool result must survive a JSON round-trip');

  const hostOff = await fixture({ selectionEnabled: false, presetPolicies: [{ preset: 'minimal', enabled: true, defaultModel: null, allowedModels: [{ provider: 'p', model: 'm' }], modelScope: 'selected', allowedEfforts: [] }] }).runtime.listTool.execute();
  assert.equal(hostOff.explicitSelectionAvailable, false);
  assert.deepEqual(hostOff.models, [], 'nothing may be requested while Host authorization is off');
  const minimal = hostOff.presets.find(preset => preset.id === 'minimal');
  assert.deepEqual(minimal.usableModels, []);
  assert.deepEqual(minimal.unavailableModels, [{ provider: 'p', model: 'm' }], 'declared models must show up as unavailable instead of usable');
  assert.match(hostOff.note, /授权未启用/);

  const pluginOff = await fixture({ allowModelSelection: false, presetPolicies: [{ preset: 'minimal', enabled: true, allowedModels: [{ provider: 'p', model: 'm' }], modelScope: 'selected' }] }).runtime.listTool.execute();
  assert.equal(pluginOff.explicitSelectionAvailable, false, 'the plugin switch also disables explicit selection');
  assert.deepEqual(pluginOff.models, []);
  assert.match(pluginOff.note, /allowModelSelection=false/);
});
test('Host creates child without inheriting parent scoped factory', async () => {
  const f=fixture(); f.parent.ctx=Object.create(f.ctx); f.parent.ctx.agents={create(){throw new Error('parent factory must not be used');}};
  await f.call({}); assert.equal(f.state.creates[0].parentAgent,f.parent);
});
test('foreground really mounts target and inherits cwd and policy; cleans up', async () => {
  const f = fixture(); const value = await f.call({});
  assert.equal(value.preset, 'minimal'); assert.equal(value.stopReason, 'completed');
  assert.equal(f.state.creates[0].meta.cwd, 'C:\\workspace'); assert.equal(f.state.creates[0].meta.agentPreset, 'minimal');
  assert.equal(f.state.children[0].ctx.preset, 'minimal'); assert.equal(f.state.captured[0].sandboxMode, 'workspace-write');
  assert.equal(f.state.captured[0].approvalPolicy, 'never'); assert.equal(f.state.disposed, 1);
  assert.equal('temperature' in f.state.preflights[0], false);
});
for (const preset of ['', 'unlisted', 'missing', 'broken']) test(`rejects ${preset || 'empty'} before creation`, async () => {
  const f = fixture(); await assert.rejects(f.call({ preset })); assert.equal(f.state.creates.length, 0);
});
test('depth limit intersects Host setting', async () => {
  const f = fixture({ depth: 1, hostDepth: 1 }); await assert.rejects(f.call({}), /depth/); assert.equal(f.state.creates.length, 0);
});
test('reasoning-only override is validated and forwarded', async () => {
  const f = fixture(); await f.call({ reasoning_effort: 'low' }); assert.equal(f.state.preflights[0].reasoningEffort, 'low'); assert.equal(f.state.creates[0].agentOptions.reasoningEffort, 'low');
});
test('route change clears inherited effort', async () => {
  const f = fixture(); await f.call({ provider: 'p', model: 'new' }); assert.equal('reasoningEffort' in f.state.preflights[0], false);
});
test('disabled selection rejects reasoning-only overrides', async () => {
  const f = fixture({ selectionEnabled: false }); await assert.rejects(f.call({ reasoning_effort: 'low' }), /disabled/); assert.equal(f.state.creates.length, 0);
});
test('bad effort and unauthorized model fail before creation', async () => {
  const f = fixture(); await assert.rejects(f.call({ reasoning_effort: 'bad' }), /unsupported/); await assert.rejects(f.call({ provider: 'other', model: 'm' }), /authorized/); assert.equal(f.state.creates.length, 0);
});
test('pairing enforced', async () => { const f = fixture(); await assert.rejects(f.call({ model: 'new' }), /together/); });
test('cancelled input never creates child', async () => { const f = fixture(); f.controller.abort(); await assert.rejects(f.call({})); assert.equal(f.state.creates.length, 0); });
test('foreground cancellation remains attached while awaiting', async () => {
  const f = fixture({ hold: true }); const pending = f.call({});
  while (!f.state.children.length) await new Promise(resolve => setImmediate(resolve));
  f.controller.abort(); const result = await pending; assert.equal(result.stopReason, 'aborted'); assert.equal(f.state.disposed, 1);
});
test('background transfers ownership, can be killed, and disposes', async () => {
  const f = fixture({ hold: true }); const result = await f.call({ run_in_background: true });
  assert.equal(result.kind, 'background'); assert.equal(f.state.jobs[0].spec.owner, 'parent');
  f.controller.abort(); // Returning call cancellation must not kill admitted background work.
  while (!f.state.children.length) await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.state.children[0].cancelled, false);
  f.state.jobs[0].hooks.cancel('test'); const outcome = await f.state.jobs[0].hooks.done;
  assert.equal(outcome.status, 'killed'); assert.equal(f.state.disposed, 1);
});
test('parallel calls never mix presets', async () => {
  const f = fixture(); await Promise.all([f.call({ preset: 'minimal' }), f.call({ preset: 'standard' })]);
  assert.deepEqual(f.state.creates.map(s => s.meta.agentPreset).sort(), ['minimal', 'standard']);
});
test('plugin unload cancels and drains active child', async () => {
  const f = fixture({ hold: true }); const pending = f.call({});
  while (!f.state.children.length) await new Promise(resolve => setImmediate(resolve));
  await f.runtime.close(); await pending; assert.equal(f.state.disposed, 1); await assert.rejects(f.call({}), /closing/);
});
test('preset cannot replace security services', async () => { const f = fixture({ shadowSecurity: true }); await assert.rejects(f.call({}), /replaces security/); });
test('different Cordis trace proxies of the same services are accepted', async () => { const f = fixture({ traceProxies: true }); assert.equal((await f.call({})).stopReason, 'completed'); });
test('close waits for delayed creation before disposing published child', async () => {
  const f = fixture({ delayCreate: true }); const pending = f.call({});
  while (!f.state.releaseCreate) await new Promise(resolve => setImmediate(resolve));
  let closed = false;
  const closing = f.runtime.close().then(() => { closed = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closed, false);
  f.state.releaseCreate();
  await closing; const result = await pending;
  assert.equal(result.stopReason, 'aborted'); assert.equal(f.state.disposed, 1);
});
test('background requires an attached controller before starting child', async () => {
  const f = fixture(); f.ctx.jobs.start = () => { throw new Error('no job controller'); };
  await assert.rejects(f.call({ run_in_background: true }), /no job controller/);
  assert.equal(f.state.creates.length, 0);
});
test('pure inheritance remains available with explicit selection disabled', async () => {
  const f = fixture({ selectionEnabled: false });
  assert.equal((await f.call({})).stopReason, 'completed');
});
