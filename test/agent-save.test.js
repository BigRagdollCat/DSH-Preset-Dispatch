import test from 'node:test';
import assert from 'node:assert/strict';
import { registerSettingsApi, POOL_NAMESPACE } from '../settings-api.js';

const FLASH = { provider: 'opencode-go', model: 'deepseek-v4.1-flash' };
const SOL = { provider: 'codex-chatgpt', model: 'gpt-6.1-sol' };
const PLUGIN_NS = 'local-preset-dispatch';

/**
 * Minimal Host harness: registers the real routes and drives them with real
 * requests, so ownership, prevalidation, save ordering and per-part reporting are
 * exercised end to end.
 */
function harness({ pool = { enabled: true, allowedModels: [FLASH], revision: 3 }, definitionsFail = false, planFails = false, stateFails = false, poolReadFails = false, poolReadFailsAfter = 0, narrowAfter = 0, policies = [], allowedPresets = [], catalogCache = null } = {}) {
  const captured = new Map();
  const updates = [];
  const attempts = [];
  const entry = { ns: PLUGIN_NS, revision: 7, value: { maxDepth: 1, presetPolicies: policies } };
  // Stable state object behind the getter, so a pool write is visible to later reads.
  const poolValue = pool === null ? null : { enabled: pool.enabled, allowedModels: pool.allowedModels };
  let poolReads = 0;
  const poolEntry = pool === null ? null : {
    ns: POOL_NAMESPACE, revision: pool.revision,
    // A throwing getter models a Host that fails when the pool is read back; the
    // counter lets a test fail the read after the writes instead of before them.
    get value() { poolReads++; if (poolReadFails && poolReads > poolReadFailsAfter) throw new Error('pool read exploded'); if (narrowAfter && poolReads > narrowAfter) return { ...poolValue, allowedModels: [] }; return poolValue; },
  };
  const ctx = {
    settings: {
      describe: () => (poolEntry ? [entry, poolEntry] : [entry]),
      update: async (ns, patch, revision) => {
        attempts.push(ns);
        // A real Host refuses a write whose revision is not current, so this harness must
        // too: otherwise "CAS passed" would mean nothing.
        if (ns === entry.ns && revision !== entry.revision) throw new Error('stale revision ' + revision + ' != ' + entry.revision);
        if (pool?.fail === true && ns === POOL_NAMESPACE) throw new Error('pool write refused by Host');
        updates.push({ ns, patch, revision });
        if (ns === entry.ns) { Object.assign(entry.value, patch); entry.revision += 1; }
        if (poolEntry && ns === POOL_NAMESPACE) { Object.assign(poolEntry.value, patch); poolEntry.revision += 1; }
      },
    },
    connection: { requestRejection: () => undefined },
    agentPresets: { remoteExportList: async () => ({ presets: [{ id: 'planner' }, { id: 'standard' }] }) },
    llm: {
      listProviders: () => [{ id: 'opencode-go', name: 'opencode-go' }, { id: 'codex-chatgpt', name: 'codex-chatgpt' }],
      listModels: async provider => (provider === 'opencode-go' ? [{ id: FLASH.model, name: 'Flash' }] : [{ id: SOL.model, name: '6.1 Sol' }]),
      resolveModelInfo: async (_provider, model) => (model === FLASH.model
        ? { name: 'Flash', reasoning: { efforts: [{ id: 'low' }, { id: 'high' }] } }
        : { name: '6.1 Sol', reasoning: { efforts: [{ id: 'medium' }, { id: 'high' }] } }),
    },
    effect: fn => { fn(); return () => {}; },
    webServer: { register: route => { captured.set(route.path, route.handler); return () => {}; } },
  };
  const management = {
    async state() { if (stateFails) throw new Error('catalog refresh exploded'); return { revision: 'def-1', definitions: [], templates: { readonly: '只读' }, external: [] }; },
    coordinate: fn => fn(),
    owned: () => [{ id: 'planner' }],
    async plan() { attempts.push('plan'); if (planFails) throw new Error('Preset configuration changed since it was read; reload'); return true; },
    mutateUncoordinated: async input => { attempts.push('definition:' + input.action); if (definitionsFail) throw new Error('preset configuration changed'); return { saved: true }; },
  };
  const config = { allowedPresets, allowModelSelection: true, maxDepth: { get: () => 1 } };
  registerSettingsApi(ctx, config, management, catalogCache);

  const call = async (path, payload, { authorized = true } = {}) => {
    const handler = captured.get(path);
    assert.ok(handler, 'route must be registered: ' + path);
    const headers = { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080', 'content-type': 'application/json' };
    const req = {
      method: 'POST', headers, socket: { remoteAddress: '127.0.0.1' },
      async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(payload)); },
    };
    if (!authorized) req.socket.remoteAddress = '10.0.0.9';
    const res = { statusCode: 0, body: null, writeHead(code) { this.statusCode = code; }, end(text) { this.body = JSON.parse(text); } };
    await handler(req, res);
    return { status: res.statusCode, body: res.body };
  };
  // Real writes only: prevalidation is not a write attempt.
  const writes = () => attempts.filter(attempt => attempt !== 'plan');
  return { call, updates, attempts, writes, captured };
}

