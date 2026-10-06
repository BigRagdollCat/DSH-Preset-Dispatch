// Phase B contract tests: planned vs. observed dispatch routing (docs/08 V03/V04/V10,
// docs/09 T04). These assert what the modules actually export today against the behaviour
// the requirements demand, so a requirement the candidate does not meet reads as a failing
// assertion rather than as a passing absence.
//
// What is asserted here, and why each one is user-observable:
//  - a PLAN is never rendered as an actual request (V03/V10);
//  - only the child's own committed `request/header` produces an observed value (V03);
//  - an undisclosed effort becomes "adapter default / unknown", never a guessed level (V04);
//  - the CURRENT value is the first request, later headers are recorded changes, and a
//    replayed log folds to the same result as the live projection (V08/V10);
//  - the Host projection definition initializes from the session header and only reacts to
//    `request/header`, so registering it cannot corrupt another session's projection (T04).
//
// Not run by this author: execution belongs to the test-verification role.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OBSERVATION_STATE_VERSION, OBSERVATION_STATUSES, ROUTE_SOURCES, ROUTE_PROJECTION_KEY,
  routeOf, planRouting, sourceLabel, routeText, emptyObservationState, applyObservationEvent,
  observationFromPlan, observationCreated, observationWithEvents, observationFinished,
  routingView, verificationLabel, observationSummary, createRouteProjectionDefinition,
} from '../dispatch-observation.js';

/** One committed `request/header` exactly as the child session log records it. */
function headerEvent(route, { seq = 4, time = 1000 + seq, adapterDefaults = null } = {}) {
  return {
    type: 'request/header',
    seq,
    time,
    data: { header: { config: { ...route }, ...(adapterDefaults === null ? {} : { adapterDefaults }) } },
  };
}

const FLASH_HIGH = { provider: 'opencode-go', model: 'deepseek-v4.1-flash', reasoningEffort: 'high' };

// ---------------------------------------------------------------------------------------------
// A. The pure route helpers never invent a value.
// ---------------------------------------------------------------------------------------------

test('B-V03 routeOf keeps only disclosed fields and reports nothing for an empty route', () => {
  assert.deepEqual(routeOf(FLASH_HIGH), FLASH_HIGH, 'a complete route is carried as it was given');
  assert.deepEqual(routeOf({ provider: 'p', model: 'm', reasoningEffort: '  ' }), { provider: 'p', model: 'm', reasoningEffort: null }, 'a blank effort is not a level');
  assert.deepEqual(routeOf({ provider: 'p', model: 'm', secret: 'leak', task: 'do it' }), { provider: 'p', model: 'm', reasoningEffort: null }, 'undeclared fields must not travel with a route');
  assert.equal(routeOf({}), null, 'an all-empty config discloses nothing');
  assert.equal(routeOf(null), null);
  assert.equal(routeOf([{ provider: 'p' }]), null, 'an array is not a route');
});

test('B-V04 planRouting defaults every unknown source to unknown instead of guessing', () => {
  const plan = planRouting({ provider: 'p', model: 'm' });
  assert.equal(plan.modelSource, 'unknown');
  assert.equal(plan.effortSource, 'unknown');
  assert.equal(plan.reasoningEffort, null, 'a plan without an explicit effort must not invent one');
  assert.equal(plan.presetVersion, null, 'a missing preset version must stay absent rather than become 0');

  const explicit = planRouting({ provider: 'p', model: 'm', reasoningEffort: 'high', modelSource: 'explicit', effortSource: 'parent-inherited', presetVersion: 3 });
  assert.equal(explicit.effortSource, 'parent-inherited', 'an inherited effort is not the same fact as an explicit one');
  assert.equal(explicit.presetVersion, 3);
});

test('B-V04 every declared route source has its own human label', () => {
  const labels = ROUTE_SOURCES.map(sourceLabel);
  for (const label of labels) assert.equal(typeof label === 'string' && label.length > 0, true, 'a source without a label would render as a code');
  assert.equal(new Set(labels).size, labels.length, 'two distinct sources must not read as the same origin');
  assert.equal(sourceLabel('unknown'), '未知来源');
});

