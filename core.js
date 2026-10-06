import { applyPresetPolicy, assertPresetRoute } from './policy.js?stable';
import { ROLES, roleTools, roleDenial } from './roles.js?stable';
import { templateRole } from './managed-presets.js?stable';
import { buildCatalog } from './catalog.js?stable';
import { observationFromPlan, observationWithEvents, observationFinished, observationCreated, planRouting, routingView } from './dispatch-observation.js?stable';

/**
 * Presentation payload persisted with one `preset_dispatch` result.
 *
 * It is built from the value the tool actually returned, so it can never claim a
 * different run than the one the caller sees, and it always distinguishes the
 * planned route from the observed one. A background answer carries a job id but
 * no child session id yet — the payload then says so instead of presenting the
 * job as a running child.
 *
 * The envelope is also the run's durable correlation record: `marker`,
 * `formatVersion`, `runId`, `childSessionId`, `parentSessionId`, `callId`,
 * `catalogId`, `observationState` and `observedRouting` are the fields a later
 * reader (the query-compaction eligibility check) compares literally instead of
 * inferring a relationship from a label or a job id.
 */
export function presentationMetaFor(value) {
  if (!value || typeof value !== 'object') return null;
  const background = value.kind === 'background';
  const child = typeof value.childSessionId === 'string' && value.childSessionId !== '' ? value.childSessionId : null;
  const observation = value.observation ?? null;
  const observationState = typeof value.observationState === 'string' && value.observationState !== ''
    ? value.observationState
    : (typeof observation?.state === 'string' && observation.state !== '' ? observation.state : 'pending');
  // `started` is only ever claimed from a real creation: the reserved id exists before the child
  // does, so the observation state — not the id — is what proves the child was created.
  const started = child !== null && (observationState === 'created' || observationState === 'observed' || observationState === 'finished');
  const observedRouting = value.routingView?.observed && typeof value.routingView.observed === 'object'
    ? value.routingView.observed
    : (observation?.observed && typeof observation.observed === 'object' ? observation.observed : null);
  return {
    marker: 'preset-dispatch/run',
    formatVersion: 1,
    runId: value.runId ?? value.run?.id ?? null,
    childSessionId: child,
    parentSessionId: value.parentSessionId ?? value.parentSession ?? null,
    callId: value.callId ?? null,
    catalogId: value.catalogId ?? null,
    observationState,
    observedRouting,
    status: value.status ?? value.stopReason ?? observation?.state ?? (background ? 'running' : null),
    kind: background ? 'background' : 'foreground',
    preset: value.preset ?? null,
    presetName: value.presetName ?? null,
    presetVersion: value.presetVersion ?? null,
    run: { id: value.runId ?? value.run?.id ?? null, status: value.stopReason ?? (background ? 'running' : null) },
    call: { id: value.callId ?? null, rootCallId: value.rootCallId ?? null },
    child: { sessionId: child, started, jobId: background ? value.jobId ?? null : null },
    plan: value.routing ? planRouting(value.routing) : null,
    observation,
  };
}

