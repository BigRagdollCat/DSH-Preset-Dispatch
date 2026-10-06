// Read-only visibility face for dispatch runs (docs/08 V05-V10, docs/09 T04/T07).
//
// The card and the subagent badge need the CURRENT state of one dispatch run
// without asking the model, without a periodic HTTP poll and without reading
// another session's log. This module therefore serves metadata that the dispatch
// itself already recorded, and it pushes a new frame only when that record
// changes:
//
//   GET /api/preset-dispatch/visibility?callId=...|childSessionId=...&parentSession=...
//   → text/event-stream, one `snapshot` frame per change, plus `pending` while
//     nothing is recorded yet.
//
// Three rules the code below enforces rather than documents:
//   1. every request passes the same operator gate as the settings API;
//   2. a row is only served when its parent/child relationship matches the
//      caller's stated session — an unrelated id is never looked up;
//   3. only metadata leaves the process. No task text, no answers, no keys.
import { gate } from './settings-api.js?stable';
import { observationSummary, planRouting, routeOf } from './dispatch-observation.js?stable';

/** Longest accepted session/call identifier in a query parameter. */
export const MAX_ID_LENGTH = 200;
const STREAM_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-store',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
};
const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
/**
 * The statuses that mean a dispatch will not change again. This is the same vocabulary the client
 * closes its own stream on, so the server and the card agree on when a run is over.
 */
const SETTLED_STATUSES = new Set(['completed', 'failed', 'aborted', 'interrupted', 'killed']);

/**
 * Read the three query parameters. `callId` or `childSessionId` must be present
 * — the endpoint is a lookup, not a listing — and every value is bounded so a
 * malformed or oversized request is refused before any record is touched.
 */
export function parseVisibilityQuery(input) {
  let url;
  try { url = input instanceof URL ? input : new URL(String(input), 'http://127.0.0.1'); }
  catch { return { error: 'invalid request url' }; }
  const read = key => {
    const raw = url.searchParams.get(key);
    if (raw === null) return null;
    const value = raw.trim();
    if (value === '') return { error: `empty ${key}` };
    if (value.length > MAX_ID_LENGTH) return { error: `${key} is too long` };
    return value;
  };
  const out = {};
  for (const key of ['callId', 'childSessionId', 'parentSession']) {
    const value = read(key);
    if (value !== null && typeof value === 'object') return value;
    out[key] = value;
  }
  if (!out.callId && !out.childSessionId) return { error: 'callId or childSessionId is required' };
  return out;
}

/** The metadata-only payload for one history row. Never carries task or answer text. */
export function visibilityPayload(row, { live = null, restored = false } = {}) {
  // A live ticket is authoritative for this run whenever one exists, even before it has observed
  // anything: its empty observation means "no actual request seen yet", so the row's older
  // historical value must not be presented as this dispatch's actual configuration. Only a record
  // with no live ticket at all falls back to its own persisted observation.
  const observation = live?.observation ?? null;
  const summary = observationSummary(observation, { restored });
  const planned = observation === null
    ? (row?.plannedRouting && typeof row.plannedRouting === 'object' ? planRouting(row.plannedRouting) : null)
    : summary.planned;
  const observed = observation === null
    ? (row?.observedRouting && typeof row.observedRouting === 'object' ? routeOf(row.observedRouting) : null)
    : summary.observed;
  const verified = observation === null ? observed !== null : summary.verified;
  return {
    id: row?.id ?? null,
    preset: row?.preset ?? null,
    presetName: row?.presetName ?? null,
    presetVersion: row?.presetVersion ?? null,
    status: row?.status ?? 'running',
    observationStatus: observation?.state ?? row?.observationState ?? 'pending',
    callId: row?.callId ?? null,
    rootCallId: row?.rootCallId ?? null,
    parentSession: row?.parentSession ?? null,
    childSessionId: row?.childSessionId ?? live?.childSessionId ?? null,
    startedAt: row?.startedAt ?? null,
    finishedAt: row?.finishedAt ?? null,
    planned,
    observed,
    verified,
    observedEffortSource: summary.observedEffortSource ?? 'unknown',
    changes: summary.changes ?? [],
    verification: summary.verification ?? (verified ? '实际请求（已核实）' : (restored ? '历史配置，未核实实际请求' : '计划配置，尚未观察到实际请求')),
    verificationDetail: summary.detail || '',
    restored: restored === true,
  };
}

