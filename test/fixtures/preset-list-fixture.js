// Test-only fixture for the preset_list / preset_dispatch contract (docs/08 C01-C05).
//
// It builds the smallest Host surface createDispatcher actually reads: the preset roster,
// the Host model-authorization pool, an LLM catalog service, the delegated-policy capture
// and the agent/job services a real dispatch needs. Roster and pool are options so each
// test states the situation it is asserting instead of relying on a shared mutable state.
//
// This file is imported by test/context-catalog.test.js only. It is not part of the
// published package and must never be imported by production code.
import { createDispatcher } from '../../core.js';

// The default roster deliberately contains one of each interesting case:
//  - minimal   loaded, allowed, pinned model + effort, modelScope 'selected'
//  - standard  loaded, allowed, host-scoped (follows the authorized pool), no pinning
//  - off       loaded but disabled by preset policy: not dispatchable
//  - broken    loaded:false (import failure): not dispatchable
//  - ghost     not in allowedPresets at all: not dispatchable
export const ROSTER = [
  { id: 'minimal', name: 'Minimal', description: 'Small', isDefault: false },
  { id: 'standard', name: 'Standard', description: 'Wide', isDefault: true },
  { id: 'off', name: 'Off', description: 'Disabled by policy', isDefault: false },
  { id: 'broken', name: 'Broken', broken: 'bad import', isDefault: false },
  { id: 'ghost', name: 'Ghost', description: 'Not allowed here', isDefault: false },
];

// `enabled` and `lockModel` are written out even when they are the default, so a row that
// does not lock its model carries `lockModel: false` instead of an absent key: production
// normalizes stored rows before they are read (`normalizePolicies`).
export const PRESET_POLICIES = [
  { preset: 'minimal', enabled: true, lockModel: false, defaultModel: { provider: 'p', model: 'm' }, defaultEffort: 'high', allowedModels: [{ provider: 'p', model: 'm' }], modelScope: 'selected', allowedEfforts: ['low', 'high'] },
  { preset: 'off', enabled: false, lockModel: false },
];

export const ALLOWED_PRESETS = ['minimal', 'standard', 'off', 'broken'];

// The Host pool enables p/m and p/new. p/ghost is inside the LLM catalog but outside the
// pool, so it may only ever surface as an unauthorized/diagnostic value.
export const HOST_POOL = [{ provider: 'p', model: 'm' }, { provider: 'p', model: 'new' }];

