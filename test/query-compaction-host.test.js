// Phase C host wiring tests. Authoring only: execution belongs to the independent verifier.
// Missing host implementation is feature RED; dependency/import errors are load failures, not skips.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import {
  CATALOG_ID, QUERY_CALL_ID, DISPATCH_CALL_ID,
  canonicalLog, createFakeSession, fakeCanonicalSession, sessionHeader,
  attachSeqs, queryExchange, dispatchExchange, queryContent,
  turnStart, turnEnd, stepStart, stepEnd, assistantEvent,
} from './fixtures/query-session.js';
import { createQueryState, reduceQueryState, compressionCandidates } from '../query-compaction.js';

const hostUrl = new URL('../query-compaction-host.js', import.meta.url);

async function requireHost() {
  assert.equal(existsSync(hostUrl), true, 'feature RED: query-compaction-host.js is missing');
  let module;
  try {
    module = await import(hostUrl.href);
  } catch (error) {
    throw new Error(`host module load failure (not missing feature or fixture RED): ${error?.code ?? error?.name}: ${error?.message ?? error}`, { cause: error });
  }
  for (const name of ['createQueryCompaction', 'registerQueryCompaction']) {
    assert.equal(typeof module[name], 'function', `feature RED: missing export ${name}`);
  }
  return module;
}

const textOf = message => (message?.content ?? []).map(block => block?.text ?? '').join('');
const loggerSpy = () => {
  const warnings = [];
  return { warnings, warn(...args) { warnings.push(args); } };
};

function referenceState(session) {
  return session.events.reduce(
    (state, event) => reduceQueryState(state, event),
    createQueryState(session.header, session.inheritedEventCount),
  );
}

// Pin positive preconditions through the independently tested core. A malformed fixture must not
// accidentally make a disabled/failure assertion pass because there was never anything to replace.
function assertUsedQueryFixture(session, expectedCallId = QUERY_CALL_ID) {
  const candidates = compressionCandidates(referenceState(session), session);
  assert.equal(candidates.length, 1, 'fixture/core precondition: this log must contain exactly one eligible query');
  assert.equal(candidates[0].callId, expectedCallId, 'fixture/core precondition: the eligible node must be the intended query');
  return candidates[0];
}

function assertCounts(result) {
  assert.equal(typeof result, 'object', 'compact must return a result object');
  assert.notEqual(result, null);
  for (const name of ['checked', 'replaced', 'skipped', 'failed']) {
    assert.equal(Number.isSafeInteger(result[name]), true, `${name} must be an integer count`);
    assert.ok(result[name] >= 0, `${name} must be non-negative`);
  }
}

async function compactWithoutThrow(compaction, agent, signal) {
  let result;
  await assert.doesNotReject(async () => { result = await compaction.compact(agent, signal); }, 'compact must never throw or reject');
  assertCounts(result);
  return result;
}

function fakeContext() {
  const listeners = new Map();
  const releases = new Map();
  return {
    listeners, releases,
    on(name, handler) {
      assert.equal(listeners.has(name), false, `only one ${name} listener may be registered`);
      listeners.set(name, handler);
      releases.set(name, 0);
      return () => {
        releases.set(name, releases.get(name) + 1);
        listeners.delete(name);
      };
    },
  };
}

const preStepPayload = (agent, signal = new AbortController().signal) => ({ agent, signal, messages: [], turn: 2, step: 1 });

function assertRegistered(ctx, disposer) {
  assert.equal(typeof disposer, 'function', 'registration must return one disposer');
  assert.deepEqual([...ctx.listeners.keys()].sort(), ['agent/pre-step', 'session/event']);
}

function assertDisposedTwice(ctx, disposer) {
  assert.doesNotThrow(() => { disposer(); disposer(); }, 'the unified disposer must be repeatable');
  assert.equal(ctx.listeners.size, 0, 'both listeners must be removed');
  assert.equal(ctx.releases.get('agent/pre-step'), 1, 'pre-step listener must be released exactly once');
  assert.equal(ctx.releases.get('session/event'), 1, 'session-event listener must be released exactly once');
}

