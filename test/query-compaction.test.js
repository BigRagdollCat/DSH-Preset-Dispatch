// Phase C RED tests: "used query compaction" (docs/08 C04-C11, docs/09 T08/T09).
//
// These tests are written against the frozen contract and the REAL host log schema, and they are
// expected to FAIL now: the production module `query-compaction.js` does not exist yet. Every
// test resolves the module through `loadQueryCompaction()`, which converts a missing module into
// an explicit "query compaction implementation missing" assertion, so absence reads as a missing
// feature rather than as an uncaught import/environment error. No test skips.
//
// Contract exercised here (frozen by the main agent):
//   createQueryState(header, inheritedEventCount = 0) -> { parentId, cut }
//     `header` is the session header (its `id` is the parent session id); the fork cut is the
//     second argument, never a private field of the header.
//   reduceQueryState(state, event)                    -> incremental pure fold
//   compressionCandidates(state, session)             -> [{ catalogId, querySeq, callId }]
//   compactQuery(session, candidate, { tokenMeter, enabled = false, signal })
//     -> { status: 'disabled' | 'skipped' | 'replaced' | 'failed', reason?, replacementSeq? }
//
// Two official subagent events are distinguished throughout (see the fixture header):
// `subagent/catalog` is the PARENT directory fact that exactly pairs the dispatched child, and
// `subagent/descriptor` is the CHILD's own v3 identity. The parent log carries no descriptor.
//
// Not run by this author: the tests are written only. Execution belongs to the test-verification role.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  loadQueryCompaction, CONTRACT_EXPORTS, MISSING_IMPLEMENTATION, CATALOG_ID, PARENT_SESSION_ID,
  CHILD_SESSION_ID, DISPATCH_CALL_ID, QUERY_CALL_ID, DISPATCH_MARKER, QUERY_MARKER,
  CATALOG_VERSION, DESCRIPTOR_VERSION, SUBAGENT_PROVIDER, sessionHeader,
  catalogAnswer, queryContent, dispatchMeta, catalogData, descriptorData,
  turnStart, turnEnd, stepStart, stepEnd, systemMessageEvent, assistantEvent, toolCallEvent,
  queryResultEvent, queryExchange, dispatchExchange, catalogEvent, descriptorEvent, pruneEvent, replacementEvent,
  attachSeqs, canonicalLog, createFakeSession, fakeCanonicalSession, loadHost,
} from './fixtures/query-session.js';

/** Resolve the module under test; a missing module must be asserted as a missing feature. */
async function requireModule() {
  const loaded = await loadQueryCompaction();
  assert.notEqual(loaded.module, null, MISSING_IMPLEMENTATION);
  for (const name of CONTRACT_EXPORTS) {
    assert.equal(typeof loaded.module[name], 'function', `${MISSING_IMPLEMENTATION}: export ${name} must be a function`);
  }
  return loaded.module;
}

/** Read a session's log through the surface the session actually offers. */
const eventsOf = session => (Array.isArray(session.events) ? session.events : session.snapshotEvents());

const candidatesFor = (module, session, options = {}) => {
  const state = options.state ?? foldLog(module, eventsOf(session), options.header ?? sessionHeader());
  return { state, candidates: module.compressionCandidates(state, session) };
};

function foldLog(module, events, header = sessionHeader(), inheritedEventCount = 0) {
  let state = module.createQueryState(header, inheritedEventCount);
  for (const event of events) state = module.reduceQueryState(state, event);
  return state;
}

/** Replace one event's data while keeping the log contiguous. */
const patchEvent = (events, predicate, patch) => events.map(event => (predicate(event) ? { ...event, data: { ...event.data, ...patch(event.data) } } : event));

const textOf = message => (message?.content ?? []).map(block => (typeof block?.text === 'string' ? block.text : '')).join('');

// ---------------------------------------------------------------------------------------------
// A. The contract surface exists at all.
// ---------------------------------------------------------------------------------------------

test('A1 the production query-compaction module exists and exports the frozen contract', async () => {
  const module = await requireModule();
  assert.deepEqual(Object.keys(module).length > 0, true, 'a module must export something');
  for (const name of CONTRACT_EXPORTS) assert.equal(typeof module[name], 'function', `${name} must be callable`);
});

/**
 * CONTRACT-SHAPE EVIDENCE ONLY. This test compares the fixtures with themselves plus the envelope
 * literals the suite is built on; it does not read production meta, so it is no proof that the
 * plugin writes these fields. The production-side proof is B3-B11 (fold + eligibility) and D1/D2
 * (the real installed Session).
 */