const policy = patch => ({ preset: 'planner', enabled: true, modelScope: 'selected', defaultModel: FLASH, allowedModels: [FLASH], lockModel: false, defaultEffort: null, allowedEfforts: [], ...patch });
// The exact shape a stored row has after normalization, for "unchanged row" tests.
const storedRow = patch => ({ preset: 'planner', enabled: false, defaultModel: null, allowedModels: [], modelScope: 'host', lockModel: false, defaultEffort: null, allowedEfforts: [], ...patch });
const deletion = (patch = {}) => ({ action: 'delete', id: 'planner', revision: 'def-1', ...patch });
const storedPolicy = (updates, preset = 'planner') => updates.find(update => update.ns === PLUGIN_NS)?.patch.presetPolicies.find(row => row.preset === preset);
// The last policy write of a request; a create writes twice (neutralize, then the policy).
const finalPolicy = (updates, preset = 'planner') => updates.filter(update => update.ns === PLUGIN_NS).at(-1)?.patch.presetPolicies.find(row => row.preset === preset);

test('removing a policy row cannot silently restore a statically allowed preset', async () => {
  // No row means dispatch falls back to the static allow-list, so deleting a disabled
  // row for a statically allowed id would grant it dispatch again.
  const legacy = storedRow({ preset: 'standard', enabled: false });
  const { call, updates } = harness({ policies: [legacy], allowedPresets: ['standard'] });
  const result = await call('/api/preset-dispatch/agent-save', { settingsRevision: 7, maxDepth: 1, presetPolicies: [] });
  assert.equal(result.body.settingsSaved, false);
  assert.equal(result.body.errors[0].code, 'forbidden');
  assert.match(result.body.errors[0].message, /回退到静态允许列表/);
  assert.equal(updates.length, 0, 'a widening removal must be refused, not applied');
});