test('B-V04 routeText discloses an adapter default as undisclosed rather than naming a level', () => {
  const disclosed = routeText(FLASH_HIGH, 'explicit');
  assert.match(disclosed, /opencode-go \/ deepseek-v4\.1-flash/);
  assert.match(disclosed, /high/);
  assert.match(disclosed, /主代理指定/);

  const adapter = routeText({ provider: 'p', model: 'm', reasoningEffort: null }, 'adapter-default');
  assert.match(adapter, /模型默认（具体值未披露）/, 'an adapter default must state that the concrete level is unknown');
  assert.doesNotMatch(adapter, /\b(low|medium|high)\b/, 'no concrete level may be printed for an undisclosed default');

  assert.equal(routeText(null, 'unknown'), '未知');
  assert.equal(routeText({}, 'unknown'), '未知');
});

// ---------------------------------------------------------------------------------------------
// B. Folding a child session's own committed events.
// ---------------------------------------------------------------------------------------------

test('B-V03 an unrelated event returns the identical state reference and observes nothing', () => {
  const state = emptyObservationState();
  for (const event of [
    { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } },
    { type: 'assistant/message', seq: 2, time: 2, data: {} },
    { type: 'request/header', seq: 3, time: 3, data: {} },
    { type: 'request/header', seq: 4, time: 4, data: { header: { config: {} } } },
    null,
    undefined,
  ]) {
    assert.equal(applyObservationEvent(state, event), state, `${JSON.stringify(event)} must not move the observation`);
  }
  assert.equal(state.observed, null);
  assert.equal(observationSummary(state).verified, false);
});

test('B-V03 the first committed request header is the observed routing, with its log position', () => {
  const state = applyObservationEvent(emptyObservationState(), headerEvent(FLASH_HIGH, { seq: 4 }));
  assert.deepEqual(state.observed, FLASH_HIGH, 'the observed value comes from the committed header, not from a plan');
  assert.equal(state.observedSeq, 4, 'the observed value must be traceable to the log position that proved it');
  assert.equal(state.observedAt, 1004);
  assert.equal(state.requestHeaders, 1);
  assert.deepEqual(state.changes, []);
});

test('B-V08 a repeated identical header counts a request but is not reported as a configuration change', () => {
  let state = applyObservationEvent(emptyObservationState(), headerEvent(FLASH_HIGH, { seq: 4 }));
  const first = state.observed;
  state = applyObservationEvent(state, headerEvent(FLASH_HIGH, { seq: 9 }));
  assert.equal(state.requestHeaders, 2, 'every request header must be counted');
  assert.deepEqual(state.changes, [], 'an unchanged route is not a change');
  assert.equal(state.observed, first, 'the current value must not be replaced by an identical one');
  assert.deepEqual(state.observed, FLASH_HIGH);
});

test('B-V04/B-V08 a later different header is recorded as a change and does not replace the first observation', () => {
  let state = applyObservationEvent(emptyObservationState(), headerEvent(FLASH_HIGH, { seq: 4 }));
  const switched = { provider: 'codex-chatgpt', model: 'gpt-6.1-sol', reasoningEffort: 'medium' };
  state = applyObservationEvent(state, headerEvent(switched, { seq: 12 }));
  assert.deepEqual(state.observed, FLASH_HIGH, 'the first actual request stays the current actual');
  assert.equal(state.requestHeaders, 2);
  assert.equal(state.changes.length, 1, 'the second configuration must be verifiable as a change');
  assert.deepEqual(state.changes[0].route, switched);
  assert.equal(state.changes[0].seq, 12, 'a change must carry the position that proves it');
});

