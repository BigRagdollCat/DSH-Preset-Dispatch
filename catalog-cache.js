/**
 * Short-lived cache for the model catalog.
 *
 * The catalog is display data. Authorization is NEVER served from here: the Host model
 * pool and the preset policy are read live at save and dispatch time, so revoking a
 * model stops it being usable immediately rather than when this cache happens to expire.
 *
 * Two properties matter as much as the speed-up:
 *   - concurrent readers share one build, so opening the page twice does not double the
 *     provider round-trips;
 *   - a build that was superseded (invalidated, or replaced by a newer refresh) never
 *     becomes the cached value, so a slow older read cannot overwrite a newer result.
 */
export function createCatalogCache({ build, ttlMs = 30000, now = () => Date.now() }) {
  let entry = null;
  let inflight = null;
  let generation = 0;
  let lastError = null;

  const age = () => (entry ? now() - entry.fetchedAt : null);
  const fresh = () => entry !== null && age() < ttlMs;

  const start = () => {
    const mine = ++generation;
    const controller = new AbortController();
    // Start the work now rather than on a later microtask: a read that begins should
    // begin its round-trip immediately, and callers can observe the build as in-flight.
    let produced;
    try { produced = build(controller.signal); } catch (error) { produced = Promise.reject(error); }
    const task = Promise.resolve(produced)
      .then(value => {
        if (mine === generation) { entry = { value, fetchedAt: now() }; lastError = null; }
        return value;
      })
      .catch(error => {
        lastError = String(error?.message ?? error);
        // Keep the last good catalog rather than emptying the list: one unreachable
        // provider, or one failed refresh, must not blank what the user can still see.
        if (entry) return entry.value;
        throw error;
      })
      .finally(() => { if (inflight && inflight.task === task) inflight = null; });
    inflight = { task, controller };
    return task;
  };

  // A caller giving up must not cancel the shared build for everyone else.
  const guard = (task, signal) => {
    if (!signal) return task;
    if (signal.aborted) return Promise.reject(signal.reason ?? new Error('catalog read aborted'));
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(signal.reason ?? new Error('catalog read aborted'));
      signal.addEventListener('abort', onAbort, { once: true });
      const settle = action => value => { signal.removeEventListener('abort', onAbort); action(value); };
      task.then(settle(resolve), settle(reject));
    });
  };

  return {
    async read({ signal, force = false } = {}) {
      if (force) return await guard(start(), signal);
      if (fresh()) return entry.value;
      if (inflight) return await guard(inflight.task, signal);
      return await guard(start(), signal);
    },
    /** Drop the cached value. An in-flight build is not cancelled — callers already
     *  waiting on it still get their answer — but it is no longer the build a new read
     *  joins, so a read after an invalidation never receives pre-invalidation data. */
    invalidate() { generation += 1; entry = null; inflight = null; },
    /** Manual refresh: rebuild now and coalesce anyone else who asks while it runs. */
    refresh(options = {}) { return this.read({ ...options, force: true }); },
    status() {
      const current = age();
      return {
        cached: entry !== null, ageMs: current, ttlMs,
        stale: entry === null || current >= ttlMs || lastError !== null,
        error: lastError,
        building: inflight !== null,
      };
    },
  };
}