test('A2 the frozen envelopes and official event shapes this suite builds on', async () => {
  const meta = dispatchMeta();
  assert.equal(meta.marker, DISPATCH_MARKER);
  assert.equal(meta.formatVersion, 1);
  assert.equal(meta.childSessionId, CHILD_SESSION_ID);
  assert.equal(meta.parentSessionId, PARENT_SESSION_ID);
  assert.equal(meta.callId, DISPATCH_CALL_ID);
  assert.equal(meta.catalogId, CATALOG_ID);
  assert.equal(meta.observationState, 'observed');
  assert.equal(meta.observedRouting.requestSeq, 4, 'the observed request sequence is part of the evidence, not the in-memory history');
  assert.equal(meta.status, 'completed');

  // The parent-owned directory fact: identity, creation time, mode and the frozen label.
  assert.equal(catalogEvent().type, 'subagent/catalog', 'the parent directory event type');
  assert.deepEqual(Object.keys(catalogData()).sort(), ['childCreatedAt', 'childId', 'label', 'mode', 'version'], 'the official subagent/catalog field set');
  assert.equal(catalogData().version, CATALOG_VERSION, 'SUBAGENT_CATALOG_VERSION');
  assert.equal(catalogData().childId, CHILD_SESSION_ID);
  assert.notEqual(catalogData().childId, PARENT_SESSION_ID, 'the directory pairs the child session, not the parent');

  // The child's own v3 identity: no childId/childCreatedAt, and a provider name instead.
  assert.equal(descriptorEvent().type, 'subagent/descriptor', 'the child identity event type');
  assert.deepEqual(Object.keys(descriptorData()).sort(), ['label', 'mode', 'provider', 'version'], 'the official one-shot subagent/descriptor field set');
  assert.equal(descriptorData().version, DESCRIPTOR_VERSION, 'SUBAGENT_DESCRIPTOR_VERSION');
  assert.equal(descriptorData().provider, SUBAGENT_PROVIDER, 'the establishing provider name');
  assert.equal(descriptorData().mode, 'one-shot');
  assert.equal(Object.hasOwn(descriptorData(), 'childId'), false, 'a descriptor is not a parent directory entry');

  // The two events must not be swapped: the parent log carries the directory and its own payload,
  // the child carries the descriptor. A builder that crossed them would make B5 match by accident.
  assert.notEqual(catalogEvent().type, descriptorEvent().type, 'the directory and the descriptor are different events');
  assert.deepEqual(Object.keys(catalogData()).sort(), ['childCreatedAt', 'childId', 'label', 'mode', 'version'], 'the directory payload is the catalog payload');
  assert.equal(Object.hasOwn(catalogData(), 'provider'), false, 'a parent directory entry never carries the child descriptor provider');

  // The frozen fold header: `id` is the parent session, the cut is the second argument.
  assert.equal(sessionHeader().id, PARENT_SESSION_ID);

  // The canonical parent log carries the directory entry and never a child descriptor: a parent
  // that fabricated the child's own identity event would make the B5 pairing match for free.
  const parentLog = canonicalLog();
  assert.equal(parentLog.some(event => event.type === 'subagent/catalog'), true, 'the parent log must carry its own directory entry');
  assert.equal(parentLog.some(event => event.type === 'subagent/descriptor'), false, 'the parent log must never fabricate the child descriptor');
  assert.equal(parentLog.filter(event => event.type === 'subagent/catalog').length, 1, 'one dispatch is one directory entry');
});

/**
 * The double below is the measuring instrument for the "deducted exactly once" assertions, so the
 * instrument itself is pinned here: a meter that priced a message by its id would return the
 * original price for a shortened replacement and make a double deduction invisible.
 */
test('A3 the fake session prices by content, reads the official surface, and keeps the compatibility alias', async () => {
  const session = createFakeSession(canonicalLog());
  const queryEvent = session.events.find(event => event.type === 'tool/result' && event.data.message.source.callId === QUERY_CALL_ID);
  const original = session.deriveEventMessage(queryEvent);

  // Pricing is a pure function of content: the same content always prices the same, and a
  // different content under the same message id prices differently.
  const price = session.meter.estimateMessage(original);
  assert.equal(session.meter.estimateMessage(original), price, 'an unchanged message must price deterministically');
  const shortened = { ...original, content: [{ type: 'text', text: 'x' }] };
  assert.equal(session.meter.estimateMessage(shortened), 1, 'a shortened message must price by its own content, not by its id');
  assert.notEqual(session.meter.estimateMessage(shortened), price, 'the same id with different content may not price as the original');
  assert.equal(price, textOf(original).length, 'the fixture price must be the content length it claims to be');

  // The surface is reachable through the official public read, and the alias agrees with it.
  assert.deepEqual(session.surface.nodes, session.surfaceNodes, 'the compatibility alias must not drift from the official read');
  assert.deepEqual(session.surface.nodes, session.events.filter(event => event.surfaceOp === 'append').map(event => event.seq));
  assert.equal(session.surface.replaceGeneration, 0, 'nothing has replaced a node yet');
  assert.equal(session.surface.contentGeneration, 0);
});

// ---------------------------------------------------------------------------------------------
// B. Lifecycle fold over the real log schema, and candidate eligibility.
// ---------------------------------------------------------------------------------------------

test('B1 initial state is pure and carries the fork cut without consulting anything else', async () => {
  const module = await requireModule();
  const state = module.createQueryState(sessionHeader());
  assert.equal(state.cut, 0, 'an unsown state has no inherited prefix');
  assert.equal(module.createQueryState(sessionHeader('other'), 7).cut, 7, 'the fork cut must be the second argument, the borrowed prefix length');
  assert.equal(state.parentId, PARENT_SESSION_ID, 'the header id is the parent session binding');

  let folded = state;
  for (const event of [turnStart(1), stepStart(1, 1), stepEnd(1, 1)]) folded = module.reduceQueryState(folded, event);
  assert.equal(folded.parentId, PARENT_SESSION_ID, 'the fold keeps the parent session binding');
});

test('B2 reduceQueryState folds events incrementally without mutating the state it is given', async () => {
  const module = await requireModule();
  const log = canonicalLog();
  const before = module.createQueryState(sessionHeader());
  const snapshot = JSON.stringify(before);
  const after = log.reduce((state, event) => module.reduceQueryState(state, event), before);
  assert.equal(JSON.stringify(before), snapshot, 'the reducer must not mutate its input state');
  assert.notEqual(after, before, 'folding must produce the next state');
  assert.equal(typeof after, 'object');
});

test('B3 the canonical query exchange is read from its own event data, not from in-memory history', async () => {
  const module = await requireModule();
  const log = canonicalLog();
  const queryResult = log.find(event => event.type === 'tool/result' && event.data.message.source.callId === QUERY_CALL_ID);
  assert.notEqual(queryResult, undefined, 'the fixture must contain the query result');
  const answer = JSON.parse(textOf(queryResult.data.message));
  assert.equal(answer.catalogId, CATALOG_ID);
  assert.equal(answer.catalog.marker, QUERY_MARKER, 'the query answer carries the compact catalog marker');
  assert.equal(answer.catalog.mode, 'compact');
  assert.equal(answer.catalog.authorizationTicket, false, 'the catalog id is never an authorization ticket');
  assert.equal(answer.catalog.parentSessionId, PARENT_SESSION_ID);
  assert.notEqual(answer.catalog.sessionBound, false, 'the query is bound to the calling session');

  const state = foldLog(module, log);
  const query = state.queries?.find(item => item.catalogId === CATALOG_ID) ?? state.queries?.[0];
  assert.notEqual(query, undefined, 'the fold must have seen one query');
  assert.equal(query.catalogId, CATALOG_ID);
  assert.equal(query.querySeq, queryResult.seq, 'the query is identified by its log position');
  assert.equal(query.callId, QUERY_CALL_ID, 'the pairing between tool/call and tool/result is preserved');
});

