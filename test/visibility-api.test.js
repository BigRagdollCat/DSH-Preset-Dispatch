// Phase B contract tests for the read-only dispatch visibility face
// (GET /api/preset-dispatch/visibility, docs/08 V05-V10, docs/09 T04/T07).
//
// These are behavioural assertions about what the endpoint does with a request, not about how
// it is written: who may open a stream, which record a caller may reach, what a frame may
// contain, and when the subscription is released. Each one is user-observable through the
// dispatch card and the subagent badge, or through a privacy/authorization boundary.
//
// The four boundaries asserted here:
//  1. authentication — the same operator gate as every other route on this plugin;
//  2. binding — a record is served only to the session it belongs to, and the child's own
//     header must agree with the stated parent;
//  3. content — metadata only, never task, answer, reasoning or credential text;
//  4. lifecycle — a closed connection, a cancelled run and an unloaded plugin each release
//     the subscription, and one row's update is never pushed to another row's stream.
//
// Not run by this author: execution belongs to the test-verification role.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_ID_LENGTH, parseVisibilityQuery, visibilityPayload, resolveVisibility, registerVisibilityApi,
} from '../visibility-api.js';

// ---------------------------------------------------------------------------------------------
// Harness: a recorded response, a loopback-authenticated request and a history double.
// ---------------------------------------------------------------------------------------------

/** The auth gate's own view of a request: accepted unless a test says otherwise. */
const acceptedConnection = (rejection = undefined) => ({
  requestRejection: () => rejection,
  // The loopback/port the gate verifies; the stream handler itself must not need a real socket.
  describe: () => ({ address: '127.0.0.1', port: 3080 }),
});

function makeRequest(url, { headers = {}, method = 'GET', remoteAddress = '127.0.0.1' } = {}) {
  const listeners = new Map();
  return {
    url, method, socket: { remoteAddress },
    headers: { host: '127.0.0.1:3080', ...headers },
    on(name, fn) { listeners.set(name, fn); return this; },
    off(name) { listeners.delete(name); return this; },
    removeListener(name) { listeners.delete(name); return this; },
    emit(name) { const fn = listeners.get(name); if (fn) fn(); },
    listenerCount(name) { return listeners.has(name) ? 1 : 0; },
  };
}

function makeResponse() {
  const listeners = new Map();
  return {
    status: null, headers: null, frames: [], ended: false, headersFlushed: false,
    writeHead(status, headers) { this.status = status; this.headers = headers; return this; },
    write(chunk) { this.frames.push(String(chunk)); return true; },
    end(body) { if (body !== undefined) this.frames.push(String(body)); this.ended = true; return this; },
    flushHeaders() { this.headersFlushed = true; },
    on(name, fn) { listeners.set(name, fn); return this; },
    off(name) { listeners.delete(name); return this; },
    removeListener(name) { listeners.delete(name); return this; },
    emit(name) { const fn = listeners.get(name); if (fn) fn(); },
    listenerCount(name) { return listeners.has(name) ? 1 : 0; },
  };
}

/** Parse the SSE frames a response recorded into `{ event, data }` pairs. */
const framesOf = response => response.frames.map(raw => {
  const event = /^event: (.+)$/m.exec(raw)?.[1] ?? null;
  const data = /^data: (.+)$/m.exec(raw)?.[1] ?? null;
  return { event, data: data === null ? null : JSON.parse(data) };
});

function makeHistory(rows) {
  const subscribers = new Set();
  return {
    subscribers,
    list: () => rows.map(row => ({ ...row })),
    subscribe(listener) { subscribers.add(listener); return () => { subscribers.delete(listener); }; },
    /** Publish a change exactly as a real record write does. */
    notify(row, kind = 'update') {
      const index = rows.findIndex(existing => existing.id === row.id);
      if (index === -1) rows.push(row);
      else rows[index] = row;
      for (const listener of [...subscribers]) listener(row, kind);
    },
  };
}

