// Phase C of docs/08 (C04-C11) and docs/09 (T08/T09): the "already used query" compaction lifecycle.
//
// This module is pure and host-agnostic on purpose: it imports nothing, keeps no registry and no
// in-memory eligibility flag, and reads every fact back from the recorded session events plus the
// session's own current surface. A restart, a fork, a branch or an official compaction therefore
// cannot make it replace the same query twice or associate a dispatch with the wrong query.
//
// Frozen contract:
//   createQueryState(header, inheritedEventCount = 0) -> { parentId, cut, queries, ... }
//   reduceQueryState(state, event)                    -> pure incremental fold (same ref when inert)
//   compressionCandidates(state, session)             -> [{ catalogId, querySeq, callId }]
//   compactQuery(session, candidate, { enabled, tokenMeter, signal })
//                                                     -> { status, reason?, replacementSeq? }
//   with status one of 'disabled' | 'skipped' | 'replaced' | 'failed'. `compactQuery` returns a
//   plain JSON result object synchronously (awaiting it is harmless); the prune and its replacement
//   are appended back to back with no await between them.
//
// The gates this file implements:
//  - Only a successful COMPACT `preset_list` answer is a tracked query. Its result content must be a
//    single text block whose JSON carries catalog.marker 'preset-dispatch/catalog', formatVersion 1,
//    mode 'compact', sessionBound true, authorizationTicket false and a non-empty top-level
//    catalogId. Diagnostic answers, tool errors, unknown content shapes and unbound/no-agent answers
//    are never tracked, so they can never become candidates.
//  - A tracked query is a candidate only once a dispatch result that explicitly carries that
//    catalogId proved it was read. The dispatch is trusted only if `subagent/catalog` (the parent's
//    own directory entry) names exactly that child session id; the label is never used as identity.
//    Every dispatch carrying the catalogId must be a settled success (status 'completed', not an
//    error result), from a strictly later (turn, step), with a matching 'preset-dispatch/run' meta
//    envelope whose callId agrees with the tool result it came from and whose observationState is
//    'observed' or 'finished' with a non-empty observedRouting — the envelope must prove a committed
//    actual request, so a background answer returned before the child existed proves nothing. A
//    failed, cancelled, still-running, unreadable, observation-less or same-step association blocks
//    the whole query rather than being ignored, and a dispatch call that names the catalogId but has
//    produced no result yet blocks it too; it only blocks the queries bound to that catalogId.
//  - A candidate must still be the current model-visible node: its seq is on the session surface,
//    its event is still the same tool/result for the same call and the same catalogId, and the
//    replacement text is genuinely shorter than the answer it replaces. Anything else is skipped.
//  - Compaction is closed unless `{ enabled: true }` is passed. A missing token meter, an aborted
//    signal, a missing surface or an unpriceable message only skips, never fails. A refused append
//    is reported as `failed` (never thrown): the bare prune remains the detectable trace of the
//    interrupted pair, the original node stays model-visible, and a retry re-appends a complete pair
//    for the still-current original seq so the shadow price is deducted exactly once.
//
// Wiring still required outside this module (not part of this scope): host.js must create one state
// per session (session header plus the fork's inherited event count), fold every appended event into
// it, and call compactQuery at an admitted `agent/pre-step` boundary with the compression flag,
// ctx.tokenMeter and a signal. `package.json` "files" already lists this module.

/** Marker of the compact preset_list catalog answer this module may compact. */
const CATALOG_MARKER = 'preset-dispatch/catalog';
/** Marker of the dispatch run envelope that proves a later associated dispatch. */
const RUN_MARKER = 'preset-dispatch/run';
/** The only envelope format this module understands; another version is treated as unknown. */
const FORMAT_VERSION = 1;
/** The tool call that produces a catalog answer. */
const QUERY_TOOL = 'preset_list';
/** The tool call that dispatches a subagent and is correlated by catalogId. */
const DISPATCH_TOOL = 'preset_dispatch';
/** The parent session's direct-child directory event. */
const CATALOG_EVENT = 'subagent/catalog';
/**
 * The observation states that prove a child committed an actual request. `created` is not one of
 * them: a child that exists has not necessarily issued a request, so a dispatch envelope that only
 * reached `created` (whatever its tool result says) proves the query was correlated, not read.
 */
const OBSERVED_STATES = new Set(['observed', 'finished']);

