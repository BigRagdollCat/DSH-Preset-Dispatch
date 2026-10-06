import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createDispatcher } from './core.js?stable';
import { managementOperations, registerManagementApi } from './management-api.js?stable';
import { createHistory } from './history.js?stable';
import { createHistoryStore, runSchema } from './history-store.js?stable';
import { buildCatalog } from './catalog.js?stable';
import { createCatalogCache } from './catalog-cache.js?stable';
import { routingText } from './routing.js?stable';
import { validatePolicies } from './policy.js?stable';
import { registerSettingsApi } from './settings-api.js?stable';
import { createRouteProjectionDefinition, observationWithEvents, routingView } from './dispatch-observation.js?stable';
import { registerVisibilityApi } from './visibility-api.js?stable';
import { registerQueryCompaction } from './query-compaction-host.js?stable';

// Local bundles are linked to workspace realpaths. Resolve public runtime packages
// from the actual Host entry, not from this workspace or a second npm installation.
const hostEntry = process.argv[1];
if (!hostEntry) throw new Error('preset-dispatch requires a DSH Host entry script');
const hostRequire = createRequire(pathToFileURL(hostEntry));
const load = spec => import(pathToFileURL(hostRequire.resolve(spec)).href);
const { default: z } = await load('@deepseek-ai/schemastery');
// The projection registry validates state through `stateSchema.parse`, which the Host's
// schemastery validator does not expose. `zod` is already a dependency this plugin loads for the
// durable history schema, so the projection is declared with the real validator instead of a
// compatibility shim. Only an object that really offers zod's `object`/`any`/`array` is used; a
// composition without it falls back to schemastery, whose callable schemas the definition accepts.
const zodModule = await load('zod').catch(() => null);
const zodOf = module => {
  for (const candidate of [module?.z, module?.default, module]) {
    if (candidate && typeof candidate.object === 'function' && typeof candidate.any === 'function' && typeof candidate.array === 'function') return candidate;
  }
  return null;
};
const zod = zodOf(zodModule);
const { symbols } = await load('@deepseek-ai/cordis');
const { brandString } = await load('@deepseek-ai/dsh-brand');
const { createUserMessage } = await load('@deepseek-ai/dsh-llm');
const { foldConsumedWork } = await load('@deepseek-ai/dsh-agent');
const { SessionLogOffset } = await load('@deepseek-ai/dsh-session');
const subagent = await load('@deepseek-ai/dsh-subagent');
export const name = 'local-preset-dispatch';
export const inject = ['subagents', 'tools', 'agents', 'agentPresets', 'llm', 'sandboxPolicy', 'approval', 'permissionPresets', 'settings', 'webServer', 'systemPrompt', 'configEditor', 'connection'];
export const Config = z.object({
  allowedPresets: z.array(z.string()).default(['standard', 'ptc', 'minimal', 'cordis']),
  maxDepth: z.number().default(1).volatile(),
  allowModelSelection: z.boolean().default(true),
  // Phase C is wired but closed: the "already used query" compaction runs only when this is true.
  compressUsedQueries: z.boolean().default(false),
  presetPolicies: z.array(z.object({
    preset: z.string(), enabled: z.boolean().default(false),
    defaultModel: z.any(),
    allowedModels: z.array(z.object({ provider: z.string(), model: z.string() })).default([]),
    modelScope: z.string(),
    lockModel: z.boolean().default(false), defaultEffort: z.string(),
    allowedEfforts: z.array(z.string()).default([]),
  })).default([]).volatile(),
});
export async function apply(ctx, config) {
  if (!Number.isSafeInteger(config.maxDepth.get()) || config.maxDepth.get() < 0) throw new Error('maxDepth must be a non-negative safe integer');
  if (config.allowedPresets.some(id => !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id))) throw new Error('allowedPresets must contain exact preset ids');
  validatePolicies(config.presetPolicies.get());
  const liveConfig = {
    allowedPresets: config.allowedPresets, allowModelSelection: config.allowModelSelection,
    get maxDepth() { return config.maxDepth.get(); },
    get presetPolicies() { return validatePolicies(config.presetPolicies.get()); },
  };
  const management=managementOperations(ctx);
  // The catalog is display data, so a short cache is safe. Authorization is read live at
  // save and dispatch time and never passes through here. `llm/adapters-updated` is the
  // real event the LLM service publishes when adapters change, so a changed provider is
  // picked up immediately instead of after the ttl.
  const catalogCache = createCatalogCache({ build: signal => buildCatalog(ctx.llm, signal) });
  if (typeof ctx.on === 'function') {
    ctx.effect(() => {
      // The event is published by the LLM plugin's own context. The LLM package itself asks
      // for global delivery on the events it must see across contexts, so a sibling plugin
      // has to do the same — otherwise the listener is registered but never fires, and the
      // catalog would only ever refresh by ttl. If the option is unsupported, fall back to
      // a plain registration; the ttl remains the documented backstop either way.
      const invalidate = () => catalogCache.invalidate();
      let off;
      try { off = ctx.on('llm/adapters-updated', invalidate, { global: true }); }
      catch { off = ctx.on('llm/adapters-updated', invalidate); }
      return typeof off === 'function' ? off : () => {};
    }, 'preset-dispatch catalog invalidation');
  }
  let storageNote = null;
  // Durable history is optional by construction. Without the storage packages — or with a
  // medium that refuses to open — the history stays in memory and the reason is reported,
  // because losing history records must never break dispatching.
  const openHistoryStore = async () => {
    try {
      const hub = ctx.get('storage');
      const facility = ctx.get('storageDomain') ?? hub?.form?.('domain') ?? hub?.domain;
      if (!facility || typeof facility.open !== 'function') { storageNote = 'storage-domain 形态未挂载'; return null; }
      const { defineDomain, domainTable } = await load('@deepseek-ai/dsh-storage-domain');
      const { z } = await load('zod');
      const store = createHistoryStore({
        defineDomain, domainTable,
        // The schema is the durable contract and is derived from the same field list the
        // writer uses, so the two cannot drift apart.
        schema: runSchema(z),
      });
      await store.open(facility);
      return store;
    } catch (error) {
      storageNote = String(error?.message ?? error);
      if (typeof ctx.logger?.warn === 'function') ctx.logger.warn('preset-dispatch: 历史持久化不可用（' + storageNote + '）');
      return null;
    }
  };
  const historyStore = await openHistoryStore();
  const history = createHistory(50, historyStore);
  if (historyStore) {
    ctx.effect(() => () => historyStore.close().catch(() => {}), 'preset-dispatch history storage');
    await history.restore();
  }
  /**
   * Live observation of one dispatch, read from the dispatcher's own ticket.
   *
   * It is looked up by the child session id, never by a history row: `history.list()` hands out
   * copies, and a copy is not the object the dispatcher is still updating.
   */
  const liveFor = row => (row?.childSessionId ? runtime?.observationOf?.(row.childSessionId) ?? null : null);
  /** The live Session of a child, when it is still running. Used to verify parent/child. */
  const sessions = id => {
    try { return ctx.agents.get(id)?.session ?? null; } catch { return null; }
  };
  /**
   * Fold one committed event of a dispatch child into its observation.
   *
   * This is the global backstop: the listener is registered with `global: true`
   * because the child agent's context is not this plugin's context, so a plain
   * scoped listener would never fire. It only ever touches a run this plugin
   * created — an event from any other session, or from a child whose own header
   * names a different parent than the record does, is ignored rather than stored.
   *
   * The child is identified through the ACTIVE TICKET, never by scanning
   * `history.list()`: that list is bounded, so a long dispatch whose row has been
   * pushed out of the newest fifty would stop being observed for good. The ticket
   * carries the record it belongs to and the child session id it reserved.
   */
  const observeSessionEvent = (session, event) => {
    if (!event || event.type !== 'request/header') return;
    const childSessionId = session?.id;
    if (typeof childSessionId !== 'string' || childSessionId === '') return;
    const live = runtime?.observationOf?.(childSessionId) ?? null;
    if (!live) return;
    // The record is looked up in the STORE by its id, not taken from a `list()` snapshot: `list()`
    // returns clones, and a correction applied to a clone is lost when the dispatch ends.
    const recordId = live.record?.id ?? null;
    const record = (typeof recordId === 'string' && typeof history.get === 'function' ? history.get(recordId) : null) ?? live.record ?? null;
    if (!record) return;
    // The parent/child relationship is checked, not assumed: a session that merely
    // claims the same id as a recorded child is not treated as that child.
    const statedParent = record.parentSession ?? null;
    if (statedParent !== null && session?.header?.parentSession !== statedParent) return;
    const observation = observationWithEvents(live.observation, [event]);
    if (observation === live.observation) return;
    // The record is the durable side of the same fact; the API reads both, so a
    // restarted process that lost the in-memory ticket still shows what was seen.
    // `adopt` hands the folded observation back to the LIVE ticket as well, so the
    // finish path cannot later write the ticket's older, empty observation over it.
    if (typeof live.adopt === 'function') live.adopt(observation);
    else history.update(record, { observationState: observation.state, observedRouting: routingView(observation).observed });
  };
  if (typeof ctx.on === 'function') {
    ctx.effect(() => {
      const listener = (session, event) => observeSessionEvent(session, event);
      let off;
      try { off = ctx.on('session/event', listener, { global: true }); }
      catch { off = null; }
      return typeof off === 'function' ? off : () => {};
    }, 'preset-dispatch observation feed');
  }
  registerSettingsApi(ctx, config, management, catalogCache);
  registerManagementApi(ctx,management,history,() => storageNote ?? history.storageError());
  // Phase C wiring: the compaction is closed unless `compressUsedQueries` is true, and the flag is
  // read live at every pre-step boundary. The token meter is optional by construction — without it
  // the boundary only reports and writes nothing — and the disposer releases both listeners.
  ctx.effect(() => {
    const enabled = () => config.compressUsedQueries.get() === true;
    return registerQueryCompaction(ctx, { enabled, tokenMeter: ctx.get('tokenMeter') ?? null, logger: ctx.logger });
  }, 'preset-dispatch query compaction');
  ctx.systemPrompt.section({ name:'preset-dispatch-routing', order:115, text:() => routingText(ctx.get('subagentModelSelection')?.current(), Object.fromEntries(management.owned().map(d=>[d.id,d])), liveConfig.presetPolicies) });
  ctx.settings.configure({ auto: false });
  let runtime = null;
  runtime = createDispatcher(ctx, liveConfig, {
    ...subagent,
    serviceIdentity: value => value[symbols.original] ?? value,
    randomUUID, brandString, createUserMessage, foldConsumedWork, SessionLogOffset,
    getManagedDefinition:management.get, withPresetLock:management.coordinate, history, catalog: catalogCache,
  });
  /**
   * The child's own session view. Registered through `ctx.inject` so a composition
   * without the projection registry keeps working: the card and the badge fall back
   * to the visibility API, which is the authoritative face either way.
   */
  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['sessionProjections'], projectionCtx => {
        const registry = projectionCtx.get('sessionProjections');
        if (!registry || typeof registry.register !== 'function') return;
        try { projectionCtx.effect(() => registry.register(createRouteProjectionDefinition(zod ?? z)), 'preset-dispatch route projection'); }
        catch (error) { ctx.logger?.warn?.('preset-dispatch: 会话投影不可用（' + String(error?.message ?? error) + '）'); }
      });
    } catch { /* no projection registry in this composition */ }
  }
  // The visibility route is optional for the same reason the projection is: a
  // composition without the web carrier must still be able to dispatch.
  if (ctx.get('webServer')) {
    // One lifetime per registration, aborted by the route's own disposer: a plugin unload closes
    // every open stream even though the module has no other way to signal it.
    const visibility = new AbortController();
    ctx.effect(() => {
      const dispose = registerVisibilityApi(ctx, { history, liveFor, sessions, lifetime: visibility, restored: history.restoredAt() !== null });
      return () => {
        visibility.abort();
        if (typeof dispose === 'function') dispose();
      };
    }, 'preset-dispatch visibility');
  }
  ctx.subagents.registerProvider(runtime.provider);
  ctx.tools.register(runtime.listTool);
  ctx.tools.register(runtime.dispatchTool);
  ctx.effect(() => () => runtime.close(), 'preset-dispatch runs');
}