test('creating a preset neutralizes a leftover row before the definition exists', async () => {
  const leftover = storedRow({ preset: 'ghost2', enabled: true, defaultModel: FLASH, allowedModels: [FLASH], modelScope: 'selected' });
  const body = {
    settingsRevision: 7,
    definition: { action: 'create', id: 'ghost2', definition: { id: 'ghost2', name: 'G' }, revision: 'def-1' },
    policy: { preset: 'ghost2', enabled: true, modelScope: 'selected', defaultModel: FLASH, allowedModels: [FLASH], lockModel: false, defaultEffort: null, allowedEfforts: [] },
  };
  // The create fails after the neutralizing write: no authorization may survive it.
  const failing = harness({ policies: [leftover], definitionsFail: true });
  const refused = await failing.call('/api/preset-dispatch/agent-save', body);
  assert.equal(refused.body.definitionSaved, false);
  assert.deepEqual(failing.writes(), [PLUGIN_NS, 'definition:create'], 'the leftover row must be neutralized before the create is attempted');
  assert.equal(storedPolicy(failing.updates, 'ghost2').enabled, false, 'the old authorization must be gone even though the create failed');
  assert.deepEqual(storedPolicy(failing.updates, 'ghost2').allowedModels, []);

  const ok = harness({ policies: [leftover] });
  const created = await ok.call('/api/preset-dispatch/agent-save', body);
  assert.deepEqual(created.body.errors, []);
  assert.equal(created.body.definitionSaved, true);
  assert.equal(created.body.policySaved, true, 'a newly created preset may enable its own policy');
  assert.deepEqual(finalPolicy(ok.updates, 'ghost2').allowedModels, [FLASH], 'the requested policy is written after the definition');
});

test('deleting a preset denies dispatch before the definition is removed', async () => {
  const { call, writes, updates } = harness({ policies: [storedRow({ preset: 'planner', enabled: true, defaultModel: FLASH, allowedModels: [FLASH], modelScope: 'selected' })] });
  const result = await call('/api/preset-dispatch/agent-save', { settingsRevision: 7, definition: deletion() });
  assert.deepEqual(result.body.errors, []);
  assert.equal(result.body.policySaved, true);
  assert.equal(result.body.definitionSaved, true);
  assert.deepEqual(writes(), [PLUGIN_NS, 'definition:delete'], 'the policy must be written before the definition goes away');
  assert.equal(storedPolicy(updates), undefined, 'the leftover row must not survive a successful delete');
});

test('a delete that fails after the policy write leaves nothing dispatchable', async () => {
  const { call, writes, updates } = harness({ definitionsFail: true, policies: [storedRow({ preset: 'planner', enabled: true, defaultModel: FLASH, allowedModels: [FLASH], modelScope: 'selected' })] });
  const result = await call('/api/preset-dispatch/agent-save', { settingsRevision: 7, definition: deletion() });
  assert.equal(result.body.policySaved, true, 'dispatch was denied first, and that really was written');
  assert.equal(result.body.definitionSaved, false);
  assert.equal(result.body.errors[0].part, 'definition');
  assert.deepEqual(writes(), [PLUGIN_NS, 'definition:delete']);
  assert.equal(storedPolicy(updates), undefined, 'the preset may survive, but no policy may still enable it');
});

test('a delete keeps an explicitly disabled row when the static allow-list would still permit the id', async () => {
  const { call, updates } = harness({ allowedPresets: ['planner'], policies: [storedRow({ preset: 'planner', enabled: true, defaultModel: FLASH, allowedModels: [FLASH], modelScope: 'selected' })] });
  const result = await call('/api/preset-dispatch/agent-save', { settingsRevision: 7, definition: deletion() });
  assert.deepEqual(result.body.errors, []);
  // Removing the row alone would fall back to `allowedPresets`, so the row is kept
  // and disabled instead: an explicit `enabled: false` cannot be overridden.
  const kept = storedPolicy(updates);
  assert.equal(kept.enabled, false);
  assert.deepEqual(kept.allowedModels, []);
});

test('a new preset must initialize its policy in the same request', async () => {
  const { call, writes } = harness();
  const result = await call('/api/preset-dispatch/agent-save', {
    settingsRevision: 7,
    definition: { action: 'create', id: 'ghost2', definition: { id: 'ghost2', name: 'G' }, revision: 'def-1' },
  });
  assert.equal(result.body.definitionSaved, false);
  assert.match(result.body.errors[0].message, /必须同时初始化派遣策略/);
  assert.deepEqual(writes(), [], 'a preset must never be created without its policy');
});