test('H0 fixture snapshotEvents uses an inclusive/exclusive range and stable snapshots', () => {
  const log = canonicalLog();
  const session = createFakeSession(log, { header: sessionHeader('fixture-parent'), inheritedEventCount: 3 });
  assert.equal(session.header.id, 'fixture-parent');
  assert.equal(session.inheritedEventCount, 3);
  assert.equal(createFakeSession().inheritedEventCount, 0, 'existing single-argument fixture calls retain a zero cut');
  assert.deepEqual(session.snapshotEvents(3, 6), log.slice(3, 6), 'fromSeq is included; toSeqExclusive is excluded');
  assert.deepEqual(session.snapshotEvents(3), log.slice(3));
  assert.deepEqual(session.snapshotEvents(log.length), []);
  const snapshot = session.snapshotEvents();
  assert.equal(Object.isFrozen(snapshot), true, 'the official snapshot array is immutable');
  session.append('step/start', { turn: 2, step: 1 });
  assert.deepEqual(snapshot, log, 'an old snapshot must remain stable after append');
  assert.equal(session.snapshotEvents().length, log.length + 1);
});

test('H1 enabled false reports disabled and appends nothing even with a used query', async () => {
  const { createQueryCompaction } = await requireHost();
  const { session, queryResult } = fakeCanonicalSession();
  assertUsedQueryFixture(session);
  const compaction = createQueryCompaction({ enabled: () => false, tokenMeter: session.meter, logger: loggerSpy() });
  const result = await compactWithoutThrow(compaction, { session });
  assert.equal(result.disabled, true);
  assert.equal(result.replaced, 0);
  assert.deepEqual(session.appends, []);
  assert.ok(session.surface.nodes.includes(queryResult.seq));
});

test('H2 enabled used query appends exactly one prune/replacement pair containing a short summary', async () => {
  const { createQueryCompaction } = await requireHost();
  const { session, queryResult } = fakeCanonicalSession();
  assertUsedQueryFixture(session);
  const compaction = createQueryCompaction({ enabled: () => true, tokenMeter: session.meter, logger: loggerSpy() });
  const result = await compactWithoutThrow(compaction, { session });
  assert.equal(result.replaced, 1);
  assert.equal(result.failed, 0);
  assert.deepEqual(session.appends.map(event => event.type), ['compaction/prune', 'tool/result']);
  const [prune, replacement] = session.appends;
  assert.deepEqual(prune.data.shadowedSeqs, [queryResult.seq]);
  assert.deepEqual(prune.data.shadowedRange, { start: queryResult.seq, end: queryResult.seq });
  assert.equal(replacement.seq, prune.seq + 1, 'the replacement must immediately follow the committed prune');
  assert.deepEqual(replacement.opts.surfaceOp, { op: 'replace', startSeq: queryResult.seq, endSeq: queryResult.seq });
  assert.deepEqual(replacement.opts.sourceEventSeqs, [queryResult.seq]);
  const summary = textOf(replacement.data.message);
  assert.ok(summary.length > 0 && summary.length < textOf(queryResult.data.message).length, 'replacement content must be a genuinely shorter, non-empty summary');
  assert.match(summary, /preset_list/, 'the summary must tell a later reader to query again');
  assert.deepEqual(replacement.data, {
    ...queryResult.data,
    message: { ...queryResult.data.message, content: replacement.data.message.content },
  }, 'only message.content may change');
  assert.equal(session.surface.nodes.includes(queryResult.seq), false);
  assert.ok(session.surface.nodes.includes(replacement.seq));
  const again = await compactWithoutThrow(compaction, { session });
  assert.equal(again.replaced, 0, 'the same query must not be replaced twice');
  assert.equal(session.appends.length, 2);
});

