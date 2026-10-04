import { GROUP_ID, TEMPLATES, definitionsFrom, revisionOf, mutateDefinitions, previewDefinition } from './managed-presets.js?stable';
import { gate } from './settings-api.js?stable';

export function managementOperations(ctx) {
  const group = () => {
    const entry = ctx.configEditor.entries().find(candidate => candidate.options.id === GROUP_ID);
    if (!entry) throw new Error('Managed preset group unavailable');
    return entry;
  };
  const roleEntry = new URL('./role-managed.js', import.meta.url).href;
  let tail = Promise.resolve();
  const coordinate = fn => { const task = tail.then(fn); tail = task.catch(() => {}); return task; };
  const owned = () => definitionsFrom(group().options.config);
  const get = id => owned().find(definition => definition.id === id);

  const mutateInner = async input => {
    const entry = group();
    const roster = (await ctx.agentPresets.remoteExportList()).presets;
    const usage = ctx.agents.list().map(agent => ctx.agentPresets.composedPreset(agent.ctx)).filter(Boolean);
    const next = mutateDefinitions(entry.options.config, input, { roleEntry, roster, usage });
    await ctx.configEditor.edit(entry, current => {
      if (revisionOf(current) !== input.revision) throw new Error('Preset configuration changed since it was read; reload');
      if (input.action === 'delete' && ctx.agents.list().some(agent => ctx.agentPresets.composedPreset(agent.ctx) === input.id)) throw new Error('Preset has active sessions; close them before deleting');
      return next;
    });
    const id = input.action === 'delete' ? input.id : input.definition?.id;
    // Once edit() returns the write has landed. A failing post-write probe must not be
    // reported as a failed save, or the UI would tell the user their change was lost.
    let broken = null;
    if (id && input.action !== 'delete') {
      try { broken = (await ctx.agentPresets.resolve(id))?.broken ?? null; }
      catch (error) { broken = String(error?.message ?? error); }
    }
    return { saved: true, deleted: input.action === 'delete', id, broken };
  };

  return {
    get, owned, coordinate, mutateUncoordinated: mutateInner,
    /**
     * Validate a definition mutation without writing it. Used to refuse a request
     * before any part is persisted; the real write still re-checks the revision
     * inside configEditor.edit, so this cannot make a race safe on its own.
     */
    async plan(input) {
      const entry = group();
      const roster = (await ctx.agentPresets.remoteExportList()).presets;
      const usage = ctx.agents.list().map(agent => ctx.agentPresets.composedPreset(agent.ctx)).filter(Boolean);
      mutateDefinitions(entry.options.config, input, { roleEntry, roster, usage });
      return true;
    },
    mutate(input) { return coordinate(() => mutateInner(input)); },
    async state() {
      const entry = group();
      const definitions = definitionsFrom(entry.options.config);
      const roster = (await ctx.agentPresets.remoteExportList()).presets;
      return {
        revision: revisionOf(entry.options.config),
        definitions: definitions.map(definition => ({ ...definition, ...previewDefinition(definition), rolePrompt: definition.prompt, prompt: definition.prompt, tools: previewDefinition(definition).tools })),
        templates: TEMPLATES,
        external: roster.filter(preset => !definitions.some(definition => definition.id === preset.id)),
      };
    },
  };
}

export function registerManagementApi(ctx, ops, history, storageNote = () => null) {
  const send = (res, code, value) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); };
  const route = (path, method, fn) => ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/api/preset-dispatch/' + path, handler: async (req, res) => { try { gate(req, method, ctx.connection); await fn(req, res); } catch (e) { send(res, 400, { error: String(e.message ?? e) }); } } }), 'agent management ' + path);
  const readBody = async req => { let text = ''; for await (const chunk of req) { text += chunk; if (Buffer.byteLength(text) > 65536) throw new Error('Request too large'); } return JSON.parse(text); };
  // `storageError` is reported, not hidden: the dialog can say that history is in memory
  // only, instead of leaving the operator to wonder why runs disappear after a restart.
  const withStorage = payload => ({ ...payload, storageError: storageNote() ?? null });
  route('presets', 'GET', async (_req, res) => send(res, 200, await ops.state()));
  // The definition-only write route was retired: it could create or change a preset
  // without configuring its dispatch policy, which is exactly how a leftover policy
  // could come back into effect. All writes go through the unified save endpoint.
  route('history', 'GET', async (_req, res) => send(res, 200, withStorage({ runs: history.list() })));
  // Filtered and paginated view for the history dialog. A separate path keeps the plain
  // GET above unchanged for existing callers.
  route('history/query', 'POST', async (req, res) => send(res, 200, withStorage(history.query(await readBody(req)))));
}
