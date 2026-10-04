import { validatePolicies, normalizePolicies, assertPolicyContext } from './policy.js?stable';
import { buildCatalog, catalogIndex } from './catalog.js?stable';
import { SaveError, fail, errorCode, assertPolicyWritable, changedPolicies, prospectivePool, requireInteger, fingerprint, createOperationLog } from './save-protocol.js?stable';

const base = '/api/preset-dispatch';
// The native subagent model-authorization entry. Writing it here uses the same
// service the native settings page uses, so both surfaces see one source.
export const POOL_NAMESPACE = 'subagent-model-selection-settings';

export function gate(req, method, connection) {
  if (!connection || connection.requestRejection(req) !== undefined) throw new Error('Authenticated operator request required');
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket?.remoteAddress)) throw new Error('Loopback access required');
  if (req.method !== method) throw new Error('Method not allowed');
  const hostname = new URL(`http://${req.headers.host}`).hostname;
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(hostname)) throw new Error('Invalid Host');
  if (method === 'POST') {
    if (req.headers['content-type']?.split(';')[0] !== 'application/json') throw new Error('JSON required');
    const origin = req.headers.origin;
    if (!origin || new URL(origin).host !== req.headers.host || !['http:', 'https:'].includes(new URL(origin).protocol)) throw new Error('Same-origin request required');
  }
}

const routeOf = value => ({ provider: String(value?.provider ?? '').trim(), model: String(value?.model ?? '').trim() });

/** Current Host subagent model authorization, or an explicit non-writable state. */
export function poolState(ctx) {
  const descriptor = ctx.settings.describe({ redactSecrets: true }).find(row => row.ns === POOL_NAMESPACE);
  if (!descriptor) return { enabled: false, allowedModels: [], revision: null, writable: false, reason: 'DSH 子代理模型选择设置未在此 profile 中启用' };
  const value = descriptor.value ?? {};
  return {
    enabled: value.enabled === true,
    allowedModels: Array.isArray(value.allowedModels) ? value.allowedModels.map(routeOf) : [],
    revision: descriptor.revision,
    writable: true,
  };
}

const mergePolicyRow = (rows, input) => {
  const row = {
    preset: input.preset, enabled: input.enabled === true,
    defaultModel: input.defaultModel ?? null, allowedModels: input.allowedModels ?? [],
    modelScope: input.modelScope ?? ((input.allowedModels ?? []).length ? 'selected' : 'host'),
    lockModel: input.lockModel === true, defaultEffort: input.defaultEffort || null,
    allowedEfforts: input.allowedEfforts ?? [],
  };
  const index = rows.findIndex(existing => existing.preset === input.preset);
  return index < 0 ? [...rows, row] : rows.map((existing, at) => (at === index ? row : existing));
};