test('B4 compact canonical query after a later successful dispatch with child evidence is eligible', async () => {
  const module = await requireModule();
  const { session, queryResult, dispatchResult } = fakeCanonicalSession();
  const { candidates } = candidatesFor(module, session);
  assert.equal(candidates.length, 1, `exactly the used query must be a candidate, got ${JSON.stringify(candidates)}`);
  const [candidate] = candidates;
  assert.equal(candidate.catalogId, CATALOG_ID);
  assert.equal(candidate.querySeq, queryResult.seq, 'the candidate targets the query result node itself');
  assert.equal(candidate.callId, QUERY_CALL_ID, 'the candidate keeps the query tool call pairing');
  assert.notEqual(dispatchResult.seq, queryResult.seq);
});

test('B5 a successful dispatch alone is not enough: the parent child directory must hold that exact child', async () => {
  const module = await requireModule();
  const withoutCatalog = attachSeqs(canonicalLog().filter(event => event.type !== 'subagent/catalog'));
  assert.equal(withoutCatalog.some(event => event.type === 'subagent/catalog'), false);
  const { candidates } = candidatesFor(module, createFakeSession(withoutCatalog));
  assert.deepEqual(candidates, [], 'without the exact parent directory pairing the dispatch is not enough evidence');

  const otherChild = patchEvent(canonicalLog(), event => event.type === 'subagent/catalog', () => catalogData({ childId: 'c-other' }));
  const mismatched = candidatesFor(module, createFakeSession(otherChild)).candidates;
  assert.deepEqual(mismatched, [], 'the directory entry must name exactly the dispatched child, never be matched by label');

  const relabelled = patchEvent(canonicalLog(), event => event.type === 'subagent/catalog', () => catalogData({ label: 'preset:researcher' }));
  assert.equal(candidatesFor(module, createFakeSession(relabelled)).candidates.length, 1, 'the label is not the identity: the exact childId still matches');
});

test('B6 ineligible evidence keeps the query: failures, cancellation, unknown meta, missing catalogId, diagnostics and errors', async () => {
  const module = await requireModule();
  const cases = {
    'failed dispatch status': patchEvent(canonicalLog(), event => event.type === 'tool/result' && event.data.message.source.callId === DISPATCH_CALL_ID, () => ({ meta: dispatchMeta({ status: 'failed' }) })),
    'cancelled dispatch status': patchEvent(canonicalLog(), event => event.type === 'tool/result' && event.data.message.source.callId === DISPATCH_CALL_ID, () => ({ meta: dispatchMeta({ status: 'cancelled' }) })),
    'unknown dispatch meta': patchEvent(canonicalLog(), event => event.type === 'tool/result' && event.data.message.source.callId === DISPATCH_CALL_ID, () => ({ meta: undefined })),
    'dispatch without catalogId': patchEvent(canonicalLog(), event => event.type === 'tool/result' && event.data.message.source.callId === DISPATCH_CALL_ID, () => ({ meta: dispatchMeta({ catalogId: undefined }) })),
    'dispatch result is an error': patchEvent(canonicalLog(), event => event.type === 'tool/result' && event.data.message.source.callId === DISPATCH_CALL_ID, data => ({ message: { ...data.message, isError: true } })),
  };
  for (const [name, events] of Object.entries(cases)) {
    const { candidates } = candidatesFor(module, createFakeSession(events));
    assert.deepEqual(candidates, [], `${name}: the query must stay un-eligible`);
  }

  const diagnostic = attachSeqs([
    turnStart(1), stepStart(1, 1),
    ...queryExchange(1, 1, { args: { diagnostic: true }, content: [{ type: 'text', text: JSON.stringify(catalogAnswer({ catalog: { mode: 'diagnostic' } })) }] }),
    stepEnd(1, 1), stepStart(1, 2),
    ...dispatchExchange(1, 2), catalogEvent(), stepEnd(1, 2), stepStart(1, 3), assistantEvent(1, 3), stepEnd(1, 3), turnEnd(1),
  ]);
  assert.deepEqual(candidatesFor(module, createFakeSession(diagnostic)).candidates, [], 'a diagnostic query is never compacted');

  const errored = patchEvent(canonicalLog(), event => event.type === 'tool/result' && event.data.message.source.callId === QUERY_CALL_ID, data => ({ message: { ...data.message, isError: true }, error: { name: 'ToolError', code: 'tool/error' } }));
  assert.deepEqual(candidatesFor(module, createFakeSession(errored)).candidates, [], 'a query error is never compacted');
});

test('B7 a dispatch in the same step as the query never proves the query was read', async () => {
  const module = await requireModule();
  const sameStep = attachSeqs([
    turnStart(1), stepStart(1, 1),
    ...queryExchange(1, 1),
    ...dispatchExchange(1, 1), catalogEvent(),
    stepEnd(1, 1), stepStart(1, 2), assistantEvent(1, 2), stepEnd(1, 2), turnEnd(1),
  ]);
  const { candidates } = candidatesFor(module, createFakeSession(sameStep));
  assert.deepEqual(candidates, [], 'the dispatch must come from a later model step than the query result');
});

