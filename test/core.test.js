import test from 'node:test';
import assert from 'node:assert/strict';
import { createDispatcher, presentationMetaFor } from '../core.js';
import { createHistory } from '../history.js';

function fixture(options = {}) {
  const state = { creates: [], disposed: 0, preflights: [], jobs: [], captured: [], children: [], policy: 'workspace-write' };
  const history = createHistory();
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
      session: { events: [], ownEvents() { return options.ownEvents ?? []; }, append(type, data) { this.events.push({ type, data }); }, snapshotEvents() { return [...(options.snapshotPrefix ?? []), ...(options.ownEvents ?? []), { data: { reason: { kind: child.cancelled ? 'aborted' : 'completed' } } }]; } },
      followup() { for (const listener of listeners) listener({ agent: child }, async () => ({ kind: 'enter', messages: [] })); },
      async whenIdle() { await idle; if (options.idleError) throw new Error('child failed'); }, cancel() { child.cancelled = true; release?.(); },
    };
    await spec.setup(childCtx, child);
    state.children.push(child);
    return { agent: child, async dispose() { state.disposed++; child.cancel(); } };
  } };
  const api = {
    history,
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
  return { runtime, state, controller, call, parent, ctx, history };
}

const usageEvent = (seq, inputTokens = 10) => ({type:'assistant/message',seq,data:{usage:{inputTokens,outputTokens:5,totalTokens:inputTokens+5}}});
test('selection and own-session usage survive foreground output, history and presentation', async () => {
  const f=fixture({ownEvents:[usageEvent(3)],snapshotPrefix:[usageEvent(0,9999)]});
  const selection={difficulty:'medium',reason:'Known scope; choose authorized route'};
  const value=await f.call({selection,provider:'p',model:'new',reasoning_effort:'low'});
  assert.deepEqual(value.selection,selection);
  assert.equal(value.tokenUsage.inputTokens,10,'exclude parent history');
  assert.equal(value.tokenUsage.totalTokens,15);
  assert.equal(value.routing.modelSource,'parent-explicit');
  assert.equal(value.routing.reasoningEffort,'low');
  assert.deepEqual(f.history.list()[0].selection,selection);
  assert.deepEqual(f.history.list()[0].tokenUsage,value.tokenUsage);
  assert.deepEqual(presentationMetaFor(value).selection,selection);
  assert.deepEqual(presentationMetaFor(value).tokenUsage,value.tokenUsage);
});
test('selection remains optional and never changes the preset default', async () => {
  const f=fixture({presetPolicies:[{preset:'minimal',enabled:true,defaultModel:{provider:'p',model:'new'},defaultEffort:'low',allowedModels:[],allowedEfforts:[]}]});
  const original=await f.call({});
  const graded=await f.call({selection:{difficulty:'high',reason:'High risk does not auto-upgrade'}});
  assert.equal(original.selection,null);
  assert.deepEqual(graded.routing,original.routing);
  assert.equal(graded.tokenUsage.status,'unknown');
  assert.equal(graded.tokenUsage.inputTokens,null);
});
test('background initial envelope carries selection and final history receives actual usage', async () => {
  const f=fixture({ownEvents:[usageEvent(1)]});
  const selection={difficulty:'low',reason:'Bounded retrieval'};
  const initial=await f.call({selection,run_in_background:true});
  assert.deepEqual(initial.selection,selection);
  assert.equal(initial.tokenUsage,null);
  await f.state.jobs[0].hooks.done;
  assert.equal(f.history.list()[0].status,'completed');
  assert.deepEqual(f.history.list()[0].selection,selection);
  assert.equal(f.history.list()[0].tokenUsage.totalTokens,15);
});
test('selection cannot bypass locks, disabled authorization or unsupported effort', async () => {
  const selection={difficulty:'high',reason:'Never a permission grant'};
  const locked=fixture({presetPolicies:[{preset:'minimal',enabled:true,defaultModel:{provider:'p',model:'new'},lockModel:true,allowedModels:[],allowedEfforts:[]}]});
  await assert.rejects(locked.call({selection,provider:'p',model:'m'}),/locked/);
  const disabled=fixture({selectionEnabled:false});
  await assert.rejects(disabled.call({selection,provider:'p',model:'new'}),/disabled/);
  const effort=fixture(); await assert.rejects(effort.call({selection,reasoning_effort:'bad'}),/unsupported effort/);
  for(const f of [locked,disabled,effort]) assert.equal(f.state.creates.length,0);
});
test('invalid selection is rejected before preflight or child creation', async () => {
  const f=fixture();
  for(const selection of [{difficulty:'extreme',reason:'x'},{difficulty:'low',reason:'x'.repeat(161)},{difficulty:'low',reason:'x',secret:'no'}]) {
    await assert.rejects(f.call({selection}),/selection/);
  }
  assert.equal(f.state.preflights.length,0); assert.equal(f.state.creates.length,0);
});
test('failed child keeps reported usage and unknown attempts without retrying', async () => {
  const f=fixture({idleError:true,ownEvents:[usageEvent(1),{type:'assistant/attempt',seq:2,data:{stream:[]}}]});
  await assert.rejects(f.call({selection:{difficulty:'high',reason:'Failure evidence'}}),/child failed/);
  const row=f.history.list()[0];
  assert.equal(row.status,'error'); assert.equal(row.tokenUsage.status,'partial');
  assert.equal(row.tokenUsage.inputTokens,10); assert.equal(row.tokenUsage.unmeteredAttempts,1);
  assert.equal(f.state.creates.length,1); assert.equal(f.state.disposed,1);
});