/**
 * The compacted replacement text. It records that the catalog was already read and compressed, says
 * a fresh query is needed before choosing again, and keeps the standing boundaries, while
 * republishing no route, model, effort or pool from the original answer: a later reader must not
 * mistake a used query for current authorization.
 */
const COMPACTED_QUERY_SUMMARY = '目录查询已使用并压缩：需要再次选择角色或路由时，请重新调用 preset_list 查询当前规则。主代理负责最终验收，不得绕过授权或拒绝。';

/** Whether a value is a JSON object (not null, not an array). */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A non-empty string id, or null. */
function asId(value) {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** A finite safe-integer order component, or null. */
function asOrder(value) {
  return Number.isSafeInteger(value) ? value : null;
}

/** Total model-visible text length of a message content array. */
function textChars(content) {
  if (!Array.isArray(content)) return 0;
  return content.reduce((sum, block) => sum + (isRecord(block) && typeof block.text === 'string' ? block.text.length : 0), 0);
}

/** JSON serialized length, or 0 when the value cannot be serialized. */
function jsonChars(value) {
  try {
    const text = JSON.stringify(value);
    return typeof text === 'string' ? text.length : 0;
  } catch {
    return 0;
  }
}

/** A short, JSON-safe reason string for a caught failure. */
function reasonOf(error) {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return message === '' ? 'unknown error' : message;
}

/**
 * Read the compact catalog answer carried by one tool/result event.
 * Returns { catalogId, parentSessionId, callId } only for a well-formed, session-bound, non-ticket
 * compact answer; every other shape (diagnostic mode, error result, multi-block or non-JSON content,
 * missing marker/version/id, unbound or ticket-carrying catalog) returns null so the caller tracks
 * nothing it cannot prove.
 */
function readCatalogAnswer(event) {
  if (!isRecord(event) || event.type !== 'tool/result') return null;
  const data = event.data;
  if (!isRecord(data) || data.error !== undefined) return null;
  const message = data.message;
  if (!isRecord(message) || message.isError === true) return null;
  const content = message.content;
  if (!Array.isArray(content) || content.length !== 1) return null;
  const block = content[0];
  if (!isRecord(block) || block.type !== 'text' || typeof block.text !== 'string') return null;
  let answer;
  try {
    answer = JSON.parse(block.text);
  } catch {
    return null;
  }
  if (!isRecord(answer)) return null;
  const catalog = answer.catalog;
  if (!isRecord(catalog)) return null;
  if (catalog.marker !== CATALOG_MARKER) return null;
  if (catalog.formatVersion !== FORMAT_VERSION) return null;
  // The answer states its own mode: a diagnostic answer is never compacted, whatever asked for it.
  if (catalog.mode !== 'compact') return null;
  if (catalog.sessionBound !== true) return null;
  // A catalog id correlates records; it is never an authorization ticket, so an answer that claims
  // otherwise is not something this module will compact.
  if (catalog.authorizationTicket !== false) return null;
  const catalogId = asId(answer.catalogId);
  const parentSessionId = asId(catalog.parentSessionId);
  const callId = asId(message.source?.callId);
  if (catalogId === null || parentSessionId === null || callId === null) return null;
  return { catalogId, parentSessionId, callId };
}

/**
 * Read the dispatch run envelope. A missing envelope or a missing catalogId is not an error: it
 * simply cannot be linked, so the dispatch proves nothing. The remaining fields are compared
 * literally by the eligibility check instead of being repaired here.
 */
function readRunMeta(meta) {
  if (!isRecord(meta)) return null;
  const catalogId = asId(meta.catalogId);
  if (catalogId === null) return null;
  return {
    catalogId,
    marker: meta.marker === RUN_MARKER,
    formatVersion: meta.formatVersion === FORMAT_VERSION,
    status: typeof meta.status === 'string' ? meta.status : null,
    parentSessionId: asId(meta.parentSessionId),
    callId: asId(meta.callId),
    childSessionId: asId(meta.childSessionId),
    observationState: asId(meta.observationState),
    // Whether the envelope carries a non-empty observed routing object: the committed-request
    // evidence itself. Only its presence is recorded here; no route value is copied out, so
    // nothing this module reads can later be mistaken for current authorization.
    observedRouting: isRecord(meta.observedRouting) && Object.keys(meta.observedRouting).length > 0,
  };
}

/**
 * The catalogId a dispatch tool call names, or null when it names none.
 *
 * `arguments` is the raw, unparsed JSON string the model produced (`tool/call` data, see the host
 * schema), so a malformed or non-object payload simply names no catalog and is never repaired into
 * one. The caller stores the result on the call record, which is what lets the "a dispatch that
 * names this catalog and has produced no result yet blocks it" rule read it back later.
 */
function catalogIdOfCall(call) {
  const raw = call?.arguments;
  if (typeof raw !== 'string' || raw === '') return null;
  try {
    const parsed = JSON.parse(raw);
    return isRecord(parsed) ? asId(parsed.catalogId) : null;
  } catch {
    return null;
  }
}

/** Whether order `a` is strictly later than order `b` in (turn, step) terms. */
function isLaterOrder(a, b) {
  if (!Number.isSafeInteger(a.turn) || !Number.isSafeInteger(a.step)) return false;
  if (!Number.isSafeInteger(b.turn) || !Number.isSafeInteger(b.step)) return false;
  return a.turn > b.turn || (a.turn === b.turn && a.step > b.step);
}

/**
 * The current model-visible seqs of a session, or null when the session offers no surface. The
 * session's own surface is the only authority here: neither the log nor a remembered set can say
 * whether a node is still what the model sees.
 */
function readSurface(session) {
  const nodes = session?.surface?.nodes ?? session?.surfaceNodes;
  return Array.isArray(nodes) ? nodes : null;
}

/** The message an event derives to: the session's own projection, else the recorded message. */
function deriveMessage(session, event) {
  if (typeof session?.deriveEventMessage === 'function') {
    const derived = session.deriveEventMessage(event);
    if (isRecord(derived)) return derived;
  }
  return isRecord(event?.data?.message) ? event.data.message : null;
}

/**
 * The initial lifecycle state. `header.id` is the parent session binding; the fork cut is the
 * second argument (the number of inherited events), never a private field of the header.
 */
export function createQueryState(header, inheritedEventCount = 0) {
  return {
    parentId: asId(header?.id),
    cut: Number.isSafeInteger(inheritedEventCount) && inheritedEventCount > 0 ? inheritedEventCount : 0,
    calls: {},
    queries: [],
    dispatches: [],
    catalogChildren: {},
  };
}

/**
 * Fold one event into the lifecycle state. Pure and incremental: an event that carries none of the
 * facts this module tracks returns the very same state, and no input is ever mutated. Events of the
 * inherited fork prefix (`seq < cut`) are ignored, so a parent's used query is never compacted again
 * inside a child session.
 */
export function reduceQueryState(state, event) {
  if (!isRecord(state) || !isRecord(event)) return state;
  if (Number.isSafeInteger(event.seq) && event.seq < state.cut) return state;
  const data = event.data;
  if (!isRecord(data)) return state;

  if (event.type === 'tool/call') {
    if (data.name !== QUERY_TOOL && data.name !== DISPATCH_TOOL) return state;
    const callId = asId(data.callId);
    if (callId === null || Object.hasOwn(state.calls, callId)) return state;
    // The call's own arguments are folded in here, while the event is in hand: a later reader of
    // the call record cannot recover them, and without the catalogId the "names this catalog but
    // has produced no result yet" rule could never block anything.
    return {
      ...state,
      calls: {
        ...state.calls,
        [callId]: {
          name: data.name, seq: asOrder(event.seq), turn: asOrder(data.turn), step: asOrder(data.step),
          catalogId: data.name === DISPATCH_TOOL ? catalogIdOfCall(data) : null,
        },
      },
    };
  }

  if (event.type === 'tool/result') {
    const callId = asId(data.message?.source?.callId);
    const call = callId !== null && Object.hasOwn(state.calls, callId) ? state.calls[callId] : undefined;
    if (call === undefined) return state;
    const turn = asOrder(data.turn) ?? call.turn;
    const step = asOrder(data.step) ?? call.step;

    if (call.name === QUERY_TOOL) {
      const answer = readCatalogAnswer(event);
      if (answer === null) return state;
      const querySeq = asOrder(event.seq);
      if (querySeq === null) return state;
      return {
        ...state,
        queries: [...state.queries, { catalogId: answer.catalogId, callId: answer.callId, parentSessionId: answer.parentSessionId, querySeq, turn, step }],
      };
    }

    const meta = readRunMeta(data.meta);
    const message = data.message;
    return {
      ...state,
      dispatches: [...state.dispatches, {
        catalogId: meta === null ? null : meta.catalogId,
        callId,
        resultSeq: asOrder(event.seq),
        resultOk: isRecord(message) && message.isError !== true && data.error === undefined,
        metaOk: meta !== null && meta.marker && meta.formatVersion,
        status: meta === null ? null : meta.status,
        metaCallId: meta === null ? null : meta.callId,
        parentSessionId: meta === null ? null : meta.parentSessionId,
        childSessionId: meta === null ? null : meta.childSessionId,
        observationState: meta === null ? null : meta.observationState,
        observedRouting: meta !== null && meta.observedRouting,
        turn,
        step,
      }],
    };
  }

  if (event.type === CATALOG_EVENT) {
    const childId = asId(data.childId);
    if (childId === null || Object.hasOwn(state.catalogChildren, childId)) return state;
    return { ...state, catalogChildren: { ...state.catalogChildren, [childId]: asOrder(event.seq) } };
  }

  return state;
}

/**
 * Whether one dispatch result proves that the query carrying its catalogId was actually read.
 * Every check is a literal comparison against recorded facts; nothing is inferred from a label, a
 * job id, an in-memory flag or a snapshot that may be stale.
 */
function dispatchProvesUse(dispatch, query, state) {
  if (dispatch.resultOk !== true) return false;
  if (dispatch.metaOk !== true) return false;
  // Only a settled success counts: 'running', 'failed', 'cancelled' or an unreadable status blocks.
  if (dispatch.status !== 'completed') return false;
  // The envelope must prove a committed actual request, not merely that a child was created: the
  // observation state has to be one that only a real request reaches, and the observed routing
  // object has to be present. A background answer returned before the child existed satisfies
  // neither, so it can never prove the query was read.
  if (!OBSERVED_STATES.has(dispatch.observationState)) return false;
  if (dispatch.observedRouting !== true) return false;
  if (dispatch.parentSessionId !== state.parentId) return false;
  // The envelope's callId must be the very tool call the result came from, so an envelope
  // belonging to another dispatch can never be read as this one's evidence.
  if (dispatch.callId === null || dispatch.metaCallId !== dispatch.callId) return false;
  if (dispatch.childSessionId === null) return false;
  // The parent's own child directory is the exact pairing: the label is never identity.
  if (!Object.hasOwn(state.catalogChildren, dispatch.childSessionId)) return false;
  return isLaterOrder(dispatch, query);
}

/**
 * The dispatches that name one catalogId but have no result at all: still pending, or their
 * result never landed. A tracked call is a correlation the model already made, so one of these
 * keeps the query un-eligible. Counting only results would treat a dispatch that is still running
 * (or whose result was lost) as if it had never been made, and compact a query that is in use.
 */
function isOpenDispatch(state, callId, catalogId) {
  const call = state.calls[callId];
  if (call?.name !== DISPATCH_TOOL) return false;
  if (call.catalogId !== catalogId) return false;
  return !state.dispatches.some(dispatch => dispatch.callId === callId);
}

/**
 * The queries that may be compacted now: each is a tracked compact answer, still on the current
 * surface as the same tool/result for the same call, whose catalogId was provably used by at least
 * one dispatch and by no unsettled, failed or unverifiable one. Returns `[{ catalogId, querySeq,
 * callId }]` and carries nothing else (no pool, no ticket, no authorization snapshot).
 */
export function compressionCandidates(state, session) {
  if (!isRecord(state) || !Array.isArray(state.queries) || state.queries.length === 0) return [];
  const surface = readSurface(session);
  if (surface === null) return [];
  if (typeof session.eventAt !== 'function') return [];
  const candidates = [];
  for (const query of state.queries) {
    if (query.parentSessionId !== state.parentId) continue;
    if (!Number.isSafeInteger(query.querySeq) || !surface.includes(query.querySeq)) continue;
    const current = readCatalogAnswer(session.eventAt(query.querySeq));
    if (current === null || current.catalogId !== query.catalogId || current.callId !== query.callId) continue;
    const bound = state.dispatches.filter(dispatch => dispatch.catalogId === query.catalogId);
    if (bound.length === 0) continue;
    if (!bound.every(dispatch => dispatchProvesUse(dispatch, query, state))) continue;
    // A dispatch that names this catalog and has produced no result yet still blocks: the query
    // may be in use right now, and an unreadable outcome is not the same fact as "not dispatched".
    if (Object.keys(state.calls).some(callId => isOpenDispatch(state, callId, query.catalogId))) continue;
    candidates.push({ catalogId: query.catalogId, querySeq: query.querySeq, callId: query.callId });
  }
  return candidates;
}

/**
 * Replace one used query answer with its short summary, exactly the way the official tool-result
 * pruner does: a `compaction/prune` shadow price immediately followed by a `tool/result` replacement
 * that changes only `message.content`. The original event stays in the append-only log for audit,
 * and the assistant tool call and the message identity stay untouched.
 *
 * Returns a JSON result object:
 *   { status: 'disabled' }                       compaction is off (the default)
 *   { status: 'skipped', reason }                nothing was written and nothing was proven
 *   { status: 'replaced', replacementSeq? }      both appends landed
 *   { status: 'failed', reason }                 the prune or the replacement append was refused
 */
export function compactQuery(session, candidate, options = {}) {
  const { enabled = false, tokenMeter, signal } = isRecord(options) ? options : {};
  if (enabled !== true) return { status: 'disabled' };
  if (signal?.aborted === true) return { status: 'skipped', reason: 'aborted' };
  if (typeof tokenMeter?.estimateMessage !== 'function') return { status: 'skipped', reason: 'token-meter-unavailable' };
  if (typeof session?.append !== 'function' || typeof session?.eventAt !== 'function') return { status: 'skipped', reason: 'session-capability-unavailable' };
  if (!isRecord(candidate)) return { status: 'skipped', reason: 'invalid-candidate' };
  const catalogId = asId(candidate.catalogId);
  const callId = asId(candidate.callId);
  const querySeq = asOrder(candidate.querySeq);
  if (catalogId === null || callId === null || querySeq === null) return { status: 'skipped', reason: 'invalid-candidate' };

  // The target must still be exactly the current model-visible node it was found to be: a node the
  // official surface already shadowed, another catalog's candidate or a different tool result is
  // never rewritten.
  const surface = readSurface(session);
  if (surface === null) return { status: 'skipped', reason: 'surface-unavailable' };
  if (!surface.includes(querySeq)) return { status: 'skipped', reason: 'target-not-on-surface' };
  const event = session.eventAt(querySeq);
  if (!isRecord(event) || event.type !== 'tool/result') return { status: 'skipped', reason: 'target-not-a-tool-result' };
  const current = readCatalogAnswer(event);
  if (current === null) return { status: 'skipped', reason: 'target-not-a-compact-catalog-answer' };
  if (current.catalogId !== catalogId) return { status: 'skipped', reason: 'catalog-mismatch' };
  if (current.callId !== callId) return { status: 'skipped', reason: 'call-mismatch' };

  const original = deriveMessage(session, event);
  const recordedMessage = isRecord(event.data?.message) ? event.data.message : null;
  if (original === null || recordedMessage === null) return { status: 'skipped', reason: 'message-unavailable' };
  const summary = [{ type: 'text', text: COMPACTED_QUERY_SUMMARY }];
  if (COMPACTED_QUERY_SUMMARY.length >= textChars(original.content) || COMPACTED_QUERY_SUMMARY.length >= jsonChars(original.content)) {
    return { status: 'skipped', reason: 'summary-not-shorter' };
  }

  let price;
  try {
    price = tokenMeter.estimateMessage(original);
  } catch (error) {
    return { status: 'skipped', reason: `token-estimate-failed: ${reasonOf(error)}` };
  }
  if (!Number.isSafeInteger(price) || price <= 0) return { status: 'skipped', reason: 'unpriceable-message' };

  // No await between these two appends: the prune alone never removes a node, so an interrupted pair
  // leaves the original query model-visible and its prune as the detectable trace.
  try {
    session.append('compaction/prune', {
      shadowedRange: { start: querySeq, end: querySeq },
      shadowedSeqs: [querySeq],
      shadowedTokenCount: price,
    });
  } catch (error) {
    return { status: 'failed', reason: `prune-append-failed: ${reasonOf(error)}` };
  }

  let landed;
  try {
    landed = session.append('tool/result', {
      ...event.data,
      message: { ...recordedMessage, content: summary },
    }, {
      surfaceOp: { op: 'replace', startSeq: querySeq, endSeq: querySeq },
      sourceEventSeqs: [querySeq],
    });
  } catch (error) {
    return { status: 'failed', reason: `replacement-append-failed: ${reasonOf(error)}` };
  }

  const replacementSeq = isRecord(landed) ? asOrder(landed.seq) : null;
  return replacementSeq === null ? { status: 'replaced' } : { status: 'replaced', replacementSeq };
}