test('B8 several dispatches for the same catalog are eligible only when every one of them succeeded', async () => {
  const module = await requireModule();
  const okEvents = attachSeqs([
    turnStart(1), stepStart(1, 1), ...queryExchange(1, 1), stepEnd(1, 1),
    stepStart(1, 2), ...dispatchExchange(1, 2, { callId: 'd1', messageId: 'm-d1', metaPatch: { callId: 'd1', observedRouting: { provider: 'p', model: 'm', reasoningEffort: 'high', requestSeq: 4 } } }), catalogEvent(), stepEnd(1, 2),
    stepStart(1, 3), ...dispatchExchange(1, 3, { callId: 'd2', messageId: 'm-d2', metaPatch: { runId: 'run-2', callId: 'd2', observedRouting: { provider: 'p', model: 'm', reasoningEffort: 'high', requestSeq: 6 } } }), catalogEvent(), stepEnd(1, 3),
    stepStart(1, 4), assistantEvent(1, 4), stepEnd(1, 4), turnEnd(1),
  ]);
  assert.equal(candidatesFor(module, createFakeSession(okEvents)).candidates.length, 1, 'all dispatches succeeded, so the query is one candidate');

  const oneFailed = okEvents.map(event => (event.type === 'tool/result' && event.data.message.source.callId === 'd2'
    ? { ...event, data: { ...event.data, meta: dispatchMeta({ runId: 'run-2', callId: 'd2', status: 'failed' }) } }
    : event));
  assert.deepEqual(candidatesFor(module, createFakeSession(oneFailed)).candidates, [], 'one failed dispatch keeps the whole query');
});

test('B9 multiple queries stay independent: each catalog is tracked on its own', async () => {
  const module = await requireModule();
  const log = attachSeqs([
    turnStart(1), stepStart(1, 1), ...queryExchange(1, 1, { callId: 'q1', messageId: 'm-q1' }), stepEnd(1, 1),
    stepStart(1, 2), ...dispatchExchange(1, 2, { callId: 'd1', messageId: 'm-d1', metaPatch: { callId: 'd1', catalogId: 'catalog1' } }), catalogEvent(), stepEnd(1, 2),
    stepStart(1, 3), ...queryExchange(1, 3, { callId: 'q2', messageId: 'm-q2', answer: { catalogId: 'catalog2' } }), stepEnd(1, 3),
    stepStart(1, 4), ...dispatchExchange(1, 4, { callId: 'd2', messageId: 'm-d2', metaPatch: { runId: 'run-2', callId: 'd2', catalogId: 'catalog2' } }), catalogEvent(), stepEnd(1, 4),
    stepStart(1, 5), assistantEvent(1, 5), stepEnd(1, 5), turnEnd(1),
  ]);
  const { candidates } = candidatesFor(module, createFakeSession(log));
  assert.equal(candidates.length, 2, `two used queries are tracked independently, got ${JSON.stringify(candidates)}`);
  assert.deepEqual(candidates.map(candidate => candidate.catalogId).sort(), ['catalog1', 'catalog2']);
  for (const candidate of candidates) {
    const queryResult = log.find(event => event.type === 'tool/result' && event.data.message.source.callId === candidate.callId);
    assert.equal(queryResult.seq, candidate.querySeq, 'each candidate targets its own query node');
  }
});

test('B10 inherited fork events before the cut are never treated as this session\'s queries', async () => {
  const module = await requireModule();
  const log = canonicalLog();
  const cut = log.length;
  const later = attachSeqs([stepStart(2, 1), ...queryExchange(2, 1, { callId: 'q2', messageId: 'm-q2', answer: { catalogId: 'catalog2' } }), stepEnd(2, 1), stepStart(2, 2), ...dispatchExchange(2, 2, { callId: 'd2', messageId: 'm-d2', metaPatch: { runId: 'run-2', callId: 'd2', catalogId: 'catalog2' } }), catalogEvent(), stepEnd(2, 2)], cut);
  const state = foldLog(module, [...log, ...later], sessionHeader(), cut);
  const { candidates } = candidatesFor(module, createFakeSession([...log, ...later]), { state });
  assert.deepEqual(candidates.map(candidate => candidate.catalogId), ['catalog2'], 'only child-owned events after the cut may be compacted');
});

test('B11 a candidate never borrows the pool or an old authorization as current permission', async () => {
  const module = await requireModule();
  const { session } = fakeCanonicalSession();
  const { candidates } = candidatesFor(module, session);
  assert.equal(candidates.length, 1);
  const serialized = JSON.stringify(candidates[0]);
  for (const forbidden of ['models', 'authorizationTicket', 'allowedModels', 'usableModels']) {
    assert.equal(serialized.includes(forbidden), false, `a candidate must not carry ${forbidden}`);
  }
});

test('B12 an unsettled parallel dispatch blocks the candidate: evidence is settled only evidence', async () => {
  const module = await requireModule();
  // One query, then two dispatches recorded in separate steps. The second has been recorded but
  // has not settled: its observed request exists while the run is still running.
  const buildLog = d2Meta => attachSeqs([
    turnStart(1), stepStart(1, 1), ...queryExchange(1, 1), stepEnd(1, 1),
    stepStart(1, 2), ...dispatchExchange(1, 2, { callId: 'd1', messageId: 'm-d1', metaPatch: { callId: 'd1', observedRouting: { provider: 'p', model: 'm', reasoningEffort: 'high', requestSeq: 4 } } }), catalogEvent(), stepEnd(1, 2),
    stepStart(1, 3), ...dispatchExchange(1, 3, { callId: 'd2', messageId: 'm-d2', metaPatch: { runId: 'run-2', callId: 'd2', status: 'running', observationState: 'observed', observedRouting: { provider: 'p', model: 'm', reasoningEffort: 'high', requestSeq: 6 }, ...d2Meta } }), catalogEvent(), stepEnd(1, 3),
    // A third model step, so the running dispatch cannot be read as an earlier step's leftover.
    stepStart(1, 4), assistantEvent(1, 4), stepEnd(1, 4), turnEnd(1),
  ]);
  const unsettled = buildLog();
  assert.deepEqual(candidatesFor(module, createFakeSession(unsettled)).candidates, [], 'a dispatch that has not settled is not proof that the query was used');

  // The same log with that dispatch settled: the query becomes one candidate, so the block above
  // is caused by settlement and not by the parallel dispatch existing at all.
  const settled = buildLog({ status: 'completed', observationState: 'finished', finishedAt: '2026-01-01T00:00:10.000Z' });
  assert.equal(candidatesFor(module, createFakeSession(settled)).candidates.length, 1, 'once every dispatch settles the query is one candidate');
});