test('cancelled child retains known usage without claiming missing replies cost zero', async () => {
  const f=fixture({hold:true,ownEvents:[usageEvent(1),{type:'assistant/message',seq:2,data:{}}]});
  const pending=f.call({selection:{difficulty:'medium',reason:'Cancellation sample'}});
  while(!f.state.children.length) await new Promise(resolve=>setImmediate(resolve));
  f.controller.abort(); const value=await pending;
  assert.equal(value.stopReason,'aborted'); assert.equal(value.tokenUsage.status,'partial');
  assert.equal(value.tokenUsage.missingMessages,1); assert.equal(f.history.list()[0].status,'aborted');
  assert.equal(f.state.creates.length,1);
});

test('preset policy disables dispatch and list metadata', async () => {
  const f = fixture({ presetPolicies: [{ preset: 'minimal', enabled: false }] });
  // Diagnostic mode keeps the whole roster, so the row for the disabled preset stays observable.
  assert.equal((await f.runtime.listTool.execute({ diagnostic: true })).presets[0].dispatchable, false);
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
  // The compact default answer lists only dispatchable presets, so the second row — and with it
  // the `loaded:false` activation failure — is observable through the diagnostic answer only.
  const f = fixture(); const value = await f.runtime.listTool.execute({ diagnostic: true });
  assert.equal(value.presets[0].description, 'Small'); assert.equal(value.presets[0].dispatchable, true); assert.equal(value.presets[1].loaded, false);
});
// The advertised model sets must equal what dispatch will actually accept, otherwise a
// dispatch agent picks a route the very next call refuses. The default answer is the compact
// dispatch list (docs/08 C02); the full per-preset model rows are the diagnostic answer (C03).
test('advertised models are empty whenever explicit selection is unavailable', async () => {
  const live = await fixture().runtime.listTool.execute();
  assert.equal(live.explicitSelectionAvailable, true);
  assert.equal(live.models.length, 2, 'an enabled pool advertises its routes');
  assert.equal('note' in live, false, 'no note key when explicit selection is available');
  assert.deepEqual(JSON.parse(JSON.stringify(live)), live, 'the tool result must survive a JSON round-trip');
  assert.deepEqual(live.presets.map(preset => preset.id), ['minimal'], 'the compact answer drops presets that cannot be dispatched');

  const diagnostic = await fixture().runtime.listTool.execute({ diagnostic: true });
  assert.deepEqual(diagnostic.presets.map(preset => preset.id), ['minimal', 'broken'], 'diagnostic mode keeps the unloadable preset visible');
  assert.equal(diagnostic.presets[0].usableModels.length, 2, 'the full answer still carries the per-preset model rows');

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

// Review defect 1: exercise the returned value through the tool's real presentation port.
test('foreground return and persisted run envelope retain the calling parent session id', async () => {
  const f = fixture();
  const args = { preset: 'minimal', task: 'Return OK' };
  const value = await f.call(args);
  assert.equal(value.kind, 'foreground');
  assert.equal(f.state.creates.length, 1, 'the assertion must follow a real dispatch');
  const meta = f.runtime.dispatchTool.output.presentationMeta(args, value);
  assert.equal(meta.marker, 'preset-dispatch/run');
  assert.equal(meta.childSessionId, f.state.children[0].id);
  assert.notEqual(meta.childSessionId, f.parent.id, 'the child is not the calling session');
  assert.equal(value.parentSessionId, f.parent.id, 'the model-facing return must name its caller');
  assert.equal(meta.parentSessionId, f.parent.id, 'presentationMetaFor must preserve the real caller');
});

test('background return and persisted run envelope retain the calling parent session id', async () => {
  const f = fixture();
  const args = { preset: 'minimal', task: 'Return OK', run_in_background: true };
  const value = await f.call(args);
  // Drain the fixture job even when a later assertion fails; the returned object is unchanged.
  await f.state.jobs[0].hooks.done;
  assert.equal(value.kind, 'background');
  assert.equal(f.state.jobs[0].spec.owner, f.parent.id);
  const meta = f.runtime.dispatchTool.output.presentationMeta(args, value);
  assert.equal(meta.marker, 'preset-dispatch/run');
  assert.equal(meta.child.jobId, value.jobId);
  assert.equal(meta.childSessionId, value.childSessionId);
  assert.notEqual(meta.childSessionId, f.parent.id);
  assert.equal(value.parentSessionId, f.parent.id, 'the immediate background return must name its caller');
  assert.equal(meta.parentSessionId, f.parent.id, 'presentationMetaFor must not lose the caller in background mode');
});
