const fields = ['id', 'preset', 'role', 'provider', 'model', 'depth', 'parentSession', 'reasoningEffort', 'modelSource', 'effortSource', 'presetVersion', 'policySnapshot'];

/** A record id that is unique across restarts, because the medium outlives the process. */
const newRunId = () => `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * Metadata-only dispatch history.
 *
 * `store` is an optional durable port (see history-store.js). It is written through on
 * every change and read once at activation. Its failures are captured, never thrown:
 * losing a history record must not break dispatching.
 */
export function createHistory(limit = 50, store = null) {
  limit = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 100) : 50;
  const runs = [];
  let storageError = null;
  const note = error => { storageError = String(error?.message ?? error); };
  const persist = work => { if (store) Promise.resolve().then(work).catch(note); };

  return {
    begin(data) {
      const metadata = Object.fromEntries(fields.filter(key => data[key] !== undefined).map(key => [key, structuredClone(data[key])]));
      // The id is the record's address in the medium: `put` keys on it and `remove`/`restore`
      // look records up by it. Without one, a real medium stores the record under the literal
      // key "undefined" and it can never be addressed again.
      const row = { id: newRunId(), ...metadata, startedAt: new Date().toISOString(), status: 'running' };
      runs.unshift(row);
      while (runs.length > limit) {
        const dropped = runs.pop();
        persist(() => store.remove(dropped.id));
      }
      persist(() => store.put(row));
      return row;
    },
    finish(row, status, childSessionId) {
      Object.assign(row, { status, finishedAt: new Date().toISOString(), ...(childSessionId ? { childSessionId } : {}) });
      persist(() => store.put(row));
    },
    list() { return runs.map(run => structuredClone(run)); },
    /** Filtered, paginated view for the history dialog; `list()` keeps its array contract. */
    query(filter = {}) {
      const matched = runs.filter(run => (!filter.preset || run.preset === filter.preset) && (!filter.status || run.status === filter.status));
      const offset = Number.isSafeInteger(filter.offset) && filter.offset > 0 ? filter.offset : 0;
      const size = Number.isSafeInteger(filter.limit) && filter.limit > 0 ? Math.min(filter.limit, 200) : matched.length;
      return { total: matched.length, offset, runs: matched.slice(offset, offset + size).map(run => structuredClone(run)) };
    },
    /**
     * Seed from the medium. A run still marked `running` cannot be traced after a restart:
     * it is reported as interrupted rather than presented as if it were still going.
     */
    async restore() {
      if (!store) return { restored: 0, interrupted: 0 };
      try {
        const loaded = await store.load();
        const sorted = [...loaded].sort((a, b) => String(b.startedAt ?? '').localeCompare(String(a.startedAt ?? '')));
        runs.length = 0;
        let interrupted = 0;
        for (const row of sorted.slice(0, limit)) {
          if (row.status === 'running') {
            row.status = 'interrupted';
            row.finishedAt = row.finishedAt ?? new Date().toISOString();
            interrupted++;
            await store.put(row).catch(note);
          }
          runs.push(row);
        }
        return { restored: runs.length, interrupted };
      } catch (error) { note(error); return { restored: 0, interrupted: 0 }; }
    },
    async clear() {
      runs.length = 0;
      if (store) { try { await store.clear(); } catch (error) { note(error); } }
    },
    storageError() { return storageError; },
  };
}