/**
 * Resolve one request against the dispatch history.
 *
 * `row` is required: without a record there is nothing this plugin may show, so
 * the answer is `pending` (never a bare 404, which an EventSource would treat as
 * a reconnect loop).
 *
 * The lookup is exact in both directions. A row is only reachable through an
 * identifier it actually records — a query naming an id the row holds as `null`
 * is not that row — and every identifier the query states must agree with the
 * record, so an unrelated caller cannot reach a dispatch by naming a different
 * call, a different child, or another session's parent.
 *
 * A row that records a parent is bound to it: the query must state that same
 * parent, so naming only a call id or only a child id cannot expose the row to a
 * caller that does not identify the dispatching session. The binding is one-way
 * on purpose — a row without a parent (an older record, or a dispatch that never
 * knew one) stays reachable without a stated parent, because turning the absence
 * of a column into a refusal would make such a record unreadable forever.
 */
export function resolveVisibility(query, { history, liveFor = () => null, sessions = () => null, restored = false } = {}) {
  const rows = history?.list ? history.list() : [];
  const row = rows.find(candidate => (query.callId !== null && candidate.callId === query.callId)
    || (query.childSessionId !== null && candidate.childSessionId === query.childSessionId)) ?? null;
  if (!row) {
    // Honest absence: the run may be starting (the row is written before the child
    // exists) or the id may be unknown. Both render as pending, never as a fact.
    return { kind: 'pending', payload: { pending: true, callId: query.callId, childSessionId: query.childSessionId, parentSession: query.parentSession, verified: false } };
  }
  if (query.callId !== null && row.callId !== query.callId) return { kind: 'mismatch' };
  if (query.childSessionId !== null && row.childSessionId !== query.childSessionId) return { kind: 'mismatch' };
  if (query.parentSession !== null && row.parentSession !== query.parentSession) return { kind: 'mismatch' };
  // A row that records a parent is only served to a caller that states it. The reverse case is
  // not symmetric: a row without a parent column must not become unreachable just because the
  // caller named one, so only a recorded parent can demand a stated one. An empty column counts
  // as "no parent recorded" — it is not a session id a query could ever match.
  const recordedParent = row.parentSession;
  if (recordedParent !== null && recordedParent !== undefined && recordedParent !== '' && query.parentSession === null) return { kind: 'mismatch' };
  const childSessionId = row.childSessionId ?? null;
  const session = childSessionId === null ? null : sessions(childSessionId);
  // The child's own header is the authority on its parent, so it is checked whenever either side
  // states a parent. When neither does, there is no stated relationship left to contradict.
  const statedParent = query.parentSession ?? row.parentSession ?? null;
  if (session && statedParent !== null && session.header?.parentSession !== statedParent) return { kind: 'mismatch' };
  return { kind: 'row', payload: visibilityPayload(row, { live: liveFor(row), restored }) };
}

/**
 * Register the SSE route. The response owns its lifecycle: the subscription and
 * every listener are released when the client disconnects or the plugin unloads,
 * and the plugin's own lifetime signal closes every open stream.
 */