test('B-V04 an adapter-declared effort default is marked as such instead of being guessed', () => {
  const anonymous = { provider: 'p', model: 'm' };
  const state = applyObservationEvent(emptyObservationState(), headerEvent(anonymous, { seq: 4, adapterDefaults: { reasoningEffort: true } }));
  assert.equal(state.observed.reasoningEffort, null, 'no effort was disclosed, so none may be stored');
  const flagged = applyObservationEvent(state, headerEvent(anonymous, { seq: 8 }));
  assert.equal(flagged.adapterEffortDefault, true, 'the first request adapter default must remain an observation-level fact');
  assert.deepEqual(flagged.changes, [], 'the same route is not a configuration change');

  const view = routingView(flagged);
  assert.equal(view.observedEffortSource, 'adapter-default', 'an undisclosed adapter default is not an unknown for the same reason as a missing value');
  assert.equal(view.observed.reasoningEffort, null, 'the view must not invent a concrete default level');
  assert.doesNotMatch(routeText(view.observed, view.observedEffortSource), /\b(low|medium|high)\b/, 'no undisclosed level may be rendered');
});

test('B-V08 replay older than the former 256-event window never counts another request', () => {
  const events = Array.from({ length: 300 }, (_, index) => headerEvent(FLASH_HIGH, { seq: index + 1 }));
  const state = events.reduce(applyObservationEvent, emptyObservationState());
  assert.equal(state.requestHeaders, 300, 'every newly committed header is counted once');
  assert.deepEqual(state.changes, [], 'the long prefix has no route changes');
  const replayed = applyObservationEvent(state, events[0]);
  assert.equal(replayed.requestHeaders, 300, 'an old sequence below the high-water mark stays consumed after 256 later events');
  assert.deepEqual(replayed.observed, state.observed);
  assert.equal(replayed.observedSeq, 1);
  assert.deepEqual(replayed.changes, [], 'replay must not invent a configuration change');
  const fresh = applyObservationEvent(replayed, headerEvent(FLASH_HIGH, { seq: 301 }));
  assert.equal(fresh.requestHeaders, 301, 'a genuinely later sequence still counts');
});

test('B-V08 A -> B -> B -> B records B only once across repeated headers', () => {
  const switched = { provider: 'codex-chatgpt', model: 'gpt-6.1-sol', reasoningEffort: 'medium' };
  const events = [FLASH_HIGH, switched, switched, switched].map((route, index) => headerEvent(route, { seq: index + 1 }));
  const state = events.reduce(applyObservationEvent, emptyObservationState());
  assert.equal(state.requestHeaders, 4, 'repeats are requests, not route changes');
  assert.deepEqual(state.observed, FLASH_HIGH, 'the first actual request remains visible');
  assert.deepEqual(state.changes.map(change => ({ seq: change.seq, route: change.route })), [{ seq: 2, route: switched }], 'repeated B headers must retain the B comparison baseline');
});

test('B-V08 A -> B -> B -> A records the return to A after a repeated B', () => {
  const switched = { provider: 'codex-chatgpt', model: 'gpt-6.1-sol', reasoningEffort: 'medium' };
  const events = [FLASH_HIGH, switched, switched, FLASH_HIGH].map((route, index) => headerEvent(route, { seq: index + 1 }));
  const state = events.reduce(applyObservationEvent, emptyObservationState());
  assert.equal(state.requestHeaders, 4);
  assert.deepEqual(state.observed, FLASH_HIGH, 'changes never overwrite the first actual request');
  assert.deepEqual(state.changes.map(change => ({ seq: change.seq, route: change.route })), [
    { seq: 2, route: switched }, { seq: 4, route: FLASH_HIGH },
  ], 'returning to A is a change from B even when B was repeated');
});

// ---------------------------------------------------------------------------------------------
// C. Lifecycle: plan, created, fold, finish.
// ---------------------------------------------------------------------------------------------

test('B-V03 a dispatch that has only a plan is never rendered as the actual request', () => {
  const observation = observationFromPlan({ childSessionId: 'c1', callId: 'call-1', plannedRouting: { ...FLASH_HIGH, modelSource: 'preset-default', effortSource: 'preset-default', presetVersion: 2 }, at: 1000 });
  assert.equal(observation.state, 'pending');
  assert.equal(observation.childSessionId, 'c1');
  assert.equal(observation.callId, 'call-1');

  const view = routingView(observation);
  assert.equal(view.verified, false, 'a plan is not verification');
  assert.equal(view.observed, null);
  assert.deepEqual(view.planned.provider, 'opencode-go');

  const label = verificationLabel(observation);
  assert.equal(label.verified, false);
  assert.match(label.label, /计划配置/, 'a live plan is labelled as a plan');
  assert.doesNotMatch(label.label, /已核实/);
});