function makeCtx({ rejection = undefined } = {}) {
  const registered = [];
  return {
    ctx: {
      connection: acceptedConnection(rejection),
      logger: { warn() {} },
      webServer: { register: route => { registered.push(route); return () => { route.disposed = true; }; } },
    },
    registered,
  };
}

/** Register the route and return its handler plus the captured route registration. */
function mount({ history, liveFor = () => null, sessions = () => null, lifetime = null, rejection = undefined, restored = false } = {}) {
  const { ctx, registered } = makeCtx({ rejection });
  const dispose = registerVisibilityApi(ctx, { history, liveFor, sessions, lifetime, restored });
  return { handler: registered[0]?.handler, route: registered[0], dispose, registered };
}

const CALL_ID = 'call-1';
const CHILD_ID = 'child-1';
const PARENT_ID = 'parent-1';
const rowOf = (patch = {}) => ({ id: 'run-1', preset: 'researcher', presetName: 'Researcher', presetVersion: 2, callId: CALL_ID, childSessionId: CHILD_ID, parentSession: PARENT_ID, status: 'running', ...patch });

// ---------------------------------------------------------------------------------------------
// A. Query parsing: the endpoint is a bounded lookup, never a listing.
// ---------------------------------------------------------------------------------------------

test('V07 the query accepts a real request URL and requires one dispatch identifier', () => {
  const parsed = parseVisibilityQuery(new URL(`http://127.0.0.1:3080/api/preset-dispatch/visibility?callId=${CALL_ID}&childSessionId=${CHILD_ID}&parentSession=${PARENT_ID}`));
  assert.equal(parsed.error, undefined);
  assert.equal(parsed.callId, CALL_ID);
  assert.equal(parsed.childSessionId, CHILD_ID);
  assert.equal(parsed.parentSession, PARENT_ID);

  assert.deepEqual(parseVisibilityQuery('/api/preset-dispatch/visibility?childSessionId=c1'), { callId: null, childSessionId: 'c1', parentSession: null });
  assert.equal(parseVisibilityQuery('/api/preset-dispatch/visibility').error, 'callId or childSessionId is required', 'a bare listing request must be refused');
  assert.equal(parseVisibilityQuery('/api/preset-dispatch/visibility?parentSession=p').error, 'callId or childSessionId is required', 'a parent alone does not address one record');
});

test('V07 a malformed or oversized query parameter is refused before any record is read', () => {
  assert.equal(parseVisibilityQuery('/api/preset-dispatch/visibility?callId=%20%20').error, 'empty callId');
  assert.equal(parseVisibilityQuery('/api/preset-dispatch/visibility?childSessionId=').error, 'empty childSessionId');
  const tooLong = 'x'.repeat(MAX_ID_LENGTH + 1);
  assert.match(String(parseVisibilityQuery(`/api/preset-dispatch/visibility?childSessionId=${tooLong}`).error), /too long/, 'an unbounded id must be refused rather than looked up');
  assert.equal(String(parseVisibilityQuery(`/api/preset-dispatch/visibility?callId=${'y'.repeat(MAX_ID_LENGTH)}`).error), 'undefined', 'an id at the limit is still acceptable');
  assert.equal(typeof parseVisibilityQuery('http://[bad').error, 'string', 'an unparsable URL is an error, not a throw');
});

// ---------------------------------------------------------------------------------------------
// B. Binding: a caller reaches only the record that belongs to its session.
// ---------------------------------------------------------------------------------------------

test('V07 an unknown id is honestly pending, and a bare 404 is never the answer', () => {
  const history = makeHistory([rowOf()]);
  const outcome = resolveVisibility({ callId: 'nope', childSessionId: null, parentSession: null }, { history });
  assert.equal(outcome.kind, 'pending', 'a starting or unknown run must read as pending, never as an error an EventSource would retry');
  assert.equal(outcome.payload.pending, true);
  assert.equal(outcome.payload.verified, false, 'an unknown run has nothing verified');
  assert.equal('task' in outcome.payload, false);
});