test('H3 an unreferenced query produces no checked candidate or append', async () => {
  const { createQueryCompaction } = await requireHost();
  const log = attachSeqs([
    turnStart(1), stepStart(1, 1), ...queryExchange(1, 1), stepEnd(1, 1),
    stepStart(1, 2), assistantEvent(1, 2), stepEnd(1, 2), turnEnd(1),
  ]);
  const session = createFakeSession(log);
  assert.equal(referenceState(session).queries.length, 1, 'fixture/core precondition: a valid query was recorded');
  assert.deepEqual(compressionCandidates(referenceState(session), session), [], 'fixture/core precondition: no later dispatch referenced the query');
  const compaction = createQueryCompaction({ enabled: () => true, tokenMeter: session.meter, logger: loggerSpy() });
  const result = await compactWithoutThrow(compaction, { session });
  assert.equal(result.checked, 0, 'checked counts candidates, not recorded queries');
  assert.equal(result.replaced, 0);
  assert.equal(result.failed, 0);
  assert.deepEqual(session.appends, []);
});

test('H4 missing tokenMeter reports no replacement or failure without throwing or appending', async () => {
  const { createQueryCompaction } = await requireHost();
  const { session } = fakeCanonicalSession();
  assertUsedQueryFixture(session);
  const compaction = createQueryCompaction({ enabled: () => true, logger: loggerSpy() });
  const result = await compactWithoutThrow(compaction, { session });
  assert.equal(result.replaced, 0);
  assert.equal(result.failed, 0);
  assert.deepEqual(session.appends, []);
});

test('H5 an already aborted signal does not throw or append', async () => {
  const { createQueryCompaction } = await requireHost();
  const { session } = fakeCanonicalSession();
  assertUsedQueryFixture(session);
  const controller = new AbortController();
  controller.abort();
  const compaction = createQueryCompaction({ enabled: () => true, tokenMeter: session.meter, logger: loggerSpy() });
  const result = await compactWithoutThrow(compaction, { session }, controller.signal);
  assert.equal(result.replaced, 0);
  assert.deepEqual(session.appends, []);
});

test('H6 refusing either append reports failure and leaves the original query on the surface', async () => {
  const { createQueryCompaction } = await requireHost();
  for (const refusedIndex of [1, 2]) {
    const { session, queryResult } = fakeCanonicalSession();
    assertUsedQueryFixture(session);
    const beforeNodes = session.surface.nodes;
    const beforeTokens = session.surfaceTokens;
    const original = structuredClone(queryResult);
    session.failAppendAt(refusedIndex);
    const compaction = createQueryCompaction({ enabled: () => true, tokenMeter: session.meter, logger: loggerSpy() });
    const result = await compactWithoutThrow(compaction, { session });
    assert.ok(result.failed >= 1, `append ${refusedIndex} refusal must increase failed`);
    assert.equal(result.replaced, 0);
    assert.equal(session.errors.length, 1, 'fixture precondition: the requested append was actually refused');
    assert.deepEqual(session.surface.nodes, beforeNodes, 'an interrupted pair must not change the visible surface');
    assert.equal(session.surfaceTokens, beforeTokens, 'an interrupted pair must not deduct the original query price');
    assert.ok(session.surface.nodes.includes(queryResult.seq));
    assert.deepEqual(session.eventAt(queryResult.seq), original, 'the original durable query must remain intact');
    assert.ok(session.deriveMessages().some(message => message.id === original.data.message.id && textOf(message) === textOf(original.data.message)));
  }
});