export function registerSettingsApi(ctx, config, management, catalogCache = null) {
  // Same operation id + same payload replays the recorded outcome; see save-protocol.js.
  const operations = createOperationLog();
  // The cache is optional so the module stays usable (and testable) without one. It only
  // ever holds display data; authorization is read live from the pool on every check.
  const readCatalog = () => (catalogCache ? catalogCache.read() : buildCatalog(ctx.llm));
  const own = () => {
    const row = ctx.settings.describe({ redactSecrets: true }).find(entry => entry.ns === 'local-preset-dispatch');
    if (!row) throw new Error('Plugin Settings entry unavailable');
    return row;
  };
  const state = async () => {
    const [definitions, catalog, roster] = await Promise.all([management.state(), readCatalog(), ctx.agentPresets.remoteExportList()]);
    const entry = own();
    return {
      definitionRevision: definitions.revision, settingsRevision: entry.revision,
      definitions: definitions.definitions, templates: definitions.templates, external: definitions.external,
      presets: roster.presets, catalog, hostPool: poolState(ctx),
      // Reported so the page can mark a stale catalog instead of presenting old data as current.
      catalogStatus: catalogCache ? catalogCache.status() : null,
      config: {
        maxDepth: entry.value.maxDepth ?? config.maxDepth.get(),
        // Normalized so the editor shows the effective scope, not a missing field.
        presetPolicies: normalizePolicies(entry.value.presetPolicies ?? []),
        allowedPresets: config.allowedPresets, allowModelSelection: config.allowModelSelection,
      },
    };
  };
  const requireDepth = value => {
    if (!Number.isSafeInteger(value) || value < 0 || value > 20) throw new Error('Depth must be between 0 and 20');
    return value;
  };
  const readBody = async req => {
    let text = '';
    for await (const chunk of req) { text += chunk; if (Buffer.byteLength(text) > 65536) throw new Error('Request too large'); }
    return JSON.parse(text);
  };
  const send = (res, code, data) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(data)); };
  const handler = (method, fn) => async (req, res) => { try { gate(req, method, ctx.connection); await fn(req, res); } catch (e) { send(res, 400, { error: String(e.message ?? e) }); } };

  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: `${base}/state`, handler: handler('GET', async (_req, res) => send(res, 200, await state())) }), 'agent management state');

  // Manual refresh for the catalog, so an operator never has to restart the plugin to see
  // a provider that just came back.
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: `${base}/catalog/refresh`, handler: handler('POST', async (_req, res) => {
    const catalog = catalogCache ? await catalogCache.refresh() : await buildCatalog(ctx.llm);
    send(res, 200, {
      refreshed: true,
      providers: catalog.groups.length,
      models: catalog.groups.reduce((total, group) => total + group.models.length, 0),
      failures: catalog.failures,
      status: catalogCache ? catalogCache.status() : null,
    });
  }) }), 'agent management catalog refresh');

  // Recovery support: after an unconfirmed save the UI can ask what the recorded
  // outcome for that operation was instead of guessing or blindly resending it.
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: `${base}/operation`, handler: handler('POST', async (req, res) => {
    const input = await readBody(req);
    send(res, 200, { operation: operations.get(input.operationId) });
  }) }), 'agent management operation');

  /**
   * Decide whether a request may run at all, before any part is written. Every
   * pre-detectable problem — ownership, identity mismatch, a model that is not
   * authorized, a stale revision, an unknown target — is refused here with zero
   * writes. The write boundary still re-checks concurrency, so this is not a
   * substitute for the revision fences.
   */
  const planRequest = async input => {
    const entry = own();
    const [catalog, roster] = await Promise.all([readCatalog(), ctx.agentPresets.remoteExportList()]);
    const capabilities = catalogIndex(catalog);
    // A pool we cannot read is an outcome we cannot confirm, not a validation failure:
    // report it against the pool with an 'unknown' code and write nothing.
    let pool;
    try { pool = poolState(ctx); } catch (error) { fail('unknown', String(error?.message ?? error), 'hostPool'); }
    const rosterIds = new Set(roster.presets.map(preset => preset.id));
    let owned = null;
    const ownedIds = () => {
      if (owned) return owned;
      if (typeof management.owned !== 'function') fail('unknown', '无法确认预设归属；请重新读取后再保存');
      try { owned = new Set(management.owned().map(definition => definition.id)); }
      catch (error) { fail('unknown', '无法确认预设归属：' + String(error?.message ?? error)); }
      return owned;
    };
    const plan = { entry, pool: null, definition: null, policyBefore: null, policyAfter: null, global: null, poolSnapshot: null };

    if (input.hostPool) {
      if (!pool.writable) fail('validation', pool.reason || 'DSH 子代理模型选择设置不可写', 'hostPool');
      if (!Number.isSafeInteger(input.hostPool.revision)) fail('validation', '模型授权缺少修订号；请重新读取后再保存', 'hostPool');
      if (input.hostPool.revision !== pool.revision) fail('conflict', '子代理模型授权已在其他页面更新，请重新读取后再保存', 'hostPool');
      const routes = (input.hostPool.allowedModels ?? []).map(routeOf);
      if (routes.some(route => !route.provider || !route.model)) fail('validation', '模型授权需要 provider 与 model', 'hostPool');
      if (input.hostPool.enabled === true && !routes.length) fail('validation', '启用模型授权时至少需要勾选一个模型', 'hostPool');
      plan.pool = { enabled: input.hostPool.enabled === true, allowedModels: routes, revision: pool.revision };
    }
    // Validate against the pool this request is about to write, so a policy that
    // widens authority is checked against the authorization it relies on.
    const target = prospectivePool(pool, plan.pool);
    // Remembered so the write boundary can prove the authorization did not move while
    // this request was being planned: prevalidation alone cannot see that.
    plan.poolSnapshot = { enabled: target.enabled === true, allowedModels: (target.allowedModels ?? []).map(routeOf) };

    // The definition and the policy must name the same preset: a request that
    // creates or renames one preset while configuring another is refused.
    if (input.definition && input.policy) {
      const definitionId = (input.definition.action === 'delete' ? input.definition.id : input.definition.definition?.id) ?? input.definition.id;
      if (definitionId !== input.policy.preset) fail('validation', '预设定义与派遣策略的目标不一致；请重新读取后再保存', 'policy');
    }

    if (input.definition) {
      if (typeof management.plan !== 'function') fail('unknown', '无法预校验预设定义', 'definition');
      try { await management.plan(input.definition); }
      catch (error) {
        if (error instanceof SaveError) throw error;
        const message = String(error?.message ?? error);
        fail(/changed since|reload|revision/i.test(message) ? 'conflict' : 'validation', message, 'definition');
      }
      plan.definition = input.definition;
    }

    // A preset this request is about to create is owned BY this request: its definition
    // and its policy are written together, so its own policy may grant authority. A row
    // for a preset that already exists and is not owned here stays limited to inert rows.
    const creating = input.definition && ['create', 'copy'].includes(input.definition.action);
    const definitionTarget = input.definition ? ((input.definition.action === 'delete' ? input.definition.id : input.definition.definition?.id) ?? input.definition.id) : null;
    if (creating) ownedIds().add(definitionTarget);

    // Deleting a preset must deny dispatch BEFORE the definition disappears, and that
    // policy is derived here rather than accepted from the caller so no client can
    // forget it. Removing the row is the normal case; when the static allow-list would
    // still permit the id, an explicitly disabled row is kept instead. Stored rows are
    // normalized rather than re-validated, so one malformed legacy row cannot block it.
    const deleting = input.definition?.action === 'delete';
    if (deleting && input.policy) fail('validation', '删除预设时不能同时提交派遣策略；策略由服务端派生', 'policy');
    if (deleting) {
      requireInteger(input.settingsRevision, '派遣策略', 'policy');
      if (input.settingsRevision !== entry.revision) fail('conflict', '派遣策略已在其他页面更新；请重新读取后再保存', 'policy');
      const kept = normalizePolicies(entry.value.presetPolicies ?? []).filter(row => row.preset !== input.definition.id);
      plan.policyBefore = (config.allowedPresets ?? []).includes(input.definition.id)
        ? [...kept, ...validatePolicies([{ preset: input.definition.id }])]
        : kept;
    }

    // Creating or copying must neutralize any leftover row for the reused id BEFORE the
    // definition exists. Otherwise a failing policy write would leave the freshly created
    // preset bound to the old authorization. The requested policy is written afterwards,
    // so an enabled row never outlives a preset that failed to be created.
    if (creating) {
      requireInteger(input.settingsRevision, '派遣策略', 'policy');
      if (input.settingsRevision !== entry.revision) fail('conflict', '派遣策略已在其他页面更新；请重新读取后再保存', 'policy');
      if (!input.policy) fail('validation', '新建或复制预设时必须同时初始化派遣策略', 'policy');
      const kept = normalizePolicies(entry.value.presetPolicies ?? []).filter(row => row.preset !== definitionTarget);
      plan.policyBefore = [...kept, ...validatePolicies([{ preset: definitionTarget }])];
    }

    if (input.policy) {
      requireInteger(input.settingsRevision, '派遣策略', 'policy');
      if (input.settingsRevision !== entry.revision) fail('conflict', '派遣策略已在其他页面更新；请重新读取后再保存', 'policy');
      try {
        const rows = validatePolicies(mergePolicyRow(entry.value.presetPolicies ?? [], input.policy));
        const row = rows.find(candidate => candidate.preset === input.policy.preset);
        if (!row) fail('validation', '派遣策略缺少预设 ID', 'policy');
        assertPolicyWritable(row, { ownedIds: ownedIds(), rosterIds });
        assertPolicyContext([row], { hostPool: target, capabilities });
        // A create writes this after the definition; an update has nothing to precede it.
        plan.policyAfter = rows;
      } catch (error) {
        if (error instanceof SaveError) throw error;
        fail('validation', String(error?.message ?? error), 'policy');
      }
    }

    if (input.maxDepth !== undefined || input.presetPolicies) {
      requireInteger(input.settingsRevision, '全局设置', 'settings');
      if (input.settingsRevision !== entry.revision) fail('conflict', '全局设置已在其他页面更新；请重新读取后再保存', 'settings');
      try {
        const previous = normalizePolicies(entry.value.presetPolicies ?? []);
        const rows = validatePolicies(input.presetPolicies ?? entry.value.presetPolicies ?? []);
        // Only changed rows are re-validated: a stored row that merely lost its
        // authorization stays readable and must not block an unrelated edit.
        const changed = changedPolicies(previous, rows);
        for (const row of changed) assertPolicyWritable(row, { ownedIds: ownedIds(), rosterIds });
        assertPolicyContext(changed, { hostPool: target, capabilities });
        // A removed row is not a "changed" row, but removal can still widen authority:
        // dispatch falls back to the static allow-list when no row exists, so an id that
        // list permits would become dispatchable again just by deleting its disabled row.
        const restored = previous.filter(row => !rows.some(next => next.preset === row.preset) && (config.allowedPresets ?? []).includes(row.preset));
        if (restored.length) fail('forbidden', `移除 ${restored.map(row => row.preset).join('、')} 的策略行会让它回退到静态允许列表并重新可派遣；请改为停用该行`, 'settings');
        plan.global = { maxDepth: requireDepth(input.maxDepth ?? entry.value.maxDepth ?? config.maxDepth.get()), rows, changed: changed.length };
      } catch (error) {
        if (error instanceof SaveError) throw error;
        fail('validation', String(error?.message ?? error), 'settings');
      }
    }
    return plan;
  };

  // The single write path for one Agent or for global settings.
  //
  // Parts are ordered — pool, definition, policy, global settings — but the Host
  // stores them separately, so this is coordinated, not atomic: every part is
  // planned first, then written, then reported separately.
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: `${base}/agent-save`, handler: handler('POST', async (req, res) => {
    const input = await readBody(req);
    const print = fingerprint(input);
    // Reported so a retry can resume instead of starting over: which parts this request
    // asked for, which landed, and which still need to be written.
    const names = ['hostPoolSaved', 'definitionSaved', 'policySaved', 'settingsSaved'];
    const requestedOf = {
      hostPoolSaved: Boolean(input.hostPool),
      definitionSaved: Boolean(input.definition),
      // A delete always carries a policy part: the server derives it.
      policySaved: Boolean(input.policy) || input.definition?.action === 'delete',
      settingsSaved: input.maxDepth !== undefined || Boolean(input.presetPolicies),
    };
    // The duplicate-delivery check shares the lock with the writes, so two concurrent
    // deliveries of one operation cannot both be treated as new work.
    const { outcome, replayed } = await management.coordinate(async () => {
      const parts = { hostPoolSaved: false, definitionSaved: false, policySaved: false, settingsSaved: false, errors: [] };
      const stop = (part, error) => { parts.errors.push({ part, code: errorCode(error), message: String(error?.message ?? error) }); };
      // Every exit path reports the same contract, including which parts are still owed.
      const finish = () => ({
        ...parts,
        requested: requestedOf,
        completed: names.filter(name => parts[name]),
        pending: names.filter(name => requestedOf[name] && !parts[name]),
        finishedAt: new Date().toISOString(),
        state: null, stateError: null,
      });
      const stopWith = (part, error) => { stop(part, error); return { outcome: finish(), replayed: false }; };
      const failPart = () => ({ outcome: finish(), replayed: false });
      // The recorded outcome belongs inside the lock too, so a concurrent delivery cannot
      // read or overwrite it while this request is still running.
      const settle = () => { const outcome = finish(); operations.record(input.operationId, print, outcome); return { outcome, replayed: false }; };
      const stored = operations.replay(input.operationId, print);
      if (stored) return { outcome: stored, replayed: true };
      let plan;
      try { plan = await planRequest(input); }
      catch (error) { return stopWith(error?.part ?? 'unknown', error); }
      // The boundary check prevalidation cannot provide: the authorization may have
      // changed while this request was being planned. Only authority-granting writes
      // need it — writing rows that deny dispatch does not depend on the pool.
      const assertPoolUnchanged = () => {
        const now = poolState(ctx);
        if (now.enabled !== plan.poolSnapshot.enabled || JSON.stringify(now.allowedModels) !== JSON.stringify(plan.poolSnapshot.allowedModels)) {
          fail('conflict', '模型授权在保存期间发生变化；请重新读取后再保存', 'policy');
        }
      };
      if (plan.pool) {
        try { await ctx.settings.update(POOL_NAMESPACE, { enabled: plan.pool.enabled, allowedModels: plan.pool.allowedModels }, plan.pool.revision); parts.hostPoolSaved = true; }
        catch (error) { return stopWith('hostPool', error); }
      }
      // The write order is the safety property, not a detail: rows that must deny
      // dispatch are written before the definition changes, and an authorization is
      // written after the definition it belongs to, so it can never outlive a failed
      // create. Each settings write re-reads the entry, because an earlier write in this
      // same request has already moved its revision.
      // Every settings write is fenced on the revision this request expects. The read
      // after our own write advances it, so a two-write request works; a change made by
      // anyone else in between is then refused by the Host CAS instead of silently
      // overwritten — which reading the current revision at write time would defeat.
      let expected = plan.entry.revision;
      const writePolicies = async rows => {
        try {
          if (own().revision !== expected) fail('conflict', '派遣策略已在保存期间被其他编辑更新；请重新读取后再保存', 'policy');
          await ctx.settings.update(own().ns, { presetPolicies: rows }, expected);
          expected = own().revision;
          return true;
        } catch (error) { stop('policy', error); return false; }
      };
      if (plan.policyBefore) {
        if (!(await writePolicies(plan.policyBefore))) return failPart();
        // A derived policy write IS the policy part for a delete; a create's neutralising
        // write is only the precondition for the policy written after the definition.
        if (!plan.policyAfter) parts.policySaved = true;
      }
      if (plan.definition) {
        try { await management.mutateUncoordinated(plan.definition); parts.definitionSaved = true; }
        catch (error) { return stopWith('definition', error); }
      }
      if (plan.policyAfter) {
        try { assertPoolUnchanged(); } catch (error) { return stopWith('policy', error); }
        if (!(await writePolicies(plan.policyAfter))) return failPart();
        parts.policySaved = true;
      }
      if (plan.global) {
        try {
          assertPoolUnchanged();
          if (own().revision !== expected) fail('conflict', '全局设置已在保存期间被其他编辑更新；请重新读取后再保存', 'settings');
          await ctx.settings.update(own().ns, { maxDepth: plan.global.maxDepth, presetPolicies: plan.global.rows }, expected);
          parts.settingsSaved = true;
        } catch (error) { return stopWith('settings', error); }
      }
      return settle();
    });
    const recorded = outcome;
    // A failed refresh must not erase the per-part outcome: the writes already happened.
    let snapshot = null, stateError = null;
    try { snapshot = await state(); } catch (error) { stateError = String(error?.message ?? error); }
    send(res, 200, { ...recorded, replayed, state: snapshot, stateError });
  }) }), 'agent management agent-save');
  return { state };
}
