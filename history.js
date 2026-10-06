const fields = ['id', 'preset', 'role', 'provider', 'model', 'depth', 'parentSession', 'reasoningEffort', 'modelSource', 'effortSource', 'presetVersion', 'policySnapshot'];

/**
 * Fields a dispatch lifecycle may ADD or CORRECT after `begin`, together with the
 * value type each one accepts. They are deliberately separate from `fields`:
 * `begin` writes the plan once, and everything that can only be learned later —
 * the child session id, the observed routing, the observation state — arrives
 * through `update`, so a record is never rewritten wholesale.
 *
 * The list is a whitelist, not a suggestion: an unknown key, or a value of the
 * wrong type, is refused instead of being stored. A type mismatch here would
 * otherwise surface as a corrupt durable row after a restart.
 *
 * A correlation identifier must be a real value, not a blank one: whitespace-only
 * text is refused like an empty string, because a row whose `catalogId` is "   "
 * would look correlated while matching nothing.
 */
const identifier = value => typeof value === 'string' && value.trim() !== '';

export const UPDATABLE_FIELDS = {
  childSessionId: identifier,
  callId: identifier,
  rootCallId: identifier,
  catalogId: identifier,
  presetName: value => typeof value === 'string' && value !== '',
  presetVersion: value => value === null || Number.isSafeInteger(value),
  plannedRouting: value => typeof value === 'object' && value !== null && !Array.isArray(value),
  observedRouting: value => value === null || (typeof value === 'object' && !Array.isArray(value)),
  observationState: value => typeof value === 'string' && value !== '',
  // `status` is deliberately NOT updatable. It is written once by `begin` as `running` and can
  // only be settled by `finish`, which also records `finishedAt`; an update patch that could
  // set it would let a caller mark a run completed without an outcome.
  finishedAt: value => typeof value === 'string' && value !== '',
};

/** A record id that is unique across restarts, because the medium outlives the process. */
const newRunId = () => `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * Metadata-only dispatch history.
 *
 * `store` is an optional durable port (see history-store.js). It is written through on
 * every change and read once at activation. Its failures are captured, never thrown:
 * losing a history record must not break dispatching.
 *
 * `subscribe(listener)` reports every change with the stored row and the kind of
 * change (`begin`, `update`, `finish`, `restore`, `clear`). It is how the visibility
 * API pushes a frame without polling: the listener only runs when a record really
 * moved, and it is removed by the caller's disposer.
 */
export function createHistory(limit = 50, store = null) {
  limit = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 100) : 50;
  const runs = [];
  const listeners = new Set();
  let storageError = null;
  let restoredAt = null;
  const note = error => { storageError = String(error?.message ?? error); };
  const persist = work => { if (store) Promise.resolve().then(work).catch(note); };
  // A subscriber that throws must not break the record it was told about, and must
  // not stop the other subscribers from hearing it.
  const announce = (row, kind) => {
    for (const listener of [...listeners]) {
      try { listener(row, kind); } catch { /* a failing observer is contained */ }
    }
  };

  return {
    begin(data) {
      const metadata = Object.fromEntries(fields.filter(key => data[key] !== undefined).map(key => [key, structuredClone(data[key])]));
      // Fields that only a later stage can know are accepted at begin too, so a
      // caller that already holds them does not need a second write.
      const extra = Object.fromEntries(Object.keys(UPDATABLE_FIELDS)
        .filter(key => data[key] !== undefined && UPDATABLE_FIELDS[key](data[key]))
        .map(key => [key, structuredClone(data[key])]));
      // The id is the record's address in the medium: `put` keys on it and `remove`/`restore`
      // look records up by it. Without one, a real medium stores the record under the literal
      // key "undefined" and it can never be addressed again.
      const row = { id: newRunId(), ...metadata, ...extra, startedAt: new Date().toISOString(), status: 'running' };
      runs.unshift(row);
      while (runs.length > limit) {
        const dropped = runs.pop();
        persist(() => store.remove(dropped.id));
      }
      persist(() => store.put(row));
      announce(row, 'begin');
      return row;
    },
    /**
     * Correct or extend one stored record. Only declared fields with a matching
     * type are applied; the rest of the patch is ignored rather than written.
     * @returns the applied field names, so a caller can tell a no-op from a write.
     */
    update(row, patch = {}) {
      if (!row || typeof row !== 'object') return [];
      const applied = [];
      for (const [key, value] of Object.entries(patch)) {
        const accepts = UPDATABLE_FIELDS[key];
        if (!accepts || value === undefined || !accepts(value)) continue;
        row[key] = structuredClone(value);
        applied.push(key);
      }
      if (!applied.length) return applied;
      persist(() => store.put(row));
      announce(row, 'update');
      return applied;
    },
    finish(row, status, childSessionId) {
      Object.assign(row, { status, finishedAt: new Date().toISOString(), ...(childSessionId ? { childSessionId } : {}) });
      persist(() => store.put(row));
      announce(row, 'finish');
    },
    list() { return runs.map(run => structuredClone(run)); },
    /**
     * The INTERNAL row for one record id, or null. This is not a read API: it deliberately
     * returns the stored object rather than a copy, so this plugin's own writer can correct a
     * live record (`history.update(row, ...)`) instead of editing a clone that nobody keeps.
     * Every other reader — `list()`, `query()` and the management API built on them — must keep
     * receiving clones; a caller can easily forget which one it holds, so a clone handed to an
     * outside reader is the difference between a correction and a silent no-op.
     */
    get(id) {
      if (typeof id !== 'string' || id === '') return null;
      return runs.find(run => run.id === id) ?? null;
    },
    /**
     * Filtered, paginated view for the history dialog; `list()` keeps its array contract.
     * The identifier filters exist for the visibility API, which must find one run by
     * the id a UI holds rather than by position in the list.
     */
    query(filter = {}) {
      const matched = runs.filter(run => (!filter.preset || run.preset === filter.preset)
        && (!filter.status || run.status === filter.status)
        && (!filter.callId || run.callId === filter.callId)
        && (!filter.childSessionId || run.childSessionId === filter.childSessionId)
        && (!filter.parentSession || run.parentSession === filter.parentSession));
      const offset = Number.isSafeInteger(filter.offset) && filter.offset > 0 ? filter.offset : 0;
      const size = Number.isSafeInteger(filter.limit) && filter.limit > 0 ? Math.min(filter.limit, 200) : matched.length;
      return { total: matched.length, offset, runs: matched.slice(offset, offset + size).map(run => structuredClone(run)) };
    },
    /** Observe every record change. The returned disposer is the only way to stop it. */
    subscribe(listener) {
      if (typeof listener !== 'function') return () => {};
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    /**
     * Seed from the medium. A run still marked `running` cannot be traced after a restart:
     * it is reported as interrupted rather than presented as if it were still going.
     * A restored record keeps whatever it stored and is never given an observed value
     * it did not have; the UI labels it as unverified.
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
        restoredAt = new Date().toISOString();
        announce(null, 'restore');
        return { restored: runs.length, interrupted };
      } catch (error) { note(error); return { restored: 0, interrupted: 0 }; }
    },
    async clear() {
      runs.length = 0;
      if (store) { try { await store.clear(); } catch (error) { note(error); } }
      announce(null, 'clear');
    },
    /** When the durable history was seeded, or null while this process has not restored. */
    restoredAt() { return restoredAt; },
    storageError() { return storageError; },
  };
}