test('a delete cannot smuggle its own policy', async () => {
  const { call, writes } = harness();
  const result = await call('/api/preset-dispatch/agent-save', { settingsRevision: 7, definition: deletion(), policy: policy() });
  assert.equal(result.body.definitionSaved, false);
  assert.match(result.body.errors[0].message, /策略由服务端派生/);
  assert.deepEqual(writes(), []);
});

test('a reused id starts from the requested policy, not the leftover row', async () => {
  const leftover = storedRow({ preset: 'ghost2', enabled: true, defaultModel: FLASH, allowedModels: [FLASH], modelScope: 'selected' });
  const { call, updates } = harness({ policies: [leftover] });
  const result = await call('/api/preset-dispatch/agent-save', {
    settingsRevision: 7,
    definition: { action: 'create', id: 'ghost2', definition: { id: 'ghost2', name: 'G' }, revision: 'def-1' },
    policy: { preset: 'ghost2', enabled: false, modelScope: 'host', defaultModel: null, allowedModels: [], lockModel: false, defaultEffort: null, allowedEfforts: [] },
  });
  assert.deepEqual(result.body.errors, []);
  assert.equal(result.body.policySaved, true);
  assert.equal(result.body.definitionSaved, true);
  const row = storedPolicy(updates, 'ghost2');
  assert.equal(row.enabled, false, 'the leftover authorization must not carry over to the new preset');
  assert.deepEqual(row.allowedModels, []);
});

test('a policy naming an unauthorized model is refused and nothing is written', async () => {
  const { call, updates } = harness();
  const result = await call('/api/preset-dispatch/agent-save', { settingsRevision: 7, policy: policy({ allowedModels: [FLASH, SOL] }) });
  assert.equal(result.status, 200);
  assert.equal(result.body.policySaved, false);
  assert.equal(result.body.errors.length, 1);
  assert.equal(result.body.errors[0].part, 'policy');
  assert.equal(result.body.errors[0].code, 'validation');
  assert.match(result.body.errors[0].message, /尚未在 DSH 子代理授权中启用/);
  assert.equal(updates.some(update => update.ns === PLUGIN_NS), false, 'a refused policy must not be persisted');
});

test('confirming authorization widens the pool first, then the policy is validated against it', async () => {
  const { call, updates, writes } = harness();
  const result = await call('/api/preset-dispatch/agent-save', {
    settingsRevision: 7,
    hostPool: { enabled: true, allowedModels: [FLASH, SOL], revision: 3 },
    policy: policy({ allowedModels: [FLASH, SOL], defaultModel: SOL, defaultEffort: 'high' }),
  });
  assert.equal(result.body.hostPoolSaved, true);
  assert.equal(result.body.policySaved, true);
  assert.deepEqual(result.body.errors, []);
  assert.deepEqual(writes(), [POOL_NAMESPACE, PLUGIN_NS], 'the pool must be written before the policy it authorizes');
  const poolUpdate = updates.find(update => update.ns === POOL_NAMESPACE);
  assert.equal(poolUpdate.revision, 3, 'the pool revision must be fenced');
  assert.deepEqual(poolUpdate.patch.allowedModels, [FLASH, SOL]);
});

test('a refused pool write stops the remaining parts instead of saving on a stale premise', async () => {
  const { call, updates, writes } = harness({ pool: { enabled: true, allowedModels: [FLASH], revision: 3, fail: true } });
  const result = await call('/api/preset-dispatch/agent-save', {
    settingsRevision: 7,
    hostPool: { enabled: true, allowedModels: [FLASH, SOL], revision: 3 },
    definition: { action: 'update', id: 'planner', definition: { id: 'planner', name: 'P' }, revision: 'def-1' },
    policy: policy(),
  });
  assert.equal(result.body.hostPoolSaved, false);
  assert.equal(result.body.definitionSaved, false);
  assert.equal(result.body.policySaved, false);
  assert.equal(result.body.errors[0].part, 'hostPool');
  assert.match(result.body.errors[0].message, /pool write refused by Host/);
  assert.deepEqual(writes(), [POOL_NAMESPACE], 'no later part may run after a failed authorization write');
  assert.equal(updates.some(update => update.ns === PLUGIN_NS), false);
});