test('H7 catch-up and live fold yield the same own candidates and ignore the inherited prefix', async () => {
  const { createQueryCompaction } = await requireHost();
  const inherited = canonicalLog();
  const cut = inherited.length;
  const own = canonicalLog({
    from: cut,
    query: queryExchange(1, 1, { callId: 'q-own', messageId: 'm-q-own', answer: { catalogId: 'catalog-own' } }),
    dispatch: dispatchExchange(1, 2, { callId: 'd-own', messageId: 'm-d-own', metaPatch: { callId: 'd-own', catalogId: 'catalog-own' }, args: { preset: 'researcher', catalogId: 'catalog-own', task: 'own work' } }),
  });
  const log = [...inherited, ...own];
  const options = { header: sessionHeader(), inheritedEventCount: cut };
  const caughtUp = createFakeSession(log, options);
  const streamed = createFakeSession([], options);
  const compaction = createQueryCompaction({ enabled: () => true, tokenMeter: caughtUp.meter, logger: loggerSpy() });
  const expected = compressionCandidates(referenceState(caughtUp), caughtUp);
  assert.equal(expected.length, 1, 'fixture/core precondition: one own query is eligible');
  assert.equal(expected[0].catalogId, 'catalog-own');
  assert.ok(expected[0].querySeq >= cut);
  const catchUpCandidates = compressionCandidates(compaction.stateOf(caughtUp), caughtUp);
  compaction.stateOf(streamed); // The state exists before the first live event arrives.
  for (const event of log) {
    const { type, data, surfaceOp, sourceEventSeqs } = event;
    const committed = streamed.append(type, data, {
      ...(surfaceOp === undefined ? {} : { surfaceOp }),
      ...(sourceEventSeqs === undefined ? {} : { sourceEventSeqs }),
    });
    compaction.fold(streamed, committed);
  }
  const liveCandidates = compressionCandidates(compaction.stateOf(streamed), streamed);
  assert.deepEqual(catchUpCandidates, expected, 'catch-up must include own events and exclude inherited events');
  assert.deepEqual(liveCandidates, expected, 'fold must store each reducer result and respect the same cut');
  assert.deepEqual(liveCandidates, catchUpCandidates);
});

test('H8 stateOf catches up once per session object; fold is inert before a state exists', async () => {
  const { createQueryCompaction } = await requireHost();
  const { session } = fakeCanonicalSession();
  assertUsedQueryFixture(session);
  const calls = [];
  const snapshot = session.snapshotEvents.bind(session);
  session.snapshotEvents = (...args) => { calls.push(args); return snapshot(...args); };
  const compaction = createQueryCompaction({ enabled: () => true, tokenMeter: session.meter, logger: loggerSpy() });
  for (const event of session.events) compaction.fold(session, event);
  assert.deepEqual(calls, [], 'fold on an unseen session must not initialize or catch up state');
  const first = compaction.stateOf(session);
  assert.strictEqual(compaction.stateOf(session), first, 'repeated stateOf must return the cached state');
  assert.deepEqual(calls, [[session.inheritedEventCount]], 'catch-up reads exactly once from the inherited cut');
  assert.equal(compressionCandidates(first, session).length, 1, 'pre-state fold must not duplicate the catch-up facts');
  const sameIdOtherObject = createFakeSession([], { header: session.header });
  const otherState = compaction.stateOf(sameIdOtherObject);
  assert.notStrictEqual(otherState, first, 'states must be keyed by session object, not header id');
  assert.deepEqual(compressionCandidates(otherState, sameIdOtherObject), []);
});

test('H9 registration compacts before next, returns its exact result, and disposes both listeners once', async () => {
  const { registerQueryCompaction } = await requireHost();
  const { session } = fakeCanonicalSession();
  assertUsedQueryFixture(session);
  const ctx = fakeContext();
  const disposer = registerQueryCompaction(ctx, { enabled: () => true, tokenMeter: session.meter, logger: loggerSpy() });
  assertRegistered(ctx, disposer);
  const decision = { kind: 'enter', custom: { retained: true } };
  let nextCalls = 0;
  try {
    const returned = await ctx.listeners.get('agent/pre-step')(preStepPayload({ session }), async () => {
      nextCalls += 1;
      assert.deepEqual(session.appends.map(event => event.type), ['compaction/prune', 'tool/result'], 'compression must finish before next runs');
      return decision;
    });
    assert.strictEqual(returned, decision, 'the next decision must be returned without cloning or substitution');
    assert.equal(nextCalls, 1);
  } finally {
    assertDisposedTwice(ctx, disposer);
  }
});