test('B13 a pending dispatch naming the catalog in tool/call arguments blocks compaction without a result', async () => {
  const module = await requireModule();
  const settledLog = canonicalLog();
  assert.equal(candidatesFor(module, createFakeSession(settledLog)).candidates.length, 1, 'the settled dispatch alone makes this query eligible');
  const pendingCallId = 'dispatch-pending-with-catalog';
  const events = attachSeqs([
    ...settledLog,
    turnStart(2), stepStart(2, 1), assistantEvent(2, 1),
    toolCallEvent(2, 1, pendingCallId, 'preset_dispatch', { preset: 'researcher', task: 'still running', catalogId: CATALOG_ID }),
  ]);
  const call = events.find(event => event.type === 'tool/call' && event.data.callId === pendingCallId);
  assert.equal(JSON.parse(call.data.arguments).catalogId, CATALOG_ID, 'correlation exists in the real arguments field');
  assert.equal(events.some(event => event.type === 'tool/result' && event.data.message.source.callId === pendingCallId), false, 'the pending dispatch has no result or fabricated meta');
  assert.deepEqual(candidatesFor(module, createFakeSession(events)).candidates, [], 'one open dispatch naming this catalog must retain the query even after another dispatch succeeded');
});

// ---------------------------------------------------------------------------------------------
// C. compactQuery: disabled by default, skip/repair behavior, and the shadow-price append pair.
// ---------------------------------------------------------------------------------------------

test('C1 compaction is closed by default and does nothing at all', async () => {
  const module = await requireModule();
  const { session, queryResult } = fakeCanonicalSession();
  const { candidates } = candidatesFor(module, session);
  const result = await module.compactQuery(session, candidates[0], { tokenMeter: session.meter });
  assert.equal(result.status, 'disabled', `default-off compaction must report disabled, got ${JSON.stringify(result)}`);
  assert.equal(session.appends.length, 0, 'a disabled compaction must not touch the log');
  assert.equal(session.surface.nodes.includes(queryResult.seq), true, 'a disabled compaction leaves the query model-visible');
});

test('C2 a cancelled signal or a meter that cannot price a message skips without failing', async () => {
  const module = await requireModule();
  const { session } = fakeCanonicalSession();
  const { candidates } = candidatesFor(module, session);
  const controller = new AbortController();
  controller.abort();
  const cancelled = await module.compactQuery(session, candidates[0], { tokenMeter: session.meter, enabled: true, signal: controller.signal });
  assert.equal(cancelled.status, 'skipped', `an aborted signal must skip, got ${JSON.stringify(cancelled)}`);
  assert.equal(session.appends.length, 0);

  const noMeter = await module.compactQuery(session, candidates[0], { tokenMeter: {}, enabled: true });
  assert.equal(noMeter.status, 'skipped', `a meter without estimateMessage must skip, got ${JSON.stringify(noMeter)}`);
  assert.equal(session.appends.length, 0);
});

test('C3 an unknown target or a candidate naming another catalog skips instead of rewriting the wrong result', async () => {
  const module = await requireModule();
  const { session, queryResult } = fakeCanonicalSession();
  const { candidates } = candidatesFor(module, session);
  const candidate = candidates[0];

  const unknown = await module.compactQuery(session, { ...candidate, querySeq: 9999 }, { tokenMeter: session.meter, enabled: true });
  assert.equal(unknown.status, 'skipped', `a target outside the current surface must skip, got ${JSON.stringify(unknown)}`);

  const mismatched = await module.compactQuery(session, { ...candidate, catalogId: 'catalog-elsewhere' }, { tokenMeter: session.meter, enabled: true });
  assert.equal(mismatched.status, 'skipped', `a candidate naming another catalog must skip, got ${JSON.stringify(mismatched)}`);

  // A target the official surface already replaced is no longer a current node: the query this
  // session runs on is the shadowing node, so the query node itself is skipped.
  const log = canonicalLog();
  const queryEvent = log.find(event => event.type === 'tool/result' && event.data.message.source.callId === QUERY_CALL_ID);
  const officialReplace = attachSeqs([
    ...log.slice(0, queryEvent.seq + 1),
    pruneEvent(queryEvent.seq, 10),
    replacementEvent(queryEvent, [{ type: 'text', text: '官方已压缩的查询结果' }]),
    ...log.slice(queryEvent.seq + 1),
  ]);
  const replacedSession = createFakeSession(officialReplace);
  const already = await module.compactQuery(replacedSession, candidate, { tokenMeter: replacedSession.meter, enabled: true });
  assert.equal(already.status, 'skipped', `a target already shadowed by an official replacement must skip, got ${JSON.stringify(already)}`);
  assert.equal(replacedSession.appends.length, 0, 'no skip path may write to the log');
  assert.equal(session.appends.length, 0, 'no skip path may write to the log');
  assert.equal(session.surface.nodes.includes(queryResult.seq), true, 'a skipped candidate leaves the query model-visible');
});

/**
 * The replacement must preserve event data, message identity, source, meta and tool pairing, and
 * must be immediately preceded by the shadow-price prune event with no await in between.
 */
