// Model catalog assembly.
//
// Uses the same public services as the native model selector
// (ctx.llm.listProviders -> listModels -> resolveModelInfo), so the Agent 管理
// page can offer exactly the models the chat picker shows. Failures are isolated
// per provider: one unreachable endpoint never empties the whole catalog.
export async function buildCatalog(llm, signal) {
  if (!llm?.listProviders) throw new Error('LLM service unavailable');
  const providers = llm.listProviders();
  const settled = await Promise.all(providers.map(async provider => {
    try {
      const models = await llm.listModels(provider.id);
      const entries = [];
      for (const model of models ?? []) {
        const entry = { provider: provider.id, model: model.id, name: model.name ?? model.id };
        if (model.description) entry.description = model.description;
        try {
          const info = await llm.resolveModelInfo(provider.id, model.id, signal);
          const efforts = info?.reasoning?.efforts ?? [];
          entry.efforts = efforts.map(effort => ({ id: effort.id, name: effort.name ?? effort.id }));
          if (info?.reasoning?.defaultEffort !== undefined) entry.defaultEffort = info.reasoning.defaultEffort;
          if (info?.context?.contextWindow !== undefined) entry.contextWindow = info.context.contextWindow;
        } catch {
          // Capability metadata is advisory; the model stays selectable.
          entry.efforts = [];
          entry.capabilityUnknown = true;
        }
        entries.push(entry);
      }
      return { kind: 'group', provider: provider.id, name: provider.name ?? provider.id, models: entries };
    } catch (error) {
      return { kind: 'failure', provider: provider.id, name: provider.name ?? provider.id, message: String(error?.message ?? error) };
    }
  }));
  return {
    groups: settled.filter(entry => entry.kind === 'group' && entry.models.length).map(({ kind, ...group }) => group),
    failures: settled.filter(entry => entry.kind === 'failure').map(({ kind, ...failure }) => failure),
  };
}

// Route keys are "provider/model"; used for every set comparison in this plugin.
export const routeKey = route => `${route.provider}\u0000${route.model}`;

export function catalogIndex(catalog) {
  const efforts = new Map();
  for (const group of catalog?.groups ?? []) {
    for (const model of group.models) {
      // A failed capability lookup must not masquerade as "supports no efforts":
      // leaving it out means no effort check runs for that route.
      if (model.capabilityUnknown) continue;
      efforts.set(routeKey(model), (model.efforts ?? []).map(effort => effort.id));
    }
  }
  return efforts;
}
