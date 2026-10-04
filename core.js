import { applyPresetPolicy, assertPresetRoute } from './policy.js?stable';
import { ROLES, roleTools, roleDenial } from './roles.js?stable';
import { templateRole } from './managed-presets.js?stable';
import { buildCatalog } from './catalog.js?stable';
// Runtime-neutral implementation; DSH dependencies are supplied by host.js.
export function createDispatcher(ctx, config, api) {
  const providerName = 'local-preset-dispatch';
  const tickets = new WeakMap();
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
  const output = { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] };

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
        sessionId: api.brandString(api.randomUUID()),
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
      return drive(handle, request.signal).begin(request.prompt);
    },
  };

  const listTool = {
    name: 'preset_list',
    description: 'List actual agent presets, dispatch eligibility, per-preset policy and the models each preset may actually use. models lists the routes that may be explicitly requested; a preset with no pinned model instead inherits the parent route, and that inheritance is the only path allowed while modelSelectionEnabled is false. unauthorizedModels exist in the DSH catalog but are not authorized and are refused at dispatch.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output,
    isConcurrencySafe: () => true,
    async execute() {
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
      const presets = roster.presets.map(preset => {
        const policy = presetPolicy(preset.id) ?? null;
        const declared = policy?.allowedModels ?? [];
        // "host" scope follows the authorized pool; "selected" is the pool-limited list.
        const usable = !explicitAvailable ? [] : (policy?.modelScope === 'selected'
          ? declared.filter(route => pool.some(allowed => key(allowed) === key(route)))
          : pool);
        const unavailable = !explicitAvailable
          ? declared
          : declared.filter(route => !pool.some(allowed => key(allowed) === key(route)));
        return {
          id: preset.id, name: preset.name ?? null, description: preset.description ?? null,
          isDefault: preset.isDefault === true, loaded: preset.broken === undefined, broken: preset.broken ?? null,
          dispatchable: allowed(preset.id) && preset.broken === undefined, policy,
          pinnedModel: policy?.defaultModel ?? null, pinnedEffort: policy?.defaultEffort ?? null,
          usableModels: usable.map(route => ({ provider: route.provider, model: route.model })),
          unavailableModels: unavailable.map(route => ({ provider: route.provider, model: route.model })),
        };
      });
      const usable = new Set();
      for (const preset of presets) for (const route of preset.usableModels) usable.add(key(route));
      const models = [...usable].map(id => entries.get(id) ?? { provider: id.split('\u0000')[0], model: id.split('\u0000')[1], name: id.split('\u0000')[1], efforts: [] });
      const unauthorizedModels = pool ? [...entries.entries()].filter(([id]) => !pool.some(allowed => key(allowed) === id)).map(([, entry]) => entry) : [];
      const value = {
        modelSelectionEnabled: selection?.enabled ?? false,
        explicitSelectionAvailable: explicitAvailable,
        hostPool: { enabled: selection?.enabled === true, allowedModels: (selection?.allowedModels ?? []).map(route => ({ provider: route.provider, model: route.model })) },
        models, unauthorizedModels, catalogFailures: catalog.failures, presets,
      };
      // Only present when it applies: an explicit undefined would make the tool result
      // non-JSON, which the harness rejects outright.
      if (!explicitAvailable) value.note = selection?.enabled !== true
        ? 'Host 子代理模型授权未启用：只有未固定模型的预设能通过继承父代理模型派遣；显式指定模型与预设默认模型/强度都会被拒绝，因此 models 与 usableModels 为空。'
        : '插件配置 allowModelSelection=false：显式指定与预设默认模型/强度都会被拒绝，只有继承父代理模型可用，因此 models 与 usableModels 为空。';
      return value;
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
      }, required: ['preset', 'task'],
    }, output,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      if (closing) fail('plugin is closing');
      const parent = exec.agent;
      if (!parent) fail('requires a calling agent');
      const presetId = nonempty(args.preset, 'preset');
      const task = nonempty(args.task, 'task');
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
      const ticket = { preset: presetId, policy, agentOptions, definition, routing, meta: api.childSessionMeta(parent, depth, false) };
      const signal = AbortSignal.any([exec.signal, lifetime.signal]);
      signal.throwIfAborted();
      const preset = await ctx.agentPresets.resolve(presetId);
      if (preset.broken !== undefined) fail(`preset ${presetId} is broken: ${preset.broken}`);
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
      const record=api.history?.begin({preset:presetId,...routing,policySnapshot:selectedPolicy?structuredClone(selectedPolicy):null});
      const start = async childSignal => {
        tickets.set(childSignal, ticket);
        try {
          const run=await ctx.subagents.start(providerName, { parent, signal: childSignal, prompt: [{ type: 'text', text: task }], label: `preset:${presetId}`, maxDepth, agentOptions });
          run.result=run.result.then(result=>{api.history?.finish(record,result.stopReason,run.id);return {...result,routing};},error=>{api.history?.finish(record,childSignal.aborted?'aborted':'error',run.id);throw error;});
          return run;
        } catch(error){api.history?.finish(record,childSignal.aborted?'aborted':'error');throw error;}
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
        return { kind: 'background', preset: presetId, jobId, routing };
      }
      const run = await start(signal);
      try { return { kind: 'foreground', preset: presetId, childSessionId: run.id, ...await run.result, runtimeTools:ctx.tools?.schemas?.(run.localAgent)?.map(t=>t.name) ?? [] }; }
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
    async close() {
      closing = true;
      lifetime.abort(new Error('preset-dispatch unloaded'));
      await Promise.allSettled([...pending]);
      await Promise.allSettled([...active].map(run => run.dispose()));
    },
  };
}