function assertReplacement(session, originalEvent, result) {
  assert.equal(result.status, 'replaced', `expected a landed replacement, got ${JSON.stringify(result)}`);
  assert.equal(session.appends.length, 2, `exactly the prune and the replacement are appended, got ${session.appends.map(append => append.type).join(',')}`);
  const [prune, replacement] = session.appends;
  assert.equal(prune.type, 'compaction/prune', 'the shadow price comes first');
  assert.deepEqual(prune.data.shadowedRange, { start: originalEvent.seq, end: originalEvent.seq });
  assert.deepEqual(prune.data.shadowedSeqs, [originalEvent.seq]);
  assert.equal(Number.isSafeInteger(prune.data.shadowedTokenCount) && prune.data.shadowedTokenCount > 0, true, 'the shadow price must be a positive estimate');
  assert.equal(prune.data.shadowedTokenCount, session.meter.estimateMessage(session.deriveEventMessage(originalEvent)), 'the shadow price must be the meter estimate of the original message');

  assert.equal(replacement.type, 'tool/result');
  assert.deepEqual(replacement.opts.surfaceOp, { op: 'replace', startSeq: originalEvent.seq, endSeq: originalEvent.seq });
  assert.deepEqual(replacement.opts.sourceEventSeqs, [originalEvent.seq]);
  assert.equal(replacement.data.turn, originalEvent.data.turn, 'the replacement keeps the event envelope');
  assert.equal(replacement.data.step, originalEvent.data.step);
  assert.equal(replacement.data.message.id, originalEvent.data.message.id, 'message identity must survive the replacement');
  assert.equal(replacement.data.message.role, 'tool');
  assert.deepEqual(replacement.data.message.source, originalEvent.data.message.source, 'the tool source must survive');
  assert.equal(replacement.data.message.toolCallId, originalEvent.data.message.toolCallId, 'the tool call pairing must survive');
  assert.deepEqual(replacement.data.meta, originalEvent.data.meta, 'the recorded meta must survive the replacement');
  assert.equal(result.replacementSeq, session.appends[1].seq, 'the reported replacement seq is the landed replacement event position');
  assert.equal(session.eventAt(result.replacementSeq)?.surfaceOp?.op, 'replace', 'the reported seq resolves to the committed replacement event');
}

test('C4 an enabled compaction of a used query replaces exactly one node with a shorter summary', async () => {
  const module = await requireModule();
  const { session, queryResult } = fakeCanonicalSession();
  const { candidates } = candidatesFor(module, session);
  const original = JSON.stringify(queryResult.data.message.content);
  const result = await module.compactQuery(session, candidates[0], { tokenMeter: session.meter, enabled: true });
  assertReplacement(session, queryResult, result);

  const replacementMessage = session.appends[1].data.message;
  const summary = textOf(replacementMessage);
  assert.equal(summary.length < original.length, true, `the summary must be shorter than the query answer (${summary.length} vs ${original.length})`);
  assert.equal(summary.length < 400, true, `the summary must be short, got ${summary.length} characters`);
  assert.equal(/查询|catalog/.test(summary), true, `the summary must say the catalog was used, got ${JSON.stringify(summary.slice(0, 120))}`);
  assert.equal(/preset_list|重新查询|再次查询|re-?query|query again/i.test(summary), true, 'the summary must say a fresh query is needed for another choice');
  // The summary is a record that the query was used; it is not a new authorization. The wording
  // must not republish the original choice's routes or models, because a later reader would take
  // them for current permission. The summary is otherwise free: no pool phrasing is required.
  const published = JSON.stringify(replacementMessage.content);
  for (const forbidden of ['opencode-go', 'deepseek', 'gpt-', 'local-preset-dispatch', 'allowedModels', 'usableModels', 'authorizationTicket', 'reasoningEffort', '池', 'pool']) {
    assert.equal(published.includes(forbidden), false, `the summary must not republish ${forbidden} as current authorization`);
  }
});

test('C5 after the replacement the original query node is gone from the surface but its audit record and pairing remain', async () => {
  const module = await requireModule();
  const { session, queryResult } = fakeCanonicalSession();
  const { candidates } = candidatesFor(module, session);
  const result = await module.compactQuery(session, candidates[0], { tokenMeter: session.meter, enabled: true });
  assertReplacement(session, queryResult, result);

  assert.equal(session.surface.nodes.includes(queryResult.seq), false, 'the original node must no longer be model-visible');
  assert.equal(session.surface.nodes.includes(result.replacementSeq), true, 'the summary must be model-visible');
  assert.notEqual(session.eventAt(queryResult.seq), undefined, 'the original event stays in the append-only log');
  const queryCall = session.events.find(event => event.type === 'tool/call' && event.data.callId === QUERY_CALL_ID);
  assert.notEqual(queryCall, undefined, 'the assistant tool call stays in the log, so the pairing is not broken');
  const messages = session.deriveMessages();
  assert.equal(messages.map(textOf).some(text => text === textOf(session.appends[1].data.message)), true, 'derived history must contain the summary');
  assert.equal(messages.filter(message => message.toolCallId === QUERY_CALL_ID).length, 1, 'exactly one model-visible result answers the query call');
});

test('C6 replaying the already-replaced log changes nothing: the same query is not compacted twice', async () => {
  const module = await requireModule();
  const first = fakeCanonicalSession();
  const { candidates } = candidatesFor(module, first.session);
  const result = await module.compactQuery(first.session, candidates[0], { tokenMeter: first.session.meter, enabled: true });
  assertReplacement(first.session, first.queryResult, result);

  // The same session, re-read from its events: the query node is already off the surface, so a
  // second pass must skip and write nothing.
  const replayed = createFakeSession(first.session.events);
  const replayedCandidates = candidatesFor(module, replayed).candidates;
  const second = await module.compactQuery(replayed, replayedCandidates[0] ?? candidates[0], { tokenMeter: replayed.meter, enabled: true });
  assert.notEqual(second.status, 'replaced', `already-replaced history must not be compacted again, got ${JSON.stringify(second)}`);
  assert.equal(replayed.appends.length, 0, 'a replay must not append a second replacement');
  assert.deepEqual(replayedCandidates, [], 'an already replaced query is no longer a candidate');
  assert.equal(replayed.surface.nodes.includes(first.queryResult.seq), false, 'replay does not restore the replaced source seq');
  assert.equal(replayed.surface.nodes.includes(result.replacementSeq), true, 'replay retains the landed replacement seq');
});