test('V07 a stated parent that is not the record parent is refused instead of served', () => {
  const history = makeHistory([rowOf()]);
  const mine = resolveVisibility({ callId: CALL_ID, childSessionId: null, parentSession: PARENT_ID }, { history });
  assert.equal(mine.kind, 'row', 'the owning session must reach its own record');

  for (const query of [
    { callId: CALL_ID, childSessionId: null, parentSession: 'someone-else-session' },
    { callId: null, childSessionId: CHILD_ID, parentSession: 'someone-else-session' },
  ]) {
    assert.equal(resolveVisibility(query, { history }).kind, 'mismatch', `parent ${query.parentSession} must not read another session's dispatch record`);
  }
});

test('V07 every supplied id must match, and a parent-bound record requires its parent', () => {
  const history = makeHistory([rowOf()]);
  assert.equal(resolveVisibility({ callId: CALL_ID, childSessionId: 'other-child', parentSession: PARENT_ID }, { history }).kind, 'mismatch', 'the record may not be served under an id it does not own');
  assert.equal(resolveVisibility({ callId: 'other-call', childSessionId: CHILD_ID, parentSession: PARENT_ID }, { history }).kind, 'mismatch');
  assert.equal(resolveVisibility({ callId: null, childSessionId: CHILD_ID, parentSession: PARENT_ID }, { history }).kind, 'row', 'a child lookup with the matching parent is valid');
  assert.equal(resolveVisibility({ callId: null, childSessionId: CHILD_ID, parentSession: null }, { history }).kind, 'mismatch', 'a child id alone must not expose a parent-bound record');
  assert.equal(resolveVisibility({ callId: CALL_ID, childSessionId: null, parentSession: null }, { history }).kind, 'mismatch', 'a call id alone must not expose a parent-bound record');
  const noChild = makeHistory([rowOf({ childSessionId: null })]);
  assert.equal(resolveVisibility({ callId: CALL_ID, childSessionId: CHILD_ID, parentSession: PARENT_ID }, { history: noChild }).kind, 'mismatch', 'a supplied child id must not match an absent record id');
  const noCall = makeHistory([rowOf({ callId: null })]);
  assert.equal(resolveVisibility({ callId: CALL_ID, childSessionId: CHILD_ID, parentSession: PARENT_ID }, { history: noCall }).kind, 'mismatch', 'a supplied call id must not match an absent record id');
});