test('a failed definition write leaves the policy unsaved and says so', async () => {
  const { call, updates, writes } = harness({ definitionsFail: true });
  const result = await call('/api/preset-dispatch/agent-save', {
    definition: { action: 'update', id: 'planner', definition: { id: 'planner', name: 'P' }, revision: 'def-1' },
    settingsRevision: 7,
    policy: policy(),
  });
  assert.equal(result.body.definitionSaved, false);
  assert.equal(result.body.policySaved, false);
  assert.equal(result.body.errors[0].part, 'definition');
  assert.deepEqual(writes(), ['definition:update']);
  assert.equal(updates.some(update => update.ns === PLUGIN_NS), false);
});

test('an absent authorization entry is reported as unwritable, not silently ignored', async () => {
  const { call } = harness({ pool: null });
  const result = await call('/api/preset-dispatch/agent-save', { hostPool: { enabled: true, allowedModels: [SOL], revision: null } });
  assert.equal(result.body.hostPoolSaved, false);
  assert.match(result.body.errors[0].message, /未在此 profile 中启用/);
});

test('an effort the chosen model does not advertise is refused at save time', async () => {
  const { call } = harness();
  const result = await call('/api/preset-dispatch/agent-save', { settingsRevision: 7, policy: policy({ defaultEffort: 'xhigh' }) });
  assert.equal(result.body.policySaved, false);
  assert.match(result.body.errors[0].message, /不支持思考强度 xhigh/);
});

test('the unified save endpoint keeps the operator gate', async () => {
  const { call, attempts } = harness();
  const result = await call('/api/preset-dispatch/agent-save', { settingsRevision: 7, policy: policy() }, { authorized: false });
  assert.equal(result.status, 400);
  assert.match(result.body.error, /Loopback access required/);
  assert.deepEqual(attempts, [], 'an unauthorized request must not reach any write');
});

test('a stale settings revision is refused instead of overwriting a concurrent edit', async () => {
  const { call, updates } = harness();
  const stale = await call('/api/preset-dispatch/agent-save', { settingsRevision: 6, policy: policy() });
  assert.equal(stale.body.policySaved, false);
  assert.equal(stale.body.errors[0].code, 'conflict');
  assert.match(stale.body.errors[0].message, /已在其他页面更新/);
  assert.equal(updates.some(update => update.ns === PLUGIN_NS), false, 'a stale draft must not be written');

  const fresh = await call('/api/preset-dispatch/agent-save', { settingsRevision: 7, policy: policy() });
  assert.equal(fresh.body.policySaved, true, 'the same payload succeeds once the revision matches');
});

test('a stale revision on the global save is refused and the depth is untouched', async () => {
  const { call, updates } = harness();
  const result = await call('/api/preset-dispatch/agent-save', { settingsRevision: 1, maxDepth: 3, presetPolicies: [] });
  assert.equal(result.body.settingsSaved, false);
  assert.match(result.body.errors[0].message, /已在其他页面更新/);
  assert.equal(updates.some(update => update.ns === PLUGIN_NS), false);
});

test('a failed state refresh still reports the parts that were already written', async () => {
  const { call, updates } = harness({ stateFails: true });
  const result = await call('/api/preset-dispatch/agent-save', { settingsRevision: 7, policy: policy() });
  assert.equal(result.status, 200, 'the refresh failure must not become a blanket 400');
  assert.equal(result.body.policySaved, true, 'the write outcome survives a refresh failure');
  assert.deepEqual(result.body.errors, []);
  assert.equal(result.body.state, null);
  assert.match(result.body.stateError, /catalog refresh exploded/);
  assert.equal(updates.some(update => update.ns === PLUGIN_NS), true);
});