test('C6b an official replace removes the query from the surface, and eligibility follows the surface', async t => {
  const module = await requireModule();
  const host = await loadHost();
  // The host packages are not resolvable from every location (a desktop bundle keeps them inside an
  // asar archive). That is an environment limitation, reported as a skip that names the roots it
  // tried, rather than a suite failure for a machine this test cannot inspect.
  if (!host.ok) { t.skip(`real Session test unavailable in this location: ${host.reason}`); return; }

  const events = [
    turnStart(1), stepStart(1, 1), ...queryExchange(1, 1), stepEnd(1, 1),
    stepStart(1, 2), ...dispatchExchange(1, 2), catalogEvent(), stepEnd(1, 2),
    stepStart(1, 3), assistantEvent(1, 3), stepEnd(1, 3), turnEnd(1),
  ];
  const build = () => {
    const session = new host.Session('parent-session-official');
    for (const event of events) session.append(event.type, event.data, ...(event.surfaceOp === undefined ? [] : [{ surfaceOp: event.surfaceOp }]));
    return session;
  };

  // Before any official replacement the used query is one candidate.
  assert.equal(candidatesFor(module, build()).candidates.length, 1, 'the used query is eligible before any replacement');

  // The official Session applies the same prune + content-only replacement pair compaction appends.
  const replaced = build();
  const queryEvent = replaced.snapshotEvents().find(event => event.type === 'tool/result' && event.data.message.source.callId === QUERY_CALL_ID);
  const original = replaced.deriveEventMessage(replaced.eventAt(queryEvent.seq));
  const price = host.estimateMessage(original);
  replaced.append('compaction/prune', { shadowedRange: { start: queryEvent.seq, end: queryEvent.seq }, shadowedSeqs: [queryEvent.seq], shadowedTokenCount: price });
  const landed = replaced.append('tool/result', { ...replaced.eventAt(queryEvent.seq).data, message: { ...original, content: [{ type: 'text', text: '目录查询已使用并压缩；需要再次选择时请重新调用 preset_list。' }] } }, { surfaceOp: { op: 'replace', startSeq: queryEvent.seq, endSeq: queryEvent.seq }, sourceEventSeqs: [queryEvent.seq] });
  assert.equal(replaced.surface.nodes.includes(queryEvent.seq), false, 'the official surface removes the original query node');
  assert.equal(replaced.surface.nodes.includes(landed.seq), true, 'the official surface keeps the replacement node');

  // Re-read from that official history: nothing is left to compact, so eligibility must be empty.
  const reread = new host.Session('parent-session-official');
  for (const event of replaced.snapshotEvents()) {
    reread.append(event.type, event.data, ...(event.surfaceOp === undefined ? [] : [{
      surfaceOp: event.surfaceOp,
      ...(event.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: event.sourceEventSeqs }),
    }]));
  }
  assert.deepEqual(reread.surface.nodes, replaced.surface.nodes, 're-reading the exact landed log preserves the official surface');
  assert.deepEqual(candidatesFor(module, reread).candidates, [], 'an officially replaced query is no longer eligible');
});

test('C7 a failed replacement append is reported as failed, leaves the prune, and the retry deducts tokens only once', async () => {
  const module = await requireModule();
  const { session, queryResult } = fakeCanonicalSession();
  const { candidates } = candidatesFor(module, session);
  const candidate = candidates[0];
  const original = session.deriveEventMessage(queryResult);
  const price = session.meter.estimateMessage(original);
  const before = session.surfaceTokens;

  session.failAppendAt(2);
  const failed = await module.compactQuery(session, candidate, { tokenMeter: session.meter, enabled: true });
  assert.equal(failed.status, 'failed', `a refused replacement append must be reported, not thrown, got ${JSON.stringify(failed)}`);
  assert.equal(typeof failed.reason === 'string' && failed.reason.length > 0, true, 'a failed compaction states its reason');
  assert.equal(session.surface.nodes.includes(queryResult.seq), true, 'the query must still be model-visible after the failure');
  assert.equal(session.surfaceTokens, before, 'a bare prune must not deduct tokens');
  assert.equal(session.appends.filter(append => append.type === 'compaction/prune').length, 1, 'the prune is the detectable trace of the interrupted pair');

  assert.equal(session.pendingClaim, null, 'a refused append must not leave a reusable shadow-price claim');
  const retryAt = session.appends.length;
  const retry = await module.compactQuery(session, candidate, { tokenMeter: session.meter, enabled: true });
  assert.equal(retry.status, 'replaced', `the retry must land, got ${JSON.stringify(retry)}`);
  const pair = session.appends.slice(retryAt);
  assert.deepEqual(pair.map(append => append.type), ['compaction/prune', 'tool/result'], 'retry must append a fresh complete pair');
  assert.equal(pair[0].seq + 1, pair[1].seq, 'the retry shadow price is immediately adjacent to its replacement');
  const replacementPrice = session.meter.estimateMessage(pair[1].data.message);
  assert.equal(session.surfaceTokens, before - price + replacementPrice, 'deduct the original shadow price once and include the replacement content price');
  const after = session.surfaceTokens;
  const repeated = await module.compactQuery(session, candidate, { tokenMeter: session.meter, enabled: true });
  assert.notEqual(repeated.status, 'replaced', 'the landed retry cannot replace the same query again');
  assert.equal(session.surfaceTokens, after, 'a repeated attempt must not deduct tokens again');
  assert.equal(session.appends.length, retryAt + 2, 'a repeated attempt must not append another pair');
});