test('H10 registration warns on a compression-path exception and still returns next unchanged', async () => {
  const { registerQueryCompaction } = await requireHost();
  const { session } = fakeCanonicalSession();
  assertUsedQueryFixture(session);
  const ctx = fakeContext();
  const logger = loggerSpy();
  const fault = new Error('injected compression enabled() failure');
  let enabledCalls = 0;
  const disposer = registerQueryCompaction(ctx, {
    enabled: () => { enabledCalls += 1; throw fault; }, tokenMeter: session.meter, logger,
  });
  assertRegistered(ctx, disposer);
  const decision = { kind: 'enter', retained: true };
  let nextCalls = 0;
  try {
    let returned;
    await assert.doesNotReject(async () => {
      returned = await ctx.listeners.get('agent/pre-step')(preStepPayload({ session }), async () => { nextCalls += 1; return decision; });
    }, 'an exception from compression dependencies must not reject pre-step');
    assert.ok(enabledCalls >= 1, 'fault injection must actually be reached');
    assert.ok(logger.warnings.length >= 1, 'compression exceptions must be warned about, not silently swallowed');
    assert.strictEqual(returned, decision);
    assert.equal(nextCalls, 1);
    assert.deepEqual(session.appends, []);
  } finally {
    assertDisposedTwice(ctx, disposer);
  }
});

test('H10b registration still returns next when an unexpected exception escapes compact', async () => {
  const { registerQueryCompaction } = await requireHost();
  const { session } = fakeCanonicalSession();
  assertUsedQueryFixture(session);
  const ctx = fakeContext();
  let warnCalls = 0;
  const warnings = [];
  // compact's error-reporting dependency fails ONCE. This forces an exception to escape compact
  // without requiring an unfrozen injection API or mutating a production export. The outer hook's
  // warning then succeeds, so the test isolates its catch-and-continue behavior.
  const logger = {
    warn(...args) {
      warnCalls += 1;
      if (warnCalls === 1) throw new Error('injected first warning failure');
      warnings.push(args);
    },
  };
  const disposer = registerQueryCompaction(ctx, {
    enabled: () => { throw new Error('injected enabled failure'); }, tokenMeter: session.meter, logger,
  });
  assertRegistered(ctx, disposer);
  const decision = { kind: 'enter', retained: true };
  let nextCalls = 0;
  try {
    let returned;
    await assert.doesNotReject(async () => {
      returned = await ctx.listeners.get('agent/pre-step')(preStepPayload({ session }), async () => { nextCalls += 1; return decision; });
    }, 'the hook must continue even when compact unexpectedly throws');
    assert.ok(warnCalls >= 2, 'the injected escaped exception must reach the hook warning path');
    assert.ok(warnings.length >= 1, 'the outer hook must warn after catching the escaped exception');
    assert.strictEqual(returned, decision);
    assert.equal(nextCalls, 1);
    assert.deepEqual(session.appends, []);
  } finally {
    assertDisposedTwice(ctx, disposer);
  }
});

test('H11 session/event registration folds live events after pre-step initialized the session', async () => {
  const { registerQueryCompaction } = await requireHost();
  const session = createFakeSession();
  const ctx = fakeContext();
  const disposer = registerQueryCompaction(ctx, { enabled: () => true, tokenMeter: session.meter, logger: loggerSpy() });
  assertRegistered(ctx, disposer);
  const agent = { session };
  const decision = { kind: 'enter' };
  try {
    assert.strictEqual(await ctx.listeners.get('agent/pre-step')(preStepPayload(agent), async () => decision), decision);
    assert.deepEqual(session.appends, []);
    for (const event of canonicalLog()) {
      const { type, data, surfaceOp, sourceEventSeqs } = event;
      const committed = session.append(type, data, {
        ...(surfaceOp === undefined ? {} : { surfaceOp }),
        ...(sourceEventSeqs === undefined ? {} : { sourceEventSeqs }),
      });
      ctx.listeners.get('session/event')(session, committed);
    }
    assertUsedQueryFixture(session);
    const appendCount = session.appends.length;
    assert.strictEqual(await ctx.listeners.get('agent/pre-step')(preStepPayload(agent), async () => decision), decision);
    assert.deepEqual(session.appends.slice(appendCount).map(event => event.type), ['compaction/prune', 'tool/result'], 'live session/event facts must make the used query eligible');
  } finally {
    assertDisposedTwice(ctx, disposer);
  }
});