test('a pool read that fails before any write refuses the request with zero writes', async () => {
  const { call, updates, writes } = harness({ poolReadFails: true, poolReadFailsAfter: 0 });
  const result = await call('/api/preset-dispatch/agent-save', {
    settingsRevision: 7,
    definition: { action: 'update', id: 'planner', definition: { id: 'planner', name: 'P' }, revision: 'def-1' },
    policy: policy(),
  });
  assert.equal(result.status, 200, 'an unconfirmable read must not become a blanket 400');
  assert.equal(result.body.definitionSaved, false);
  assert.equal(result.body.policySaved, false);
  assert.equal(result.body.errors[0].part, 'hostPool');
  assert.equal(result.body.errors[0].code, 'unknown', 'an unreadable pool is an unconfirmed outcome, not a bad request');
  assert.deepEqual(writes(), [], 'prevalidation must not write anything when it cannot confirm the authorization');
  assert.equal(updates.length, 0);
});

test('a policy is not written on an authorization that cannot be re-read at the boundary', async () => {
  const { call, updates } = harness({ poolReadFails: true, poolReadFailsAfter: 1 });
  const result = await call('/api/preset-dispatch/agent-save', { settingsRevision: 7, policy: policy() });
  assert.equal(result.status, 200, 'an unconfirmable read must not become a blanket 400');
  assert.equal(result.body.policySaved, false, 'prevalidation alone is not proof that the authorization still holds');
  assert.equal(result.body.errors[0].part, 'policy');
  assert.deepEqual(result.body.pending, ['policySaved'], 'the unfinished part must be reported for a retry');
  assert.equal(updates.some(update => update.ns === PLUGIN_NS), false, 'nothing may be written');
});

test('an authorization narrowed while planning refuses the policy write', async () => {
  // The pool validates during planning, then the write boundary reads it again and
  // finds it narrowed: the policy refers to a model that is no longer authorized.
  const { call, updates } = harness({ narrowAfter: 1 });
  const result = await call('/api/preset-dispatch/agent-save', { settingsRevision: 7, policy: policy() });
  assert.equal(result.body.policySaved, false);
  assert.equal(result.body.errors[0].code, 'conflict');
  assert.match(result.body.errors[0].message, /模型授权在保存期间发生变化/);
  assert.equal(updates.some(update => update.ns === PLUGIN_NS), false, 'no policy may land on a stale premise');
});

test('an external preset policy can never be granted authority here', async () => {
  const { call, updates, writes } = harness();
  const result = await call('/api/preset-dispatch/agent-save', { settingsRevision: 7, policy: policy({ preset: 'standard' }) });
  assert.equal(result.body.policySaved, false);
  assert.equal(result.body.errors[0].code, 'forbidden');
  assert.match(result.body.errors[0].message, /不在本插件管理范围内/);
  assert.deepEqual(writes(), [], 'a forbidden policy must be refused before anything is written');
  assert.equal(updates.length, 0);
});

test('a leftover policy for a vanished preset can be cleared but not re-enabled', async () => {
  const ghost = storedRow({ preset: 'ghost', enabled: true });
  const clearing = harness({ policies: [ghost] });
  const cleared = await clearing.call('/api/preset-dispatch/agent-save', { settingsRevision: 7, maxDepth: 2, presetPolicies: [storedRow({ preset: 'ghost' })] });
  assert.equal(cleared.body.settingsSaved, true, 'reducing a leftover row to inert must be allowed');
  assert.deepEqual(cleared.body.errors, []);

  const enabling = harness({ policies: [storedRow({ preset: 'ghost' })] });
  const refused = await enabling.call('/api/preset-dispatch/agent-save', { settingsRevision: 7, maxDepth: 2, presetPolicies: [ghost] });
  assert.equal(refused.body.settingsSaved, false);
  assert.equal(refused.body.errors[0].code, 'forbidden');
  assert.deepEqual(enabling.writes(), []);
});