test('B-V10 a restored record without an observation is labelled as unverified history, not as a plan', () => {
  const restored = observationFinished(observationFromPlan({ plannedRouting: FLASH_HIGH, at: 1 }), 'completed', { at: 2 });
  const label = verificationLabel(restored, { restored: true });
  assert.equal(label.verified, false);
  assert.match(label.label, /历史配置，未核实实际请求/, 'a restored record must say its actual request was never verified');
});

test('B-V07 creating the child reserves the id without turning the plan into an actual', () => {
  const observation = observationCreated(observationFromPlan({ callId: 'call-1', plannedRouting: FLASH_HIGH, at: 5 }), { childSessionId: 'c9', at: 6 });
  assert.equal(observation.state, 'created', 'the child exists but has committed no request yet');
  assert.equal(observation.childSessionId, 'c9');
  assert.equal(observation.createdAt, 5, 'the plan time must not be overwritten by the creation time');
  assert.equal(observation.observed, null, 'a reserved id is not proof of a request');
  assert.equal(routingView(observation).verified, false);
});

test('B-V03 folding the child log is idempotent for the same event list', () => {
  const observation = observationCreated(observationFromPlan({ plannedRouting: FLASH_HIGH }), { childSessionId: 'c1' });
  const events = [headerEvent(FLASH_HIGH, { seq: 4 }), { type: 'turn/end', seq: 5, time: 1005, data: { turn: 1 } }];
  const once = observationWithEvents(observation, events);
  const twice = observationWithEvents(once, events);
  assert.equal(once.state, 'observed');
  assert.deepEqual(once.observed, FLASH_HIGH);
  assert.equal(once.requestHeaders, 1, 'replaying the same event list must not double-count requests');
  assert.deepEqual(twice.observed, once.observed);
  assert.equal(twice.requestHeaders, 1, 'folding is a fold of the log, not an accumulation of calls');
  assert.equal(twice.observedSeq, once.observedSeq);
});

test('B-V08 a completed run keeps the observed request; a cancelled run never promotes its plan', () => {
  const observed = observationWithEvents(observationFromPlan({ plannedRouting: FLASH_HIGH }), [headerEvent(FLASH_HIGH, { seq: 4 })]);
  const finished = observationFinished(observed, 'completed', { at: 2000 });
  assert.equal(finished.state, 'finished');
  assert.equal(finished.finishedAt, 2000);
  assert.deepEqual(routingView(finished).observed, FLASH_HIGH, 'a finished run must still show what it actually used');
  assert.equal(routingView(finished).verified, true);

  const aborted = observationFinished(observationFromPlan({ plannedRouting: FLASH_HIGH }), 'aborted', { at: 3000 });
  assert.equal(aborted.state, 'interrupted');
  assert.equal(routingView(aborted).verified, false, 'a cancelled dispatch must not present its plan as an actual request');
  assert.deepEqual(routingView(aborted).observed, null);

  assert.equal(observationFinished(observationFromPlan(), 'failed').state, 'failed');
  for (const status of OBSERVATION_STATUSES) assert.equal(typeof status, 'string');
});

test('B-V10 the summary carries the status, both routings and the honest verification line', () => {
  const observation = observationFinished(observationWithEvents(observationFromPlan({ plannedRouting: { ...FLASH_HIGH, modelSource: 'preset-default', effortSource: 'preset-default' } }), [headerEvent(FLASH_HIGH, { seq: 4 })]), 'completed', { at: 9 });
  const summary = observationSummary(observation);
  assert.equal(summary.status, 'finished');
  assert.equal(summary.verified, true);
  assert.deepEqual(summary.observed, FLASH_HIGH);
  assert.equal(summary.planned.provider, 'opencode-go', 'the plan stays visible beside the actual so the two can be compared');
  assert.equal(summary.verification, '实际请求（已核实）');
  assert.match(summary.detail, /4/, 'the verification detail names the request position it was read from');
  assert.deepEqual(summary.changes, []);
});

