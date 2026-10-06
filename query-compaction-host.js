// Host wiring for the "already used query" compaction (phase C, C12).
//
// `query-compaction.js` is pure: it knows nothing about sessions being created, events arriving or
// pre-step boundaries. This module owns exactly those three jobs and nothing else:
//   1. build one query state per SESSION OBJECT (header + fork inherited prefix), catching up the
//      already-recorded events exactly once,
//   2. fold every later committed event into that state,
//   3. at an admitted `agent/pre-step` boundary, ask the pure module for candidates and compact them.
//
// The official safe pattern (dsh-compaction-basic) is reproduced literally: the pre-step hook does
// its work first, turns every failure into `logger.warn`, and finishes with `return next()` so the
// turn decision the Host builds is returned whole and a compaction problem can never break a turn.
//
// Everything is closed by default. `enabled` is read live on every boundary, a missing token meter
// or an aborted signal only returns a report, and the per-session cache is keyed by the session
// object (WeakMap), so a finished session is never held alive by an id string.
//
// Frozen contract:
//   createQueryCompaction({ enabled, tokenMeter, logger })
//     -> { stateOf(session), fold(session, event), compact(agent, signal) }
//   registerQueryCompaction(ctx, { enabled, tokenMeter, logger }) -> disposer

import { createQueryState, reduceQueryState, compressionCandidates, compactQuery } from './query-compaction.js?stable';

/** The disabled report. Returned whenever compaction is off or the boundary lacks its inputs. */
function disabledReport() {
  return { disabled: true, checked: 0, replaced: 0, skipped: 0, failed: 0 };
}

/** An empty report for an enabled run that inspected nothing. */
function emptyReport() {
  return { checked: 0, replaced: 0, skipped: 0, failed: 0 };
}

/** A short, JSON-safe reason string for a caught failure. */
function reasonOf(error) {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return message === '' ? 'unknown error' : message;
}

/**
 * Normalize the `enabled` option to a zero-argument predicate. A plain boolean is accepted so a
 * test can pass `{ enabled: true }` literally; a function is accepted so the Host can read the live
 * configuration value on every boundary, which is how the real plugin stays switchable at runtime.
 */
function enabledPredicate(enabled) {
  if (typeof enabled === 'function') return enabled;
  const fixed = enabled === true;
  return () => fixed;
}

/** Register a listener, preferring the global option and falling back to a plain registration. */
function listen(on, event, listener) {
  try { return on(event, listener, { global: true }); }
  catch { return on(event, listener); }
}

/**
 * Create the per-session query-state owner plus the boundary action.
 *
 * `stateOf` builds the state on first sight of a session and folds the events already on record
 * (`snapshotEvents(inheritedEventCount)`), so a fork's inherited prefix is counted by the cut but
 * never folded twice. `fold` only ever advances a state that already exists: a missing state means
 * the catch-up fold will cover the event, so folding first would double count it.
 */