test('C8 compaction never touches assistant messages, other tool results, or work results', async () => {
  const module = await requireModule();
  const all = canonicalLog();
  const stepThreeAt = all.findIndex(event => event.type === 'step/start' && event.data.turn === 1 && event.data.step === 3);
  assert.notEqual(stepThreeAt, -1, 'the fixture must contain later unrelated work');
  const base = all.slice(0, stepThreeAt);
  const work = [
    assistantEvent(1, 4, { message: { id: 'm-asst-work', role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'text', text: 'work summary' }] } }),
    toolCallEvent(1, 4, 'w1', 'job_output', { jobId: 'job-1' }),
    queryResultEvent(1, 4, { callId: 'w1', messageId: 'm-work-1', content: [{ type: 'text', text: 'work result that must survive' }] }),
    stepEnd(1, 4),
    turnEnd(1),
  ];
  const log = attachSeqs([...base, ...work]);
  const session = createFakeSession(log);
  const candidates = candidatesFor(module, session).candidates;
  assert.equal(candidates.length, 1, `the query is the only candidate, got ${JSON.stringify(candidates)}`);

  const assistantsBefore = session.events.filter(event => event.type === 'assistant/message').length;
  const resultsBefore = session.events.filter(event => event.type === 'tool/result').map(event => event.seq);
  const result = await module.compactQuery(session, candidates[0], { tokenMeter: session.meter, enabled: true });
  assert.equal(result.status, 'replaced', `expected a landed replacement, got ${JSON.stringify(result)}`);
  assert.equal(session.events.filter(event => event.type === 'assistant/message').length, assistantsBefore, 'no assistant message may be appended or rewritten');
  assert.deepEqual(session.events.filter(event => event.type === 'tool/result').map(event => event.seq).slice(0, resultsBefore.length), resultsBefore, 'the log keeps every tool result in place');
  const workResult = session.events.find(event => event.type === 'tool/result' && event.data.message.id === 'm-work-1');
  assert.equal(session.surface.nodes.includes(workResult.seq), true, 'a work result must stay model-visible');
});

// ---------------------------------------------------------------------------------------------
// D. The official Session implementation, not a mock.
// ---------------------------------------------------------------------------------------------

test('D1 the real installed Session accepts the replacement pair, keeps one message per call, and ignores the original seq', async t => {
  await requireModule();
  const host = await loadHost();
  if (!host.ok) { t.skip(`real Session test unavailable in this location: ${host.reason}`); return; }

  const session = new host.Session('parent-session');
  const events = [
    systemMessageEvent(1, 1, 'system prompt'),
    turnStart(1),
    stepStart(1, 1),
    assistantEvent(1, 1),
    toolCallEvent(1, 1, QUERY_CALL_ID, 'preset_list', { diagnostic: false }),
    queryResultEvent(1, 1),
    stepEnd(1, 1),
  ];
  for (const event of events) session.append(event.type, event.data, ...(event.surfaceOp === undefined ? [] : [{ surfaceOp: event.surfaceOp, ...(event.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: event.sourceEventSeqs }) }]));

  const querySeq = session.snapshotEvents().find(event => event.type === 'tool/result').seq;
  const original = session.deriveEventMessage(session.eventAt(querySeq));
  const price = host.estimateMessage(original);
  assert.equal(Number.isSafeInteger(price) && price > 0, true, 'the host estimator must price a tool result');

  const replacement = { ...original, content: [{ type: 'text', text: '目录查询已使用并压缩；需要再次选择时请重新调用 preset_list 查询当前授权。' }] };
  const prune = session.append('compaction/prune', { shadowedRange: { start: querySeq, end: querySeq }, shadowedSeqs: [querySeq], shadowedTokenCount: price });
  const landed = session.append('tool/result', { ...session.eventAt(querySeq).data, message: replacement }, { surfaceOp: { op: 'replace', startSeq: querySeq, endSeq: querySeq }, sourceEventSeqs: [querySeq] });

  assert.equal(prune.seq + 1, landed.seq, 'the shadow price must be the event immediately before its replacement');
  assert.equal(session.surface.nodes.includes(querySeq), false, 'the real surface must shadow the original node');
  assert.equal(session.surface.nodes.includes(landed.seq), true);
  const messages = session.deriveMessages();
  assert.equal(messages.filter(message => message.role === 'tool').length, 1, 'exactly one model-visible tool message answers the query call');
  assert.equal(messages.filter(message => message.role === 'tool')[0].id, original.id, 'the message identity is preserved through the replacement');
  assert.notEqual(session.eventAt(querySeq), undefined, 'the real log keeps the original event for audit');
});

test('D2 the official replacement rule rejects a rewritten node, so only content may change', async t => {
  // This pins the host rule the implementation must satisfy. It is gated on the production module
  // because that is where its missing feature is stated: above the gate the outcome is the missing
  // implementation, and below it the real assertion runs.
  await requireModule();
  const host = await loadHost();
  // Environment load failures are stated exactly as themselves, as a skip naming the roots it
  // tried; the real assertion below never hides behind it.
  if (!host.ok) { t.skip(`real Session test unavailable in this location: ${host.reason}`); return; }

  const session = new host.Session('parent-session-2');
  const events = [
    systemMessageEvent(1, 1, 'system prompt'),
    stepStart(1, 1),
    assistantEvent(1, 1),
    toolCallEvent(1, 1, QUERY_CALL_ID, 'preset_list', {}),
    queryResultEvent(1, 1),
  ];
  for (const event of events) session.append(event.type, event.data, ...(event.surfaceOp === undefined ? [] : [{ surfaceOp: event.surfaceOp }]));
  const querySeq = session.snapshotEvents().find(event => event.type === 'tool/result').seq;
  const original = session.deriveEventMessage(session.eventAt(querySeq));
  const replace = message => session.append('tool/result', { ...session.eventAt(querySeq).data, message }, { surfaceOp: { op: 'replace', startSeq: querySeq, endSeq: querySeq }, sourceEventSeqs: [querySeq] });

  // The one field this tamper changes is the tool pairing, which is unambiguous: no turn, step,
  // role or content is invented to make the log wrong.
  const tampered = { ...original, toolCallId: 'other-call' };
  assert.notEqual(tampered.toolCallId, original.toolCallId, 'exactly one field differs from the original message');
  assert.deepEqual({ ...tampered, toolCallId: original.toolCallId }, original, 'the tamper changes the tool pairing and nothing else');
  assert.throws(() => replace(tampered), /may change only content/, 'the host itself refuses anything but a content-only tool/result rewrite');

  // The control: the same replace with only the content changed lands, so the rejection above is
  // caused by the pairing change and not by the append path failing for another reason.
  const landed = replace({ ...original, content: [{ type: 'text', text: '目录查询已使用并压缩；需要再次选择时请重新调用 preset_list。' }] });
  assert.equal(session.surface.nodes.includes(landed.seq), true, 'a content-only replacement of the same node lands');
});