test('an unchanged legacy row never blocks an unrelated edit', async () => {
  // A row stored before this plugin refused external presets: still enabled, still
  // in the array, untouched by this request. It must survive a depth change.
  const legacy = storedRow({ preset: 'standard', enabled: true });
  const stale = storedRow({ preset: 'planner', enabled: true, defaultModel: FLASH, allowedModels: [FLASH], modelScope: 'selected', defaultEffort: 'xhigh' });
  const { call } = harness({ policies: [legacy, stale] });
  const result = await call('/api/preset-dispatch/agent-save', { settingsRevision: 7, maxDepth: 4, presetPolicies: [legacy, stale] });
  assert.equal(result.body.settingsSaved, true, 'unchanged rows are pass-through, not re-validated');
  assert.deepEqual(result.body.errors, []);
});

test('a definition that cannot be written is refused before the pool is touched', async () => {
  const { call, writes } = harness({ planFails: true });
  const result = await call('/api/preset-dispatch/agent-save', {
    settingsRevision: 7,
    hostPool: { enabled: true, allowedModels: [FLASH, SOL], revision: 3 },
    definition: { action: 'update', id: 'planner', definition: { id: 'planner', name: 'P' }, revision: 'def-1' },
  });
  assert.equal(result.body.definitionSaved, false);
  assert.equal(result.body.hostPoolSaved, false);
  assert.equal(result.body.errors[0].part, 'definition');
  assert.equal(result.body.errors[0].code, 'conflict');
  assert.deepEqual(writes(), [], 'a pre-detectable conflict must not write the authorization first');
});

test('a definition and policy naming different presets are refused', async () => {
  const { call, writes } = harness();
  const result = await call('/api/preset-dispatch/agent-save', {
    settingsRevision: 7,
    definition: { action: 'update', id: 'planner', definition: { id: 'planner', name: 'P' }, revision: 'def-1' },
    policy: policy({ preset: 'implementer' }),
  });
  assert.equal(result.body.definitionSaved, false);
  assert.equal(result.body.policySaved, false);
  assert.match(result.body.errors[0].message, /目标不一致/);
  assert.deepEqual(writes(), []);
});

test('every part that needs one demands a revision before writing', async () => {
  const missing = harness();
  const noSettings = await missing.call('/api/preset-dispatch/agent-save', { policy: policy() });
  assert.equal(noSettings.body.policySaved, false);
  assert.equal(noSettings.body.errors[0].code, 'validation');
  assert.deepEqual(missing.writes(), []);

  const poolOnly = harness();
  const noPool = await poolOnly.call('/api/preset-dispatch/agent-save', { hostPool: { enabled: true, allowedModels: [SOL] } });
  assert.equal(noPool.body.hostPoolSaved, false);
  assert.match(noPool.body.errors[0].message, /缺少修订号/);
  assert.deepEqual(poolOnly.writes(), [], 'the pool revision is required, never implied');
});

test('the same operation id replays its outcome instead of writing twice', async () => {
  const { call, writes } = harness();
  const body = { operationId: 'op-1', settingsRevision: 7, policy: policy() };
  const first = await call('/api/preset-dispatch/agent-save', body);
  assert.equal(first.body.policySaved, true);
  assert.equal(first.body.replayed, false);
  const again = await call('/api/preset-dispatch/agent-save', body);
  assert.equal(again.body.replayed, true, 'the duplicate delivery must not run the writes again');
  assert.equal(again.body.policySaved, true);
  assert.deepEqual(writes(), [PLUGIN_NS], 'exactly one write attempt for one logical save');

  // A protocol-level refusal (this id already belongs to another request) is a 400
  // with `error`, exactly like the gate and an unparseable body — not a part report.
  const conflicting = await call('/api/preset-dispatch/agent-save', { ...body, maxDepth: 5 });
  assert.equal(conflicting.status, 400);
  assert.match(conflicting.body.error, /operationId/);
  assert.deepEqual(writes(), [PLUGIN_NS], 'a refused duplicate must not write anything');

  // A part-level refusal keeps the unified 200 shape and is typed.
  const stale = await call('/api/preset-dispatch/agent-save', { operationId: 'op-3', settingsRevision: 6, policy: policy() });
  assert.equal(stale.status, 200);
  assert.equal(stale.body.errors[0].code, 'conflict');
  assert.equal(stale.body.replayed, false);
});