test('H12 work and dispatch results remain intact; only compact preset_list can be replaced', async () => {
  const { createQueryCompaction } = await requireHost();
  // Deliberately give unrelated work the catalog-shaped content too: content similarity must not
  // turn a different tool's result into a query. Also retain a diagnostic preset_list result.
  const log = canonicalLog({ after: [
    turnStart(2), stepStart(2, 1),
    ...queryExchange(2, 1, { name: 'read', callId: 'work', messageId: 'm-work', content: queryContent() }),
    stepEnd(2, 1), stepStart(2, 2),
    ...queryExchange(2, 2, { callId: 'q-diagnostic', messageId: 'm-diagnostic', args: { diagnostic: true }, answer: { catalog: { mode: 'diagnostic' } } }),
    stepEnd(2, 2), turnEnd(2),
  ] });
  const session = createFakeSession(log);
  const candidate = assertUsedQueryFixture(session);
  assert.equal(candidate.catalogId, CATALOG_ID);
  const preserved = [DISPATCH_CALL_ID, 'work', 'q-diagnostic'].map(callId => {
    const event = log.find(item => item.type === 'tool/result' && item.data.message.source.callId === callId);
    assert.ok(event, `fixture precondition: ${callId} result exists`);
    return structuredClone(event);
  });
  const compaction = createQueryCompaction({ enabled: () => true, tokenMeter: session.meter, logger: loggerSpy() });
  const result = await compactWithoutThrow(compaction, { session });
  assert.equal(result.replaced, 1);
  assert.equal(session.appends.length, 2, 'only the one compact query may produce a prune/replacement pair');
  assert.deepEqual(session.appends[0].data.shadowedSeqs, [candidate.querySeq]);
  assert.deepEqual(session.appends[1].opts.sourceEventSeqs, [candidate.querySeq]);
  assert.equal(session.appends[1].data.message.source.callId, QUERY_CALL_ID);
  for (const event of preserved) {
    assert.ok(session.surface.nodes.includes(event.seq), `${event.data.message.source.callId} must stay model-visible`);
    assert.deepEqual(session.eventAt(event.seq), event, 'non-query durable result must not change');
  }
});

test('H13 enabled must be exactly true; missing agent session and enabled exceptions never throw', async () => {
  const { createQueryCompaction } = await requireHost();
  for (const value of [undefined, null, 0, 1, 'true']) {
    const { session } = fakeCanonicalSession();
    assertUsedQueryFixture(session);
    const compaction = createQueryCompaction({ enabled: () => value, tokenMeter: session.meter, logger: loggerSpy() });
    const result = await compactWithoutThrow(compaction, { session });
    assert.equal(result.disabled, true, 'truthy values other than boolean true must not enable compression');
    assert.deepEqual(session.appends, []);
  }
  const logger = loggerSpy();
  const compaction = createQueryCompaction({ enabled: () => true, tokenMeter: { estimateMessage: () => 1 }, logger });
  const missing = await compactWithoutThrow(compaction, {});
  assert.equal(missing.replaced, 0);
  const { session } = fakeCanonicalSession();
  const failing = createQueryCompaction({ enabled: () => { throw new Error('injected enabled failure'); }, tokenMeter: session.meter, logger });
  await compactWithoutThrow(failing, { session });
  assert.deepEqual(session.appends, []);
});
