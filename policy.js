export function validatePolicies(rows = []) {
  if (!Array.isArray(rows) || rows.length > 200) throw new Error('Invalid preset policies');
  const seen = new Set();
  return rows.map(row => {
    if (!row || typeof row.preset !== 'string' || !row.preset.trim() || seen.has(row.preset)) throw new Error('Invalid or duplicate preset id');
    seen.add(row.preset);
    const route = value => {
      if (!value || typeof value.provider !== 'string' || !value.provider.trim() || typeof value.model !== 'string' || !value.model.trim()) throw new Error('Model route requires provider and model');
      return { provider: value.provider.trim(), model: value.model.trim() };
    };
    const allowedModels = (row.allowedModels ?? []).map(route);
    const modelScope = row.modelScope ?? (allowedModels.length ? 'selected' : 'host');
    if (!['host','selected'].includes(modelScope)) throw new Error('Invalid model scope');
    if (modelScope==='selected'&&!allowedModels.length) throw new Error('Select at least one allowed model');
    const defaultModel = row.defaultModel == null ? null : route(row.defaultModel);
    if (defaultModel && allowedModels.length && !allowedModels.some(r => r.provider === defaultModel.provider && r.model === defaultModel.model)) throw new Error('Default model is outside preset allowed models');
    if (row.lockModel && !defaultModel) throw new Error('Lock model requires a default model');
    const efforts = row.allowedEfforts ?? [];
    if (!Array.isArray(efforts) || efforts.some(e => typeof e !== 'string' || !e.trim())) throw new Error('Invalid efforts');
    const defaultEffort = row.defaultEffort || null;
    if (defaultEffort && efforts.length && !efforts.includes(defaultEffort)) throw new Error('Default effort is outside allowed efforts');
    return { preset: row.preset, enabled: row.enabled === true, defaultModel, allowedModels, modelScope, lockModel: row.lockModel === true, defaultEffort, allowedEfforts: [...new Set(efforts)] };
  });
}
export function applyPresetPolicy(policy, requested) {
  const next = { ...requested };
  if (!policy) return next;
  if (policy.lockModel && requested.provider !== undefined && (requested.provider !== policy.defaultModel.provider || requested.model !== policy.defaultModel.model)) throw new Error('Preset model is locked by the user');
  if (requested.provider === undefined && policy.defaultModel) Object.assign(next, policy.defaultModel);
  if (next.reasoningEffort === undefined && policy.defaultEffort) next.reasoningEffort = policy.defaultEffort;
  return next;
}
export function assertPresetRoute(policy, options) {
  if (!policy) return;
  if (policy.modelScope !== 'host' && policy.allowedModels.length && !policy.allowedModels.some(r => r.provider === options.provider && r.model === options.model)) throw new Error('Effective model is outside preset allowed models');
  if (policy.allowedEfforts.length && !policy.allowedEfforts.includes(options.reasoningEffort)) throw new Error('Effective effort is outside preset allowed efforts');
}

// Read-only normalization for display. Rows stored before a field existed (for example
// modelScope) must be shown with the same effective value dispatch would use, otherwise
// the editor would display — and then save — a different scope than the one in effect.
export function normalizePolicies(rows = []) {
  if (!Array.isArray(rows)) return [];
  return rows.filter(row => row && typeof row.preset === 'string').map(row => ({
    preset: row.preset,
    enabled: row.enabled === true,
    defaultModel: row.defaultModel ?? null,
    allowedModels: Array.isArray(row.allowedModels) ? row.allowedModels.map(route => ({ provider: route.provider, model: route.model })) : [],
    modelScope: row.modelScope ?? ((row.allowedModels ?? []).length ? 'selected' : 'host'),
    lockModel: row.lockModel === true,
    defaultEffort: row.defaultEffort ?? null,
    allowedEfforts: Array.isArray(row.allowedEfforts) ? [...row.allowedEfforts] : [],
  }));
}

// Contextual checks that need the Host authorization pool and live capabilities.
// Kept out of validatePolicies so loading an existing config can never fail here:
// a preset saved while a model was authorized stays readable if that model is
// later withdrawn — the withdrawal surfaces as a dispatch-time refusal instead.
const routeKey = route => `${route.provider}\u0000${route.model}`;

export function assertPolicyContext(rows, { hostPool, capabilities } = {}) {
  const poolEnabled = hostPool?.enabled === true;
  const pool = poolEnabled ? (hostPool.allowedModels ?? []).map(routeKey) : null;
  for (const row of rows) {
    const allowed = row.allowedModels.map(routeKey);
    if (row.modelScope === 'selected' && pool) {
      const outside = row.allowedModels.find(route => !pool.includes(routeKey(route)));
      if (outside) throw new Error(`模型 ${outside.provider} / ${outside.model} 尚未在 DSH 子代理授权中启用`);
    }
    // The default must sit inside whatever set this preset can actually use.
    const usable = row.modelScope === 'selected' ? allowed : pool;
    if (row.defaultModel && usable && !usable.includes(routeKey(row.defaultModel))) {
      throw new Error('默认模型必须在该预设当前可用的模型范围内');
    }
    // Effort ids are model-specific; reject ones this model does not advertise.
    const supported = row.defaultModel && capabilities ? capabilities.get(routeKey(row.defaultModel)) : undefined;
    if (supported) {
      const unknown = row.allowedEfforts.find(effort => !supported.includes(effort));
      if (unknown) throw new Error(`模型 ${row.defaultModel.provider} / ${row.defaultModel.model} 不支持思考强度 ${unknown}`);
      if (row.defaultEffort && !supported.includes(row.defaultEffort)) throw new Error(`模型 ${row.defaultModel.provider} / ${row.defaultModel.model} 不支持思考强度 ${row.defaultEffort}`);
    }
  }
}