export function createQueryCompaction({ enabled, tokenMeter, logger } = {}) {
  const isEnabled = enabledPredicate(enabled);
  const states = new WeakMap();
  const warn = message => { if (typeof logger?.warn === 'function') logger.warn(message); };

  /** The query state of one session, created and caught up on first use. */
  const stateOf = session => {
    if (session === null || typeof session !== 'object') return null;
    const known = states.get(session);
    if (known !== undefined) return known;
    let state;
    try {
      const inherited = Number.isSafeInteger(session.inheritedEventCount) ? session.inheritedEventCount : 0;
      state = createQueryState(session.header, inherited);
      const recorded = typeof session.snapshotEvents === 'function' ? session.snapshotEvents(inherited) : [];
      for (const event of recorded ?? []) state = reduceQueryState(state, event);
    } catch (error) {
      // An unreadable log must not break the turn: the state stays empty, so nothing is compacted
      // for this session and the reason is reported rather than thrown at the boundary.
      warn('preset-dispatch: 查询压缩状态追赶失败（' + reasonOf(error) + '）');
      state = createQueryState(session?.header, 0);
    }
    states.set(session, state);
    return state;
  };

  /**
   * Fold one committed event into an existing state. A pure forward to `reduceQueryState`: the
   * event is handed over unchanged and whatever it returns becomes the cached state (the pure
   * reducer returns its own input when the event carries none of the facts it tracks).
   */
  const fold = (session, event) => {
    if (session === null || typeof session !== 'object' || event === null || typeof event !== 'object') return;
    const current = states.get(session);
    if (current === undefined) return;
    states.set(session, reduceQueryState(current, event));
  };

  /**
   * One `agent/pre-step` boundary. Returns a JSON-serializable report and never throws: every
   * refusal is a report, and one failed candidate only counts as failed without stopping the rest.
   */
  const compact = (agent, signal) => {
    try {
      if (isEnabled() !== true) return disabledReport();
      if (signal?.aborted === true) return emptyReport();
      if (typeof tokenMeter?.estimateMessage !== 'function') return emptyReport();
      const session = agent?.session;
      if (session === null || typeof session !== 'object') return emptyReport();
      const report = emptyReport();
      for (const candidate of compressionCandidates(stateOf(session), session) ?? []) {
        report.checked += 1;
        let result;
        try {
          // compactQuery itself returns a plain result object and never throws; the try is here so
          // an unexpected host capability failure is still counted instead of escaping the boundary.
          result = compactQuery(session, candidate, { enabled: true, tokenMeter, signal });
        } catch (error) {
          report.failed += 1;
          warn('preset-dispatch: 查询压缩候选失败（' + reasonOf(error) + '）');
          continue;
        }
        const status = result?.status;
        if (status === 'replaced') report.replaced += 1;
        else if (status === 'skipped') report.skipped += 1;
        else if (status === 'disabled') report.skipped += 1;
        else report.failed += 1;
      }
      return report;
    } catch (error) {
      // Belt and braces above the per-candidate guard: a report is still returned, because the
      // caller is a pre-step hook that must never surface an exception.
      warn('preset-dispatch: 查询压缩失败（' + reasonOf(error) + '）');
      return emptyReport();
    }
  };

  return { stateOf, fold, compact };
}

/**
 * Register the two listeners and return one disposer that releases both.
 *
 * The pre-step listener keeps the official shape: work first, warn on any failure, `return next()`
 * last so the decision object the Host built is returned whole. The event listener uses the same
 * registration as the existing observation feed (`{ global: true }` first, plain fallback),
 * because a child session's context is not this plugin's context.
 */
export function registerQueryCompaction(ctx, options = {}) {
  const controller = createQueryCompaction(options);
  const { logger } = options;
  const warn = message => { if (typeof logger?.warn === 'function') logger.warn(message); };
  const offs = [];
  let disposed = false;

  if (typeof ctx?.on === 'function') {
    // `listen` expects the `on` method itself; handing it `ctx` would call the context object as a
    // function. Bind the method so both the global attempt and the plain fallback reach `ctx.on`.
    const on = ctx.on.bind(ctx);
    try {
      offs.push(listen(on, 'agent/pre-step', async ({ agent, signal } = {}, next) => {
        try { controller.compact(agent, signal); }
        catch (error) { warn('preset-dispatch: 查询压缩失败（' + reasonOf(error) + '）；继续该回合'); }
        return next();
      }));
    } catch (error) {
      warn('preset-dispatch: 查询压缩 pre-step 监听未注册（' + reasonOf(error) + '）');
    }
    try {
      offs.push(listen(on, 'session/event', (session, event) => { controller.fold(session, event); }));
    } catch (error) {
      warn('preset-dispatch: 查询压缩事件监听未注册（' + reasonOf(error) + '）');
    }
  }

  return () => {
    if (disposed) return;
    disposed = true;
    for (const off of offs) {
      if (typeof off !== 'function') continue;
      try { off(); } catch { /* a disposer that already ran is not a failure */ }
    }
  };
}