test('V07 a record without a parent still follows its own child, and a historical record stays readable', () => {
  const history = makeHistory([rowOf({ parentSession: null })]);
  const outcome = resolveVisibility({ callId: CALL_ID, childSessionId: null, parentSession: null }, { history });
  assert.equal(outcome.kind, 'row', 'an older record without a parent column must not become unreachable');
  assert.equal(outcome.payload.parentSession, null, 'the absence is reported as absence, not filled in from the query');

  const legacy = makeHistory([rowOf({ observedRouting: null, observationState: null, plannedRouting: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' } })]);
  const view = resolveVisibility({ callId: CALL_ID, childSessionId: null, parentSession: PARENT_ID }, { history: legacy });
  assert.equal(view.kind, 'row');
  assert.equal(view.payload.verified, false, 'a record with no observed request must not read as verified');
  assert.match(view.payload.verification, /计划配置|历史配置/);
});

test('V07 a live child whose own header names another parent is refused as a mismatch', () => {
  const history = makeHistory([rowOf()]);
  const sessions = () => ({ header: { parentSession: 'a-different-parent' } });
  assert.equal(resolveVisibility({ callId: CALL_ID, childSessionId: null, parentSession: PARENT_ID }, { history, sessions }).kind, 'mismatch', 'the child header is the authority on its own parent');
  const agreeing = () => ({ header: { parentSession: PARENT_ID } });
  assert.equal(resolveVisibility({ callId: CALL_ID, childSessionId: null, parentSession: PARENT_ID }, { history, sessions: agreeing }).kind, 'row', 'an agreeing header must not block a legitimate read');
});

// ---------------------------------------------------------------------------------------------
// C. Content: metadata only.
// ---------------------------------------------------------------------------------------------

test('V09 a served payload carries dispatch metadata and never task, answer or credential text', () => {
  const secret =
    'task: exfiltrate the private key; answer: the reasoning chain; apiKey: sk-live-0123456789';
  const row = rowOf({
    task: secret, answer: secret, reasoning: secret, output: secret, apiKey: secret, draft: secret,
    plannedRouting: { provider: 'opencode-go', model: 'deepseek-v4.1-flash', reasoningEffort: 'high', modelSource: 'preset-default', effortSource: 'preset-default' },
    observedRouting: { provider: 'opencode-go', model: 'deepseek-v4.1-flash', reasoningEffort: 'high' },
  });
  const payload = visibilityPayload(row, { live: { childSessionId: CHILD_ID, observation: null } });
  const serialized = JSON.stringify(payload);
  for (const key of ['task', 'answer', 'reasoning', 'output', 'apiKey', 'draft', 'messages', 'prompt']) {
    assert.equal(key in payload, false, `the payload must not carry ${key}`);
  }
  assert.doesNotMatch(serialized, /exfiltrate|private key|reasoning chain|sk-live/, 'no payload text may leak through a nested field');
  assert.equal(payload.callId, CALL_ID, 'the identifiers a UI needs must be present');
  assert.equal(payload.childSessionId, CHILD_ID);
  assert.equal(payload.preset, 'researcher');
  assert.equal(payload.presetVersion, 2, 'the dispatch-time snapshot must be what is served');
  assert.equal(payload.verified, true);
  assert.equal(payload.observed.reasoningEffort, 'high');
});

test('V10 a live observation decides verification, and a row without one stays unverified', () => {
  const planned = { provider: 'opencode-go', model: 'deepseek-v4.1-flash' };
  const withObservation = visibilityPayload(rowOf({ observedRouting: { provider: 'p', model: 'other' } }), {
    live: { childSessionId: CHILD_ID, observation: { state: 'pending', plan: { ...planned, modelSource: 'preset-default', effortSource: 'preset-default' }, observed: null, observedSeq: null, changes: [] } },
  });
  assert.equal(withObservation.observed, null, 'a stored routing column must not override a live plan that has observed nothing');

  const withoutObservation = visibilityPayload(rowOf({ observedRouting: { provider: 'opencode-go', model: 'deepseek-v4.1-flash', reasoningEffort: 'high' } }), { live: null, restored: true });
  assert.equal(withoutObservation.verified, true, 'a stored observed routing is itself evidence of a committed request');
  assert.equal(withoutObservation.restored, true, 'a restored record must say so');
  assert.equal(withoutObservation.observationStatus, 'pending', 'a record with no observation state must not claim one');
  assert.equal(withoutObservation.status, 'running');
});

// ---------------------------------------------------------------------------------------------
// D. The route: authentication, framing and lifecycle.
// ---------------------------------------------------------------------------------------------

test('V09 the route registers exactly one plugin-owned path and returns a real disposer', () => {
  const history = makeHistory([rowOf()]);
  const { route, dispose, registered } = mount({ history });
  assert.equal(registered.length, 1, 'the visibility face must own exactly one route');
  assert.equal(route.kind, 'exact', 'a prefix route would capture unrelated paths');
  assert.equal(route.path, '/api/preset-dispatch/visibility');
  assert.equal(typeof route.handler, 'function');
  assert.equal(typeof dispose, 'function', 'the plugin must be able to withdraw the route');
  dispose();
  assert.equal(route.disposed, true);
});

test('V07 no route is claimed when there is nothing to serve', () => {
  const oneRoute = () => { const registered = []; return { registered, ctx: { connection: acceptedConnection(), logger: { warn() {} }, webServer: { register: route => { registered.push(route); return () => {}; } } } }; };

  const missing = oneRoute();
  assert.equal(registerVisibilityApi(missing.ctx, { history: null }), null, 'without a history port there is nothing to serve');
  assert.equal(missing.registered.length, 0, 'a route must not be claimed before it can answer');

  const unsubscribable = oneRoute();
  assert.equal(registerVisibilityApi(unsubscribable.ctx, { history: { list: () => [] } }), null, 'a history without subscribe cannot push a change, so no route may be claimed');
  assert.equal(unsubscribable.registered.length, 0);

  const servable = oneRoute();
  assert.equal(typeof registerVisibilityApi(servable.ctx, { history: makeHistory([rowOf()]) }), 'function', 'a real history must produce a disposer');
  assert.equal(servable.registered.length, 1);
});

test('V01 an unauthenticated caller is refused with a JSON error and opens no subscription', () => {
  const history = makeHistory([rowOf()]);
  const { handler } = mount({ history });
  const req = makeRequest(`/api/preset-dispatch/visibility?callId=${CALL_ID}&parentSession=${PARENT_ID}`, { remoteAddress: '10.0.0.7' });
  const res = makeResponse();
  handler(req, res);
  assert.equal(res.status, 400, 'the operator gate must answer the request itself');
  assert.match(String(res.headers['content-type']), /application\/json/);
  assert.match(res.frames.join(''), /Authenticated operator request required|Loopback access required/);
  assert.equal(history.subscribers.size, 0, 'a refused request must not subscribe to anything');
  assert.equal(res.headersFlushed, false);
});

test('V01 a connection the operator gate rejects is refused before the query is even read', () => {
  const history = makeHistory([rowOf()]);
  const { handler } = mount({ history, rejection: { status: 403, reason: 'not authenticated' } });
  const req = makeRequest(`/api/preset-dispatch/visibility?callId=${CALL_ID}&parentSession=${PARENT_ID}`);
  const res = makeResponse();
  handler(req, res);
  assert.equal(res.status, 400, 'the gate rejection is reported as a refusal, not as a stream');
  assert.match(res.frames.join(''), /Authenticated operator request required/);
  assert.equal(history.subscribers.size, 0, 'an unauthenticated request must never observe record changes');
  assert.equal(req.listenerCount('close'), 0, 'a refused request must not keep a listener');
});

test('V09 a method other than GET is refused by the same gate', () => {
  const history = makeHistory([rowOf()]);
  const { handler } = mount({ history });
  const res = makeResponse();
  handler(makeRequest(`/api/preset-dispatch/visibility?callId=${CALL_ID}&parentSession=${PARENT_ID}`, { method: 'POST' }), res);
  assert.equal(res.status, 400);
  assert.match(res.frames.join(''), /Method not allowed/);
  assert.equal(history.subscribers.size, 0);
});

test('V07 a malformed query is a typed 400 rather than an empty stream', () => {
  const history = makeHistory([rowOf()]);
  const { handler } = mount({ history });
  const res = makeResponse();
  handler(makeRequest('/api/preset-dispatch/visibility'), res);
  assert.equal(res.status, 400);
  assert.match(res.frames.join(''), /callId or childSessionId is required/);
  assert.equal(history.subscribers.size, 0, 'no record may be touched for an unaddressed request');
});

test('V07 a caller naming another session is refused with 403 and is never subscribed', () => {
  const history = makeHistory([rowOf()]);
  const { handler } = mount({ history });
  const res = makeResponse();
  handler(makeRequest(`/api/preset-dispatch/visibility?callId=${CALL_ID}&parentSession=someone-else`), res);
  assert.equal(res.status, 403, "another session's record must be refused, not streamed");
  assert.match(res.frames.join(''), /not related|not.*related/i);
  assert.equal(history.subscribers.size, 0);
});

test('V07 a parent-bound row cannot open a snapshot stream with an omitted parent or conflicting id', () => {
  const history = makeHistory([rowOf()]);
  const { handler } = mount({ history });
  for (const query of [
    `childSessionId=${CHILD_ID}`,
    `callId=${CALL_ID}`,
    `callId=${CALL_ID}&childSessionId=${CHILD_ID}`,
    `callId=${CALL_ID}&childSessionId=other-child&parentSession=${PARENT_ID}`,
    `callId=other-call&childSessionId=${CHILD_ID}&parentSession=${PARENT_ID}`,
  ]) {
    const req = makeRequest('/api/preset-dispatch/visibility?' + query);
    const res = makeResponse();
    handler(req, res);
    assert.equal(res.status, 403, `${query}: all recorded identifiers and the parent binding must match`);
    assert.match(String(res.headers['content-type']), /application\/json/, `${query}: rejection is not a stream`);
    assert.doesNotMatch(res.frames.join(''), /event: snapshot/, `${query}: no snapshot may escape through the route`);
    assert.equal(history.subscribers.size, 0, `${query}: a refused lookup may not subscribe`);
    assert.equal(req.listenerCount('close'), 0, `${query}: rejection retains no stream listener`);
  }
});

test('V05 an authenticated caller receives the current value as an immediate SSE snapshot', () => {
  const history = makeHistory([rowOf({ observedRouting: { provider: 'opencode-go', model: 'deepseek-v4.1-flash', reasoningEffort: 'high' } })]);
  const { handler } = mount({ history });
  const req = makeRequest(`/api/preset-dispatch/visibility?callId=${CALL_ID}&parentSession=${PARENT_ID}`);
  const res = makeResponse();
  handler(req, res);

  assert.equal(res.status, 200);
  assert.match(String(res.headers['content-type']), /text\/event-stream/, 'the card and the badge both consume an event stream');
  assert.equal(res.headers['cache-control'], 'no-store', 'a stale cached frame would show a finished run as running');
  assert.equal(res.headersFlushed, true, 'the stream must open immediately, not wait for the first change');
  const frames = framesOf(res);
  assert.equal(frames.length, 1, 'the current value is the first frame');
  assert.equal(frames[0].event, 'snapshot');
  assert.equal(frames[0].data.callId, CALL_ID);
  assert.equal(frames[0].data.verified, true);
  assert.equal(frames[0].data.observed.model, 'deepseek-v4.1-flash');
  assert.equal(history.subscribers.size, 1, 'later changes are pushed, so one subscription must exist');
});

test('V10 a run with nothing recorded yet reports pending instead of claiming a configuration', () => {
  const history = makeHistory([]);
  const { handler } = mount({ history });
  const req = makeRequest(`/api/preset-dispatch/visibility?childSessionId=${CHILD_ID}`);
  const res = makeResponse();
  handler(req, res);
  const frames = framesOf(res);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].event, 'pending', 'an unknown run must not be framed as a snapshot fact');
  assert.equal(frames[0].data.pending, true);
  assert.equal(frames[0].data.verified, false);
});

test('V07 a pending stream ignores unrelated row updates and receives its later matching snapshot', () => {
  const unrelated = rowOf({ id: 'run-other', callId: 'call-other', childSessionId: 'child-other', parentSession: 'parent-other' });
  const history = makeHistory([unrelated]);
  const { handler, dispose } = mount({ history });
  const req = makeRequest(`/api/preset-dispatch/visibility?callId=${CALL_ID}&parentSession=${PARENT_ID}`);
  const res = makeResponse();
  try {
    handler(req, res);
    assert.equal(framesOf(res)[0].event, 'pending');
    assert.equal(history.subscribers.size, 1);
    history.notify({ ...unrelated, status: 'completed' }, 'finish');
    assert.equal(res.ended, false, 'an unrelated settled row must not bind or close a pending lookup');
    assert.equal(history.subscribers.size, 1, 'the pending lookup must keep waiting for its own row');
    assert.equal(framesOf(res).length, 1, 'unrelated rows must not send even an extra pending frame');
    history.notify(rowOf());
    const frames = framesOf(res);
    assert.equal(frames.length, 2, 'the later matching row must reach the original stream');
    assert.equal(frames[1].event, 'snapshot');
    assert.equal(frames[1].data.callId, CALL_ID);
    assert.equal(frames[1].data.childSessionId, CHILD_ID);
    assert.equal(frames[1].data.parentSession, PARENT_ID);
    assert.equal(res.ended, false, 'a newly running record still has future changes');
    assert.equal(history.subscribers.size, 1);
  } finally { dispose(); }
});

test('V05 an initially completed record sends one snapshot and closes without a retained subscription', () => {
  const history = makeHistory([rowOf({ status: 'completed' })]);
  const { handler, dispose } = mount({ history });
  const req = makeRequest(`/api/preset-dispatch/visibility?callId=${CALL_ID}&parentSession=${PARENT_ID}`);
  const res = makeResponse();
  try {
    handler(req, res);
    const frames = framesOf(res);
    assert.equal(res.status, 200);
    assert.equal(frames.length, 1, 'the settled record is still delivered before closing');
    assert.equal(frames[0].event, 'snapshot');
    assert.equal(frames[0].data.status, 'completed');
    assert.equal(history.subscribers.size, 0, 'a settled initial snapshot needs no future subscription');
    assert.equal(res.ended, true, 'the stream must close immediately after its terminal snapshot');
    assert.equal(req.listenerCount('close'), 0);
    assert.equal(res.listenerCount('close'), 0);
    history.notify(rowOf({ status: 'failed' }), 'finish');
    assert.equal(framesOf(res).length, 1, 'closed streams never receive another frame');
  } finally { dispose(); }
});

test('V07 one row\'s update is pushed only to the stream that watches that row', () => {
  const mine = rowOf({ id: 'run-mine' });
  const theirs = rowOf({ id: 'run-theirs', callId: 'call-2', childSessionId: 'child-2', parentSession: 'parent-2' });
  const history = makeHistory([mine, theirs]);
  const { handler } = mount({ history });

  const mineRes = makeResponse();
  handler(makeRequest(`/api/preset-dispatch/visibility?callId=${CALL_ID}&parentSession=${PARENT_ID}`), mineRes);
  const theirsRes = makeResponse();
  handler(makeRequest(`/api/preset-dispatch/visibility?callId=call-2&parentSession=parent-2`), theirsRes);
  assert.equal(history.subscribers.size, 2, 'each open stream holds its own subscription');
  assert.equal(framesOf(mineRes).length, 1);
  assert.equal(framesOf(theirsRes).length, 1);

  history.notify({ ...theirs, status: 'completed' });
  assert.equal(framesOf(mineRes).length, 1, 'an unrelated row update must never be pushed to this stream');
  assert.equal(framesOf(theirsRes).length, 2, 'the watching stream receives its own row change');
  assert.equal(framesOf(theirsRes)[1].data.status, 'completed');

  history.notify({ ...mine, status: 'failed' });
  assert.equal(framesOf(mineRes).length, 2, 'this stream now receives its own change');
  assert.equal(framesOf(mineRes)[1].data.status, 'failed');
  assert.equal(framesOf(theirsRes).length, 2, 'and the other stream stays untouched');
});

test('V07 a row that stops being related closes its own stream instead of pushing foreign data', () => {
  const history = makeHistory([rowOf()]);
  const { handler } = mount({ history });
  const req = makeRequest(`/api/preset-dispatch/visibility?callId=${CALL_ID}&parentSession=${PARENT_ID}`);
  const res = makeResponse();
  handler(req, res);
  assert.equal(history.subscribers.size, 1);

  history.notify(rowOf({ parentSession: 'a-different-parent' }), 'update');
  assert.equal(res.ended, true, 'a stream whose record no longer belongs to the stated session must be closed');
  assert.equal(history.subscribers.size, 0, 'closing the stream must release its subscription');
  const frames = framesOf(res);
  assert.equal(frames.length, 1, 'no frame may carry the foreign record');
});

test('V09 a disconnected client releases its subscription and its listeners', () => {
  const history = makeHistory([rowOf()]);
  const { handler } = mount({ history });
  const req = makeRequest(`/api/preset-dispatch/visibility?callId=${CALL_ID}&parentSession=${PARENT_ID}`);
  const res = makeResponse();
  handler(req, res);
  assert.equal(history.subscribers.size, 1);
  assert.equal(req.listenerCount('close'), 1, 'the request must be observed for its close event');
  assert.equal(res.listenerCount('close'), 1);

  req.emit('close');
  assert.equal(history.subscribers.size, 0, 'a closed connection must not keep pushing into a dead response');
  assert.equal(res.ended, true);
  assert.equal(req.listenerCount('close'), 0, 'the listeners must be released with the stream');
  assert.equal(res.listenerCount('close'), 0);

  // A second close (a response close after a request close) must be a harmless no-op.
  const before = res.frames.length;
  res.emit('close');
  assert.equal(res.frames.length, before, 'a double close must not write another frame');
});

test('V05 a cancelled run closes only its own stream and leaves the others open', () => {
  const history = makeHistory([rowOf(), rowOf({ id: 'run-2', callId: 'call-2', childSessionId: 'child-2', parentSession: 'parent-2' })]);
  const { handler } = mount({ history });
  const first = makeResponse();
  handler(makeRequest(`/api/preset-dispatch/visibility?callId=${CALL_ID}&parentSession=${PARENT_ID}`), first);
  const second = makeResponse();
  handler(makeRequest(`/api/preset-dispatch/visibility?callId=call-2&parentSession=parent-2`), second);
  assert.equal(history.subscribers.size, 2);

  history.notify(rowOf({ status: 'aborted' }), 'finish');
  assert.equal(first.ended, true, 'an aborted run settles and its stream is closed');
  assert.equal(history.subscribers.size, 1, 'the other run keeps its subscription');
  assert.equal(second.ended, false);
});

test('V09 unloading the plugin closes every open stream and withdraws the route', () => {
  const history = makeHistory([rowOf(), rowOf({ id: 'run-2', callId: 'call-2', childSessionId: 'child-2', parentSession: 'parent-2' })]);
  const lifetime = new AbortController();
  const { handler, route, dispose } = mount({ history, lifetime });
  const first = makeResponse();
  handler(makeRequest(`/api/preset-dispatch/visibility?callId=${CALL_ID}&parentSession=${PARENT_ID}`), first);
  const second = makeResponse();
  handler(makeRequest(`/api/preset-dispatch/visibility?callId=call-2&parentSession=parent-2`), second);
  assert.equal(history.subscribers.size, 2);

  lifetime.abort();
  assert.equal(first.ended, true, 'a plugin unload must not leave a live SSE stream behind');
  assert.equal(second.ended, true);
  assert.equal(history.subscribers.size, 0, 'every subscription must be released on unload');

  const framesAfter = first.frames.length;
  history.notify(rowOf({ status: 'completed' }), 'finish');
  assert.equal(first.frames.length, framesAfter, 'a closed stream must never be written to again');

  dispose();
  assert.equal(route.disposed, true, 'unload must also withdraw the route');
});

test('V09 a lifetime that is already aborted serves nothing at all', () => {
  const history = makeHistory([rowOf()]);
  const lifetime = new AbortController();
  lifetime.abort();
  const { handler } = mount({ history, lifetime });
  const res = makeResponse();
  handler(makeRequest(`/api/preset-dispatch/visibility?callId=${CALL_ID}&parentSession=${PARENT_ID}`), res);
  assert.equal(res.ended, true, 'a stream opened after unload must be closed immediately');
  assert.equal(history.subscribers.size, 0, 'and must not subscribe');
});