test('the recorded outcome can be queried while a save is unconfirmed', async () => {
  const { call } = harness();
  const unknown = await call('/api/preset-dispatch/operation', { operationId: 'never-seen' });
  assert.equal(unknown.status, 200);
  assert.equal(unknown.body.operation, null);

  const body = { operationId: 'op-2', settingsRevision: 7, policy: policy() };
  await call('/api/preset-dispatch/agent-save', body);
  const found = await call('/api/preset-dispatch/operation', { operationId: 'op-2' });
  assert.equal(found.body.operation.policySaved, true);
});

test('the retired write routes are no longer registered', () => {
  const { captured } = harness();
  assert.equal(captured.has('/api/preset-dispatch/save'), false, 'the whole-policy write route must be gone');
  assert.equal(captured.has('/api/preset-dispatch/presets/save'), false, 'the definition-only write route must be gone');
  assert.equal(captured.has('/api/preset-dispatch/agent-save'), true);
  assert.equal(captured.has('/api/preset-dispatch/state'), true);
});

test('a cached catalog is used for metadata but can never grant authorization', async () => {
  // The cache claims a rich catalog, including a model the Host pool does not allow.
  let reads = 0;
  const cached = {
    read: async () => { reads += 1; return { groups: [{ provider: 'codex-chatgpt', models: [{ provider: 'codex-chatgpt', model: SOL.model, efforts: [{ id: 'high' }] }] }], failures: [] }; },
    status: () => ({ cached: true, stale: false }), refresh: async () => cached.read(),
  };
  const { call } = harness({ catalogCache: cached });
  const allowed = await call('/api/preset-dispatch/agent-save', { settingsRevision: 7, policy: policy() });
  assert.equal(allowed.body.policySaved, true);
  assert.ok(reads >= 1, 'the catalog must be read through the injected cache');

  const refused = await call('/api/preset-dispatch/agent-save', {
    settingsRevision: 8,
    policy: policy({ allowedModels: [SOL], defaultModel: SOL, defaultEffort: 'high' }),
  });
  assert.equal(refused.body.policySaved, false, 'a catalog entry is metadata, not an authorization');
  assert.match(refused.body.errors[0].message, /尚未在 DSH 子代理授权中启用/);
});

test('a save reports which parts it was asked for and which landed', async () => {
  const { call } = harness();
  const result = await call('/api/preset-dispatch/agent-save', { settingsRevision: 7, operationId: 'op-parts', policy: policy() });
  assert.deepEqual(result.body.requested, { hostPoolSaved: false, definitionSaved: false, policySaved: true, settingsSaved: false });
  assert.deepEqual(result.body.completed, ['policySaved']);
  assert.deepEqual(result.body.pending, [], 'nothing is pending after a complete save');
  assert.equal(typeof result.body.finishedAt, 'string');
});

test('a partial save lists exactly the parts that still need writing', async () => {
  const { call } = harness({ definitionsFail: true });
  const result = await call('/api/preset-dispatch/agent-save', {
    settingsRevision: 7,
    definition: { action: 'update', id: 'planner', definition: { id: 'planner', name: 'P' }, revision: 'def-1' },
    policy: policy(),
  });
  assert.deepEqual(result.body.completed, [], 'nothing landed, so nothing may be reported as completed');
  assert.deepEqual(result.body.pending, ['definitionSaved', 'policySaved'], 'a retry must know what is left');
});