export function registerVisibilityApi(ctx, { history, liveFor = () => null, sessions = () => null, lifetime = null, restored = false }) {
  if (!history || typeof history.subscribe !== 'function') return null;
  // This route opens its own lifetime signal, linked to the caller's when one is supplied. A
  // plugin that passes nothing still gets a signal that closes every open stream when the
  // route's disposer runs, so unloading can never leave a live EventSource behind.
  const controller = new AbortController();
  const streams = new Set();
  const closeAll = () => { for (const stream of [...streams]) stream.close(); };
  const abort = () => closeAll();
  if (lifetime?.signal) {
    if (lifetime.signal.aborted) controller.abort();
    else lifetime.signal.addEventListener('abort', abort, { once: true });
  }
  const frame = (res, event, payload) => {
    try { res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`); } catch { /* the socket is already gone */ }
  };
  const handler = (req, res) => {
    try { gate(req, 'GET', ctx.connection); }
    catch (error) {
      res.writeHead(400, JSON_HEADERS);
      res.end(JSON.stringify({ error: String(error?.message ?? error) }));
      return;
    }
    const query = parseVisibilityQuery(req.url ?? '');
    if (query.error) {
      res.writeHead(400, JSON_HEADERS);
      res.end(JSON.stringify({ error: query.error }));
      return;
    }
    // An unloaded plugin must not serve a new stream at all, and must not subscribe to it.
    if (controller.signal.aborted) {
      res.writeHead(503, JSON_HEADERS);
      res.end(JSON.stringify({ error: 'the visibility route is closed' }));
      return;
    }
    const current = resolveVisibility(query, { history, liveFor, sessions, restored });
    if (current.kind === 'mismatch') {
      res.writeHead(403, JSON_HEADERS);
      res.end(JSON.stringify({ error: 'the requested session is not related to this dispatch record' }));
      return;
    }
    res.writeHead(200, STREAM_HEADERS);
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
    let closed = false;
    let unsubscribe = null;
    // The row this stream was resolved to. It is the only row whose change may be pushed here, so
    // one record's update can never be rendered as another record's frame.
    let boundRowId = current.kind === 'row' ? current.payload?.id ?? null : null;
    const stream = {
      close() {
        if (closed) return;
        closed = true;
        if (unsubscribe) { try { unsubscribe(); } catch { /* the subscription is already gone */ } unsubscribe = null; }
        streams.delete(stream);
        req.removeListener?.('close', stream.close);
        res.removeListener?.('close', stream.close);
        try { res.end(); } catch { /* the socket is already gone */ }
      },
    };
    streams.add(stream);
    req.on?.('close', stream.close);
    res.on?.('close', stream.close);
    /**
     * Push the current value of THIS stream's row.
     *
     * The record is resolved first, and the resolved row is what decides what happens next: an
     * update to another record is not this stream's news, so it is skipped without being resolved
     * and can never be rendered as this stream's frame.
     *
     * That filter is applied to the change itself, before any lookup: when the change carries an id
     * and this stream declared an identifier for its own run, a change whose identifiers do not
     * match the declaration is not this stream's news at all. It is dropped here — not resolved,
     * not pushed, not closed — because the only frame it could produce is the `pending` that has
     * already been written. This is what keeps the filter effective while the stream is still
     * waiting for its own record: at that point no row is bound yet, so a guard that compares
     * against the bound row cannot reject a foreign update by itself.
     *
     * A stream that has not shown a row yet is still waiting for its own record to appear. An
     * unrelated update must not be mistaken for that record, and must not close this stream either:
     * closing here would end a stream whose record has simply not been written yet. Only a stream
     * that HAS shown a row and whose record is now gone is closed, because it can no longer be
     * described truthfully.
     *
     * `kind` is the change the history announced. A settled run — announced as `finish`, or
     * reported with a status that means the run is over — is pushed as its terminal frame and then
     * closes this stream: the subscription and both close listeners are released, because a
     * finished dispatch can never have another change to report.
     */
    const emit = (changed, kind) => {
      if (closed) return;
      // Every identifier this stream declared must agree with the change. A change that disagrees is
      // another run's news: it is dropped here, before any lookup, so it can neither be framed nor
      // close this stream. This holds while nothing is bound yet — the state in which the bound-row
      // guard below cannot reject anything — which is exactly when an unrelated update would be
      // mistaken for this stream's own record and answered with a second `pending`.
      if (changed && typeof changed.id === 'string') {
        if (query.callId !== null && changed.callId !== query.callId) return;
        if (query.childSessionId !== null && changed.childSessionId !== query.childSessionId) return;
      }
      // The announced row is also compared against the row this stream already showed, so an update
      // that carries no identifier (or a query that declared none) is still filtered once bound.
      if (changed && typeof changed.id === 'string' && boundRowId !== null && changed.id !== boundRowId) return;
      const next = resolveVisibility(query, { history, liveFor, sessions, restored });
      if (next.kind === 'mismatch') { stream.close(); return; }
      if (next.kind === 'pending') {
        // Nothing is recorded for this lookup yet: report the wait and keep waiting.
        if (boundRowId === null) { frame(res, 'pending', next.payload); return; }
        stream.close();
        return;
      }
      const rowId = next.payload?.id ?? null;
      // A record that is not the one this stream already showed is never pushed here.
      if (boundRowId !== null && rowId !== boundRowId) return;
      boundRowId = rowId;
      frame(res, 'snapshot', next.payload);
      if (kind === 'finish' || SETTLED_STATUSES.has(next.payload?.status)) stream.close();
    };
    // The first frame is the current value; the subscription only exists to push
    // later changes, so nothing polls and no model request is ever involved.
    if (current.kind === 'pending') {
      frame(res, 'pending', current.payload);
    } else {
      boundRowId = current.payload?.id ?? null;
      frame(res, 'snapshot', current.payload);
      // A record that is already settled can never report another change, so this stream is over
      // the moment its first frame is written: nothing subscribes and nothing stays open.
      if (SETTLED_STATUSES.has(current.payload?.status)) { stream.close(); return; }
    }
    if (controller.signal.aborted) { stream.close(); return; }
    unsubscribe = history.subscribe(emit);
  };
  const disposer = ctx.webServer.register({ kind: 'exact', path: '/api/preset-dispatch/visibility', handler });
  return () => {
    closeAll();
    if (lifetime?.signal) lifetime.signal.removeEventListener('abort', abort);
    if (!controller.signal.aborted) controller.abort();
    if (typeof disposer === 'function') disposer();
  };
}