export function catalogFixture(options = {}) {
  const state = { creates: [], preflights: [], jobs: [], children: [], captured: [], history: [], listeners: [], disposed: 0, reads: 0 };
  let runtime;
  let sessionSeq = 0;
  const ctx = {
    get(key) { return this[key]; },
    sandboxPolicy: { resolve: () => ({ mode: 'workspace-write' }) },
    approval: {}, permissionPresets: {},
    agentPresets: {
      async resolve(id) {
        if (id === 'missing') throw new Error('Unknown agent preset');
        const row = (options.roster ?? ROSTER).find(preset => preset.id === id);
        if (!row) throw new Error('Unknown agent preset');
        return { ...row };
      },
      async remoteExportList() { return { presets: (options.roster ?? ROSTER).map(preset => ({ ...preset })) }; },
      async mount(childCtx, id) { childCtx.preset = id; },
      async acquireScope() { return { key: 'lease-key', async [Symbol.asyncDispose]() {} }; },
    },
    tools: { get: () => null, schemas: () => [] },
    subagentModelSelection: { current: () => ({ enabled: options.selectionEnabled ?? true, allowedModels: (options.hostPool ?? HOST_POOL).map(route => ({ ...route })) }) },
    llm: {
      listProviders: () => {
        state.reads++;
        if (options.catalogThrows) throw new Error('catalog exploded');
        return [{ id: 'p', name: 'Provider P' }];
      },
      listModels: async () => (options.catalogModels ?? [
        { id: 'm', name: 'M One' },
        { id: 'new', name: 'New One' },
        { id: 'ghost', name: 'Ghost One' },
      ]),
      resolveModelInfo: async (_provider, id) => {
        if (options.capabilitiesUnknown) throw new Error('no metadata');
        if (id === 'm') return { name: 'M One', reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'medium' }, { id: 'high', name: 'High' }], defaultEffort: 'high' } };
        return { name: id };
      },
      // preset_dispatch validates the effective route/effort through this same adapter hook
      // before any child exists. Without it the admission path throws a TypeError instead of
      // reaching the assertion under test, so the fixture records every preflight call exactly
      // as test/core.test.js does.
      async resolveCallConfig(config) {
        state.preflights.push(config);
        if (config.reasoningEffort === 'bad') throw new Error('unsupported effort');
      },
    },
    subagents: {
      resolveMaxDepth: () => 2,
      async start(_name, request, childSignal) { return runtime.provider.start({ ...request, signal: request.signal ?? childSignal, descriptor: { mode: 'one-shot', version: 3, provider: 'local-preset-dispatch' } }); },
    },
    jobs: { start(spec) { state.jobs.push({ spec }); return 'job-1'; } },
  };
  ctx.agents = {
    async create(spec) {
      state.creates.push(spec);
      const childCtx = Object.create(ctx);
      childCtx.systemPrompt = { context() {}, getContextOrder() { return 1; } };
      // The delegation setup registers a pre-step hook for the subagent descriptor. A child ctx
      // without `on` turns that contract into a TypeError, so the fixture records the handlers.
      childCtx.on = (name, handler) => { state.listeners.push({ name, handler }); };
      const child = {
        id: spec.sessionId, ctx: childCtx, cancelled: false,
        session: { events: [], append(type, data) { this.events.push({ type, data }); }, snapshotEvents: () => [{ data: { reason: { kind: 'completed' } } }] },
        followup() {},
        async whenIdle() {},
        cancel() { child.cancelled = true; },
      };
      await spec.setup(childCtx, child);
      state.children.push(child);
      return { agent: child, async dispose() { state.disposed++; } };
    },
  };
  const api = {
    serviceIdentity: value => value.original ?? value,
    randomUUID: () => `child-${++sessionSeq}`,
    brandString: value => value,
    createUserMessage: value => value,
    SessionLogOffset: value => value,
    foldConsumedWork: events => ({ end: events.at(-1) }),
    finalAssistantOutput: () => [{ type: 'text', text: 'OK' }],
    captureDelegatedPolicyOverrides: () => ({ approvalPolicy: 'never' }),
    appendDelegatedPolicyOverrides: (_session, policy) => state.captured.push({ ...policy }),
    parentAgentOptionsForDelegation: () => ({ provider: 'p', model: 'm', reasoningEffort: 'high' }),
    childSessionMeta: parent => ({ cwd: parent.session.header.cwd, parentSession: parent.id, origin: 'subagent', isSeeded: false }),
    resolveChildDepth(parent, max) { const depth = (parent.depth ?? 0) + 1; if (depth > max) throw new Error('depth limit'); return depth; },
    resolveChildAgentOptions(_parent, requested) { return { provider: 'p', model: 'm', reasoningEffort: 'high', ...requested }; },
    async settleRun(run) {
      try {
        const result = await run.result;
        return { status: result.stopReason === 'aborted' ? 'killed' : 'completed', result: 'OK' };
      } finally { await run.dispose(); }
    },
    history: {
      begin(record) { state.history.push({ phase: 'begin', record: { ...record } }); return { id: 'run-1' }; },
      finish(record, status, runId) { state.history.push({ phase: 'finish', id: record?.id, status, runId }); },
    },
  };
  const parent = { id: options.sessionId ?? 'parent', ctx, depth: 0, session: { header: { id: options.sessionId ?? 'parent', cwd: 'C:\\workspace' } } };
  runtime = createDispatcher(ctx, {
    allowedPresets: options.allowedPresets ?? ALLOWED_PRESETS,
    maxDepth: 2,
    allowModelSelection: options.allowModelSelection ?? true,
    presetPolicies: options.presetPolicies ?? PRESET_POLICIES,
  }, api);
  const exec = { agent: options.agent === undefined ? parent : options.agent, signal: new AbortController().signal };
  return {
    runtime, ctx, parent, state,
    list: args => runtime.listTool.execute(args, exec),
    call: args => runtime.dispatchTool.execute({ preset: 'minimal', task: 'Return OK', ...args }, exec),
  };
}

export const routeKey = route => `${route.provider}\u0000${route.model}`;

// Both the shared-pool shape and a row-level `usableModels` array are accepted, because the
// exact envelope is the implementer's choice; what is asserted is that whatever list the
// answer hands a caller is bounded by the Host-authorized pool.
export function sharedPool(value) {
  const models = value?.models;
  if (Array.isArray(models)) return models;
  return Array.isArray(models?.routes) ? models.routes : [];
}

export function rowPool(row) {
  return Array.isArray(row?.usableModels) ? row.usableModels : [];
}