// Runtime-neutral implementation; DSH dependencies are supplied by host.js.
export function createDispatcher(ctx, config, api) {
  const providerName = 'local-preset-dispatch';
  const tickets = new WeakMap();
  // Live tickets by reserved child session id, so the Host half can read the
  // observation of one dispatch without holding the ticket itself. Entries are
  // removed when the dispatch settles; nothing here is authoritative.
  const ticketByChild = new Map();
  const active = new Set();
  const lifetime = new AbortController();
  let closing = false;
  const presetPolicy = id => (config.presetPolicies ?? []).find(row => row.preset === id);
  const allowed = id => presetPolicy(id)?.enabled ?? config.allowedPresets.includes(id);
  const fail = message => { throw new Error(`preset-dispatch: ${message}`); };
  const nonempty = (value, key) => {
    if (typeof value !== 'string' || !value.trim()) fail(`${key} must be a non-empty string`);
    return value.trim();
  };
  const output = {
    schema: { type: 'object', additionalProperties: true },
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    // Persisted with the result so the card can render the run without reading
    // model content back. The model-facing text above stays the only model input.
    presentationMeta: (_args, value) => presentationMetaFor(value),
  };

  function drive(handle, signal) {
    const child = handle.agent;
    let cancelled = false;
    let disposal;
    const abort = () => { cancelled = true; child.cancel({ kind: 'parent' }); };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    const run = {
      id: child.id,
      localAgent: child,
      result: null,
      dispose() {
        return disposal ??= (async () => {
          signal.removeEventListener('abort', abort);
          const outcomes = await Promise.allSettled([handle.dispose(), run.result]);
          if (outcomes[0].status === 'rejected') throw outcomes[0].reason;
        })().finally(() => active.delete(run));
      },
    };
    active.add(run);
    run.begin = prompt => {
      run.result = (async () => {
        try {
          if (!cancelled) {
            child.followup(api.createUserMessage({ content: prompt, source: { kind: 'user' } }));
            await child.whenIdle();
          }
          const events = child.session.snapshotEvents(api.SessionLogOffset(0));
          const end = api.foldConsumedWork(events).end?.data.reason;
          const kind = end?.kind;
          const stopReason = kind === 'completed' ? 'completed' : cancelled || kind === 'aborted' ? 'aborted' : kind === 'max-tokens' ? 'max-tokens' : kind === 'blocked' ? 'refusal' : 'error';
          return { output: api.finalAssistantOutput(events) ?? [], stopReason };
        } finally { signal.removeEventListener('abort', abort); }
      })();
      // Prevent an unhandled rejection while start() establishes the child catalog.
      run.result.catch(() => {});
      return run;
    };
    return run;
  }

  // Re-check, at the moment the child is about to be created, everything the admission
  // step checked. Between the two, the user can disable the preset, narrow the preset
  // policy, revoke the model from the Host pool, turn the selection switches off, or
  // lower the depth limit. A refusal here happens before any resource exists, so it
  // leaks nothing; it refuses only this new dispatch and never touches a child that is
  // already running. The effective route is re-validated, never silently replaced.
  const assertStillAuthorized = (ticket, request) => {
    const id = ticket.preset;
    if (!allowed(id)) fail(`preset ${id} is no longer allowed to dispatch`);
    const policy = presetPolicy(id) ?? null;
    const effective = ticket.agentOptions;
    if (policy) {
      assertPresetRoute(policy, effective);
      if (policy.lockModel && policy.defaultModel
        && (policy.defaultModel.provider !== effective.provider || policy.defaultModel.model !== effective.model)) {
        fail('preset model is locked by a newer policy; retry after reviewing it');
      }
    }
    const selection = ctx.get('subagentModelSelection')?.current();
    const explicit = ticket.routing.modelSource === 'parent-explicit' || ticket.routing.effortSource === 'parent-explicit';
    const presetDefault = ticket.routing.modelSource === 'preset-default' || ticket.routing.effortSource === 'preset-default';
    if ((explicit || presetDefault) && (!config.allowModelSelection || !selection?.enabled)) {
      fail('explicit model/effort selection is no longer enabled in Host settings');
    }
    if (selection?.enabled === true && !(selection.allowedModels ?? []).some(route => route.provider === effective.provider && route.model === effective.model)) {
      fail(`effective child model ${effective.provider} / ${effective.model} is no longer authorized by Host settings`);
    }
    const hostDepth = ctx.subagents.resolveMaxDepth();
    const nowMax = Math.min(config.maxDepth, hostDepth ?? config.maxDepth);
    if (request.maxDepth > nowMax) fail('the delegation depth limit was lowered during dispatch; retry');
  };

  /**
   * Persist the current observation state onto the run's history record.
   *
   * Reporting only: a missing history port, a record that was never written, or a
   * medium that refuses the write must never change the dispatch outcome, so every
   * failure here is contained. The planned routing is never written into the
   * observed side — `observedRouting` stays null until a real request header says
   * otherwise.
   */
  const noteObservation = ticket => {
    const record = ticket?.record;
    if (!record || typeof api.history?.update !== 'function') return;
    try {
      const view = routingView(ticket.observation);
      api.history.update(record, {
        observationState: ticket.observation?.state ?? 'pending',
        observedRouting: view.observed,
      });
    } catch { /* the record stays readable without the latest observation */ }
  };

  /**
   * Fold committed events into the ticket's observation. Idempotent: replaying the
   * same events changes nothing, so the live `session/event` feed and a catch-up
   * read over the same log cannot disagree.
   */
  const observe = (ticket, events) => {
    if (!ticket) return false;
    const before = ticket.observation;
    const next = observationWithEvents(before, events);
    const changed = next.observedSeq !== before.observedSeq || next.requestHeaders !== before.requestHeaders || next.state !== before.state;
    ticket.observation = next;
    if (changed) noteObservation(ticket);
    return changed;
  };

  const finishObservation = (ticket, status, at) => {
    if (!ticket) return;
    ticket.observation = observationFinished(ticket.observation, status, { at, childSessionId: ticket.childSessionId });
    noteObservation(ticket);
  };

  const provider = {
    name: providerName,
    inheritsParentContext: false,
    capabilities: { agentOptions: true, depthLimit: true, outputSchema: false, toolFilter: false, persona: false },
    async start(request) {
      const ticket = tickets.get(request.signal);
      tickets.delete(request.signal);
      if (!ticket || closing) fail('missing dispatch authorization or plugin is closing');
      request.signal.throwIfAborted();
      const definition=api.getManagedDefinition?.(ticket.preset);
      if(ticket.definition&&JSON.stringify(definition)!==JSON.stringify(ticket.definition))fail('preset changed during dispatch; retry only after reviewing the new revision');
      assertStillAuthorized(ticket, request);
      const depth = api.resolveChildDepth(request.parent, request.maxDepth);
      const preset = await ctx.agentPresets.resolve(ticket.preset);
      if (preset.broken !== undefined) fail(`preset ${preset.id} is broken: ${preset.broken}`);
      request.signal.throwIfAborted();
      const handle = await ctx.agents.create({
        // The id reserved when the dispatch was admitted, so the history record, the
        // observation and this session all name the same child. Never a fresh id here:
        // a second one would make the recorded correlation point at nothing.
        sessionId: ticket.childSessionId,
        parentAgent: request.parent,
        meta: { ...ticket.meta, delegationDepth: depth, agentPreset: ticket.preset },
        agentOptions: ticket.agentOptions,
        signal: request.signal,
        setup: async (childCtx, child) => {
          api.appendDelegatedPolicyOverrides(child.session, ticket.policy);
          await ctx.agentPresets.mount(childCtx, ticket.preset);
          const role=ticket.definition ? templateRole(ticket.definition.template) : (ROLES[ticket.preset] ? ticket.preset : null);
          if (role) {
            const lease=await ctx.agentPresets.acquireScope(ticket.preset);
            try {
              for (const name of roleTools(role)) {
                const definition=ctx.tools.get(name,lease.key);
                if (definition) childCtx.tools.register(definition);
              }
            } finally {await lease[Symbol.asyncDispose]();}
            childCtx.tools.guard(execution=>roleDenial(role,execution));
          }
          // A trusted preset must not shadow the security services used by this deployment.
          for (const key of ['sandboxPolicy', 'approval', 'permissionPresets']) {
            const childService = childCtx.get(key);
            const hostService = ctx.get(key);
            if (!childService || !hostService || api.serviceIdentity(childService) !== api.serviceIdentity(hostService)) fail(`preset ${ticket.preset} replaces security service ${key}`);
          }
          childCtx.systemPrompt.context({
            name: 'subagent:delegation',
            order: childCtx.systemPrompt.getContextOrder('SUBAGENT_DELEGATION'),
            text: 'You are a delegated subagent. Your permission scope cannot be widened. Operations requiring approval are rejected; report limitations to your parent instead of retrying denied operations.',
          });
          let appended = false;
          childCtx.on('agent/pre-step', async ({ agent }, next) => {
            const decision = await next();
            if (!appended && decision.kind === 'enter') { agent.session.append('subagent/descriptor', request.descriptor); appended = true; }
            return decision;
          });
        },
      });
      // Creating the child is asynchronous, so the authorization can move while it is
      // being built. Re-check once more and release what was just created if it did:
      // refusing here must not leave an unauthorized child behind.
      try { assertStillAuthorized(ticket, request); }
      catch (error) { await handle.dispose().catch(() => {}); throw error; }
      // The child exists under the reserved id: that, and only that, is what turns the
      // reservation into a start. A cancellation between here and the drive still leaves
      // the record consistent, because the observation already says "created".
      if (ticket.childSessionId && handle.agent?.id === ticket.childSessionId) {
        ticket.observation = observationCreated(ticket.observation, { childSessionId: handle.agent.id, at: new Date().toISOString() });
        noteObservation(ticket);
        api.onChildCreated?.(ticket, handle);
      }
      return drive(handle, request.signal).begin(request.prompt);
    },
  };

  // preset_list answers with the compact catalog by default: only the presets that are both loaded
  // and dispatchable, the shared authorized model/effort pool once, and the dispatch rules that
  // used to sit in the resident prompt. Disabled or broken presets, unauthorized models and the
  // full catalog error list are diagnostic data, so they come back only for an explicit
  // `diagnostic: true` request — the mode the later query-compaction work must never rewrite.
  // Every successful answer carries a catalogId that only correlates later lifecycle records with
  // this query: it is not an authorization ticket, and dispatch re-checks authorization live.
  const listMarker = 'preset-dispatch/catalog';
  const listFormatVersion = 1;
  const dispatchRules = explicitAvailable => ({
    ownership: '主代理负责调度与最终验收；叶子不派遣。',
    taskBrief: ['工作目录', '范围/允许路径', '候选版本', '非目标', '已知证据', '剩余预算', '验收条件'],
    writers: '实现采用单写者；问题/只读任务不强行安排实现；测试与审查在候选冻结后进行。',
    verification: '测试验证区分 RED/GREEN/回归/最终门禁，复用有效证据。',
    prohibited: '禁止自动升级重试、改模型绕过失败或拒绝、请求权限升级绕过拒绝。',
    presetPolicy: '每行的 policy、pinnedModel、pinnedEffort 与 unavailableModels 决定该预设的限制：compact 结果中未列 usableModels 的行可用 models 中的全部路由，列出的行以 usableModels 为准；锁定预设拒绝覆盖。',
    modelChoice: explicitAvailable
      ? '从 models 列出的授权路由中按风险与模型实际能力选择；不知道可用档位时省略 reasoning_effort，不猜测 max/xhigh；模型与工具权限彼此独立。'
      : '当前不能显式指定模型或强度，只能继承父代理模型。',
  });

  const listTool = {
    name: 'preset_list',
    description: 'List the presets you may dispatch, their per-preset restrictions, and the shared authorized model/effort pool (models). A preset with no pinned model inherits the parent route. Call this before preset_dispatch. diagnostic: true returns the full catalog: disabled or broken presets, unauthorized models and catalog failures. catalogId correlates later records only; it is not an authorization ticket.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        diagnostic: { type: 'boolean', default: false, description: 'Return the full diagnostic catalog instead of the compact dispatch list.' },
      },
    },
    output,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const diagnostic = args?.diagnostic === true;
      const roster = await ctx.agentPresets.remoteExportList();
      const selection = ctx.get('subagentModelSelection')?.current();
      const catalog = await (api.catalog ? api.catalog.read() : buildCatalog(ctx.llm)).catch(error => ({ groups: [], failures: [{ provider: '*', name: 'LLM catalog', message: String(error?.message ?? error) }] }));
      const key = route => `${route.provider}\u0000${route.model}`;
      const entries = new Map();
      for (const group of catalog.groups) for (const model of group.models) entries.set(key(model), { provider: model.provider, model: model.model, name: model.name, efforts: (model.efforts ?? []).map(effort => effort.id) });
      // Explicit selection needs both switches. When either is off, nothing may be
      // requested, so models/usableModels must be empty rather than aspirational.
      const explicitAvailable = config.allowModelSelection !== false && selection?.enabled === true;
      const pool = explicitAvailable ? (selection.allowedModels ?? []) : null;
      const rows = roster.presets.map(preset => {
        const policy = presetPolicy(preset.id) ?? null;
        const declared = policy?.allowedModels ?? [];
        // "host" scope follows the authorized pool; "selected" is the pool-limited list.
        const usable = !explicitAvailable ? [] : (policy?.modelScope === 'selected'
          ? declared.filter(route => pool.some(allowed => key(allowed) === key(route)))
          : pool);
        const unavailable = !explicitAvailable
          ? declared
          : declared.filter(route => !pool.some(allowed => key(allowed) === key(route)));
        // In the compact answer a preset that simply follows the authorized pool repeats nothing:
        // `models` lists that pool once, so only a preset that narrows it carries its own route
        // list. The diagnostic answer keeps every per-preset model row, as the old contract did.
        const narrowsModels = diagnostic || usable !== pool;
        return {
          id: preset.id, name: preset.name ?? null, description: preset.description ?? null,
          isDefault: preset.isDefault === true, loaded: preset.broken === undefined, broken: preset.broken ?? null,
          dispatchable: allowed(preset.id) && preset.broken === undefined, policy,
          pinnedModel: policy?.defaultModel ?? null, pinnedEffort: policy?.defaultEffort ?? null,
          ...(narrowsModels ? { usableModels: usable.map(route => ({ provider: route.provider, model: route.model })) } : {}),
          unavailableModels: unavailable.map(route => ({ provider: route.provider, model: route.model })),
        };
      });
      // The compact list keeps the row schema intact and only drops the presets that could not be
      // dispatched anyway, so a consumer that reads a preset by name keeps working.
      const presets = diagnostic ? rows : rows.filter(row => row.dispatchable);
      const usable = new Set();
      // `models` is the union of the effective routes of the listed presets, so a preset whose row
      // omits `usableModels` contributes the pool it follows rather than nothing.
      for (const preset of presets) for (const route of preset.usableModels ?? (explicitAvailable ? pool : [])) usable.add(key(route));
      const models = [...usable].map(id => entries.get(id) ?? { provider: id.split('\u0000')[0], model: id.split('\u0000')[1], name: id.split('\u0000')[1], efforts: [] });
      const value = {
        modelSelectionEnabled: selection?.enabled ?? false,
        explicitSelectionAvailable: explicitAvailable,
        models, presets, rules: dispatchRules(explicitAvailable),
      };
      if (diagnostic) {
        value.hostPool = { enabled: selection?.enabled === true, allowedModels: (selection?.allowedModels ?? []).map(route => ({ provider: route.provider, model: route.model })) };
        value.unauthorizedModels = pool ? [...entries.entries()].filter(([id]) => !pool.some(allowed => key(allowed) === id)).map(([, entry]) => entry) : [];
      } else {
        // A bare count, not the rows: why a preset is unavailable is diagnostic detail, but a
        // silently shorter list would read as "these are all the presets that exist".
        value.omittedPresets = rows.length - presets.length;
      }
      // A catalog failure is an error rather than metadata, so it is reported in both modes: an
      // empty pool without it would read as "no model is authorized".
      if ((catalog.failures ?? []).length) value.catalogFailures = catalog.failures;
      // Only present when it applies: an explicit undefined would make the tool result
      // non-JSON, which the harness rejects outright.
      if (!explicitAvailable) value.note = selection?.enabled !== true
        ? 'Host 子代理模型授权未启用：只有未固定模型的预设能通过继承父代理模型派遣；显式指定模型与预设默认模型/强度都会被拒绝，因此 models 与 usableModels 为空。'
        : '插件配置 allowModelSelection=false：显式指定与预设默认模型/强度都会被拒绝，只有继承父代理模型可用，因此 models 与 usableModels 为空。';
      // The caller's session id is the binding a later lifecycle projection needs. Without a
      // calling agent there is nothing to bind to, so the id stays unbound instead of guessed.
      const parentSessionId = typeof exec?.agent?.id === 'string' && exec.agent.id !== '' ? exec.agent.id : null;
      return {
        catalogId: api.randomUUID(),
        catalog: {
          marker: listMarker, formatVersion: listFormatVersion,
          mode: diagnostic ? 'diagnostic' : 'compact',
          sessionBound: parentSessionId !== null, parentSessionId,
          authorizationTicket: false,
        },
        ...value,
      };
    },
  };

  const dispatchTool = {
    name: 'preset_dispatch',
    description: 'Run a fresh subagent using an actual agent preset, inheriting your workspace and delegation permissions. Foreground returns its result; background returns a job id for job_output/job_kill. Does not change your own preset or model.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        preset: { type: 'string', minLength: 1, description: 'Exact dispatchable preset id from preset_list.' },
        task: { type: 'string', minLength: 1, description: 'Self-contained task. The child has no parent conversation history.' },
        provider: { type: 'string', minLength: 1, description: 'Optional authorized LLM provider; supply together with model. Omit both to use the preset default, or inherit when no default is configured.' },
        model: { type: 'string', minLength: 1, description: 'Optional exact model id; requires provider.' },
        reasoning_effort: { type: 'string', minLength: 1, description: 'Optional effort id supported by the effective model, including when inheriting the route.' },
        run_in_background: { type: 'boolean', default: false, description: 'Return a job id immediately instead of waiting. Collect or cancel it with the job tools.' },
        catalogId: { type: 'string', minLength: 1, description: 'Optional catalogId from the preset_list answer this dispatch follows. Correlation only: it is not verified and never replaces the live authorization check, and omitting it keeps the previous behavior.' },
      }, required: ['preset', 'task'],
    }, output,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      if (closing) fail('plugin is closing');
      const parent = exec.agent;
      if (!parent) fail('requires a calling agent');
      const presetId = nonempty(args.preset, 'preset');
      const task = nonempty(args.task, 'task');
      // The catalog id is accepted for correlation only. It is deliberately not checked against a
      // registry, not required, and not consultable for authorization: this phase has no
      // cross-session ticket, so an id must never widen what may be dispatched or excuse a refusal.
      const catalogId = args.catalogId === undefined ? null : nonempty(args.catalogId, 'catalogId');
      if (!allowed(presetId)) fail(`preset ${presetId} is not allowed; allowed: ${config.allowedPresets.join(', ')}`);
      if ((args.provider === undefined) !== (args.model === undefined)) fail('provider and model must be supplied together');
      const explicit = args.provider !== undefined || args.reasoning_effort !== undefined;
      const parentOptions = api.parentAgentOptionsForDelegation(parent);
      const requested = {};
      if (args.provider !== undefined) {
        requested.provider = nonempty(args.provider, 'provider'); requested.model = nonempty(args.model, 'model');
      }
      if (args.reasoning_effort !== undefined) requested.reasoningEffort = nonempty(args.reasoning_effort, 'reasoning_effort');
      // Capture once, before any await. One-shot approval grants are never propagated.
      const policy = api.captureDelegatedPolicyOverrides(parent);
      policy.sandboxMode = ctx.sandboxPolicy.resolve({ session: parent.session }).mode;
      policy.approvalPolicy = 'never';
      const hostDepth = ctx.subagents.resolveMaxDepth();
      const maxDepth = Math.min(config.maxDepth, hostDepth ?? config.maxDepth);
      const depth = api.resolveChildDepth(parent, maxDepth);
      const selectedPolicy = presetPolicy(presetId);
      const policyRequested = applyPresetPolicy(selectedPolicy, requested);
      const agentOptions = api.resolveChildAgentOptions(parent, policyRequested, depth);
      assertPresetRoute(selectedPolicy, agentOptions);
      const definition=api.getManagedDefinition?.(presetId);
      const routing={provider:agentOptions.provider,model:agentOptions.model,reasoningEffort:agentOptions.reasoningEffort??null,modelSource:requested.provider!==undefined?'parent-explicit':selectedPolicy?.defaultModel?'preset-default':'parent-inherited',effortSource:requested.reasoningEffort!==undefined?'parent-explicit':selectedPolicy?.defaultEffort?'preset-default':'parent-inherited',presetVersion:definition?.version??null};
      // The child session id is reserved HERE, before the authorization is re-checked
      // and before the history record exists, so one id identifies this dispatch from
      // its first written byte to its last: the record, the created child and the
      // visibility API all name the same session. The reservation is not proof that a
      // child started — only `history.update(..., { childSessionId })` after
      // `ctx.agents.create` resolves is, and the observation state says which one it is.
      const childSessionId = api.brandString(api.randomUUID());
      const callId = typeof exec.callId === 'string' && exec.callId !== '' ? exec.callId : null;
      const rootCallId = typeof exec.rootCallId === 'string' && exec.rootCallId !== '' ? exec.rootCallId : null;
      const plannedRouting = planRouting(routing);
      let observation = observationFromPlan({ childSessionId, callId, plannedRouting, at: new Date().toISOString() });
      const ticket = { preset: presetId, catalogId, policy, agentOptions, definition, routing, childSessionId, observation, meta: api.childSessionMeta(parent, depth, false) };
      const signal = AbortSignal.any([exec.signal, lifetime.signal]);
      signal.throwIfAborted();
      const preset = await ctx.agentPresets.resolve(presetId);
      if (preset.broken !== undefined) fail(`preset ${presetId} is broken: ${preset.broken}`);
      // The snapshot name is the managed definition's name when this plugin owns the
      // preset, otherwise the roster name, otherwise the id. A later rename therefore
      // never rewrites an old record.
      const presetName = definition?.name ?? preset.name ?? presetId;
      if (explicit || policyRequested.provider !== undefined || policyRequested.reasoningEffort !== undefined) {
        const selection = ctx.get('subagentModelSelection')?.current();
        if (!config.allowModelSelection || !selection?.enabled) fail('explicit model/effort selection is disabled in Host settings');
      }
      // Every effective route — explicit, preset default or inherited — passes the same
      // authorization gate, so omitting provider/model cannot widen what may be used.
      {
        const selection = ctx.get('subagentModelSelection')?.current();
        if (selection?.enabled === true && !(selection.allowedModels ?? []).some(route => route.provider === agentOptions.provider && route.model === agentOptions.model)) {
          fail(`effective child model ${agentOptions.provider} / ${agentOptions.model} is not authorized by Host settings`);
        }
      }
      // The adapter owns model/effort validation. Never supply temperature.
      await ctx.llm.resolveCallConfig({ provider: agentOptions.provider, model: agentOptions.model, ...(agentOptions.reasoningEffort === undefined ? {} : { reasoningEffort: agentOptions.reasoningEffort }) }, signal);
      signal.throwIfAborted();
      // The record is written before the child exists, so a dispatch that is admitted
      // and then fails is still visible. `plannedRouting` is what this plugin asked
      // for; `observedRouting` stays absent until the child's own request header says
      // otherwise, and the preflight above never fills it in.
      const record=api.history?.begin({
        preset:presetId, ...routing, presetName, callId, rootCallId, childSessionId,
        // The parent/child correlation (docs/08 需求 5.2) is stored at begin, before the child
        // exists: a record that only learned its parent at finish would be unaddressable for the
        // whole run, which is exactly when the visibility API must bind a lookup to a session.
        parentSession: parent.id,
        plannedRouting, observationState: observation.state,
        policySnapshot:selectedPolicy?structuredClone(selectedPolicy):null,
      });
      ticket.record = record;
      ticketByChild.set(childSessionId, ticket);
      const start = async childSignal => {
        tickets.set(childSignal, ticket);
        try {
          const run=await ctx.subagents.start(providerName, { parent, signal: childSignal, prompt: [{ type: 'text', text: task }], label: `preset:${presetId}`, maxDepth, agentOptions });
          run.result=run.result.then(result=>{
            finishObservation(ticket, result.stopReason, new Date().toISOString());
            ticketByChild.delete(childSessionId);
            api.history?.finish(record,result.stopReason,run.id);
            return {...result,routing,presetName,callId,rootCallId,observation:ticket.observation,routingView:routingView(ticket.observation)};
          },error=>{
            finishObservation(ticket, childSignal.aborted?'aborted':'error', new Date().toISOString());
            ticketByChild.delete(childSessionId);
            api.history?.finish(record,childSignal.aborted?'aborted':'error',run.id);
            throw error;
          });
          return run;
        } catch(error){
          finishObservation(ticket, childSignal.aborted?'aborted':'error', new Date().toISOString());
          ticketByChild.delete(childSessionId);
          api.history?.finish(record,childSignal.aborted?'aborted':'error');
          throw error;
        }
        finally {tickets.delete(childSignal);}
      };
      if (args.run_in_background === true) {
        const jobs = ctx.get('jobs');
        if (!jobs) fail('background job service unavailable');
        const jobId = jobs.start({ kind: 'subagent', owner: parent.id, label: `preset:${presetId}`, run: () => {
          const controller = new AbortController();
          const backgroundSignal = AbortSignal.any([controller.signal, lifetime.signal]);
          const done = (async () => {
            try { return await api.settleRun(await start(backgroundSignal)); }
            catch (error) { return { status: backgroundSignal.aborted ? 'killed' : 'failed', detail: String(error) }; }
          })();
          return { done, cancel: reason => controller.abort(reason ?? 'preset dispatch cancelled') };
        } });
        // `jobId` is a handle for collecting the result. It is NOT proof that a child
        // started, so the answer reports the reserved child session id separately and
        // leaves `childStarted` false until the child really exists.
        return { kind: 'background', preset: presetId, presetName, presetVersion: definition?.version ?? null, jobId, childSessionId, parentSessionId: parent.id, childStarted: false, callId, rootCallId, catalogId, routing, plannedRouting, observationState: ticket.observation.state, observation: ticket.observation, routingView: routingView(ticket.observation) };
      }
      const run = await start(signal);
      // The run result is spread FIRST so the recorded envelope fields below cannot be overwritten
      // by it: `runId`, `presetVersion`, `observationState` and `catalogId` are the correlation
      // record a later reader compares literally.
      try { return { ...await run.result, kind: 'foreground', preset: presetId, presetName, presetVersion: definition?.version ?? null, runId: run.id, childSessionId: run.id, parentSessionId: parent.id, childStarted: true, callId, rootCallId, catalogId, observationState: ticket.observation.state, routing, plannedRouting, runtimeTools:ctx.tools?.schemas?.(run.localAgent)?.map(t=>t.name) ?? [] }; }
      finally { await run.dispose(); }
    },
  };
  const pending = new Set();
  const originalStart = provider.start.bind(provider);
  provider.start = request => {
    const promise = api.withPresetLock ? api.withPresetLock(()=>originalStart(request)) : originalStart(request);
    pending.add(promise);
    promise.then(() => pending.delete(promise), () => pending.delete(promise));
    return promise;
  };
  return {
    provider, listTool, dispatchTool,
    /**
     * Expose the live observation of one ticket to the Host half. The visibility
     * API reads this instead of a copied history row, so a card can see the
     * observed routing the moment the child's request header lands rather than
     * when the dispatch ends.
     *
     * `record` is the STORED history row, not a copy, and `adopt` replaces the
     * ticket's own observation. Both matter for the same reason: if the Host's
     * global `session/event` backstop only corrected a copy, the ticket would
     * still hold an empty observation, and the finish path would then write that
     * empty value over the routing the record already proved.
     */
    observationOf(childSessionId) {
      const ticket = ticketByChild.get(childSessionId);
      if (!ticket) return null;
      return {
        childSessionId,
        record: ticket.record ?? null,
        observation: ticket.observation,
        adopt: observation => {
          if (!observation || ticket.observation === observation) return;
          // Only ever forward: an adopted observation must not be emptier than what the ticket
          // already recorded, so a late or out-of-order event cannot erase a real observation.
          if (observation.observed === null && ticket.observation?.observed) return;
          ticket.observation = observation;
          noteObservation(ticket);
        },
      };
    },
    async close() {
      closing = true;
      lifetime.abort(new Error('preset-dispatch unloaded'));
      await Promise.allSettled([...pending]);
      await Promise.allSettled([...active].map(run => run.dispose()));
    },
  };
}
