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

// Local bundles are linked to workspace realpaths. Resolve public runtime packages
// from the actual Host entry, not from this workspace or a second npm installation.
const hostEntry = process.argv[1];
if (!hostEntry) throw new Error('preset-dispatch requires a DSH Host entry script');
const hostRequire = createRequire(pathToFileURL(hostEntry));
const load = spec => import(pathToFileURL(hostRequire.resolve(spec)).href);
const { default: z } = await load('@deepseek-ai/schemastery');
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
  registerSettingsApi(ctx, config, management, catalogCache);
  registerManagementApi(ctx,management,history,() => storageNote ?? history.storageError());
  ctx.systemPrompt.section({ name:'preset-dispatch-routing', order:115, text:() => routingText(ctx.get('subagentModelSelection')?.current(), Object.fromEntries(management.owned().map(d=>[d.id,d])), liveConfig.presetPolicies) });
  ctx.settings.configure({ auto: false });
  const runtime = createDispatcher(ctx, liveConfig, {
    ...subagent,
    serviceIdentity: value => value[symbols.original] ?? value,
    randomUUID, brandString, createUserMessage, foldConsumedWork, SessionLogOffset,
    getManagedDefinition:management.get, withPresetLock:management.coordinate, history, catalog: catalogCache,
  });
  ctx.subagents.registerProvider(runtime.provider);
  ctx.tools.register(runtime.listTool);
  ctx.tools.register(runtime.dispatchTool);
  ctx.effect(() => () => runtime.close(), 'preset-dispatch runs');
}