// ---------------------------------------------------------------------------------------------
// D. The Host projection definition.
// ---------------------------------------------------------------------------------------------

/** The Host's own schema library: callable, no `.parse`, no `.strict`, no `.nullable`. */
function hostLikeSchema() {
  const z = {
    any: () => value => value,
    array: inner => value => (Array.isArray(value) ? value.map(inner) : value),
    object: shape => value => value,
  };
  return z;
}

test('B-V10 the projection definition declares its own key and version', () => {
  const definition = createRouteProjectionDefinition(hostLikeSchema());
  assert.equal(definition.key, ROUTE_PROJECTION_KEY);
  assert.equal(definition.stateVersion, OBSERVATION_STATE_VERSION);
  assert.equal(typeof definition.init, 'function');
  assert.equal(typeof definition.apply, 'function');
  assert.equal(typeof definition.wire?.view, 'function');
  assert.equal(typeof definition.stateSchema?.parse, 'function', 'the Host registry validates state through stateSchema.parse');
});

test('B-V07 the projection initializes from its own session header and never from the fork parent', () => {
  const definition = createRouteProjectionDefinition(hostLikeSchema());
  const state = definition.init({ agentPreset: 'researcher', parentSession: 'p1', origin: 'subagent' }, 7);
  assert.equal(state.agentPreset, 'researcher');
  assert.equal(state.parentSession, 'p1');
  assert.equal(state.origin, 'subagent');
  assert.equal(state.firstLive, 7, 'the fork cut is the borrowed prefix length');
  assert.equal(state.observed, null, 'an inherited prefix is the parent history, not this child routing');
  assert.equal(state.requestHeaders, 0);

  const anonymous = definition.init(undefined, null);
  assert.equal(anonymous.agentPreset, null);
  assert.equal(anonymous.parentSession, null);
  assert.equal(anonymous.firstLive, null);
});

test('B-V03 the projection reacts only to request/header and exposes verification only for a real observation', () => {
  const definition = createRouteProjectionDefinition(hostLikeSchema());
  const initial = definition.init({ agentPreset: 'researcher', parentSession: 'p1', origin: 'subagent' }, 0);
  assert.equal(definition.wire.view(initial).verified, false, 'a child with no committed request has nothing verified');

  const unrelated = { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } };
  assert.equal(definition.apply(initial, unrelated), initial, 'an unrelated event must not allocate a new state');

  const observed = definition.apply(initial, headerEvent(FLASH_HIGH, { seq: 4 }));
  assert.deepEqual(observed.observed, FLASH_HIGH);
  assert.equal(observed.observedSeq, 4);
  assert.equal(observed.agentPreset, 'researcher', 'folding must not drop the session identity');
  assert.equal(observed.parentSession, 'p1');

  const view = definition.wire.view(observed);
  assert.equal(view.verified, true);
  assert.deepEqual(view.observed, FLASH_HIGH);
  assert.equal(view.observedSeq, 4);
  assert.equal(view.agentPreset, 'researcher', 'the view must carry the identity for the badge to place itself');
  assert.equal(view.parentSession, 'p1');
});

test('B-V08 the projection view is reference-stable while the state is unchanged and fresh after a change', () => {
  const definition = createRouteProjectionDefinition(hostLikeSchema());
  const state = definition.apply(definition.init({ agentPreset: 'researcher' }, 0), headerEvent(FLASH_HIGH, { seq: 4 }));
  const first = definition.wire.view(state);
  assert.equal(definition.wire.view(state), first, 'an unchanged state must not publish a new view object');
  const moved = definition.apply(state, headerEvent({ provider: 'p', model: 'other', reasoningEffort: 'low' }, { seq: 20 }));
  const next = definition.wire.view(moved);
  assert.notEqual(next, first);
  assert.deepEqual(next.observed, FLASH_HIGH, 'a later request does not redefine the first actual request');
});
