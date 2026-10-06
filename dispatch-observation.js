// Planned vs. observed dispatch configuration (docs/08 V03/V04/V10, docs/09 T04).
//
// One dispatch is described by two separate values and they are never mixed:
//
//   - the PLAN is what this plugin decided to ask for before the child existed
//     (preset policy default, explicit request, or the parent route);
//   - the OBSERVED routing is what the child's own committed `request/header`
//     event recorded, which is the only place a real request proves itself.
//
// A plan is not evidence. The admission preflight (`llm.resolveCallConfig`) is
// not evidence either: it validates a proposal and never reaches a session log,
// so it is never written into the observed side. When a value is not disclosed
// anywhere, the observation says `unknown` instead of guessing — an adapter may
// supply a default the caller never sees.
//
// Everything here is pure and synchronous: the same functions fold live events
// and a replayed log, which is what makes the projection and the visibility API
// agree without a second implementation.
export const OBSERVATION_STATE_VERSION = 1;

/** Lifecycle of one dispatch as far as this plugin can honestly observe it. */
export const OBSERVATION_STATUSES = ['pending', 'created', 'observed', 'finished', 'failed', 'interrupted'];
/** Where a displayed route value came from. `unknown` means: not disclosed here. */
export const ROUTE_SOURCES = ['explicit', 'preset-default', 'parent-inherited', 'adapter-default', 'unknown'];
/** Projection key registered on the Host session projection registry. */
export const ROUTE_PROJECTION_KEY = 'presetDispatchRoute';

const isObject = value => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = value => (typeof value === 'string' && value.trim() !== '' ? value : null);
const effortOf = value => (typeof value === 'string' && value.trim() !== '' ? value : null);
/**
 * Upper bound on the `seq` history kept for schema compatibility. Correctness no longer depends
 * on this list: `maxSeenSeq` is the high-water mark that decides whether an event was folded
 * before, so replaying an event older than the retained window cannot be counted twice.
 */
const MAX_SEEN_SEQS = 256;
/** Upper bound on the recorded configuration changes a state keeps. */
const MAX_CHANGES = 8;

/** Copy one route, keeping only the three disclosed fields and dropping empties. */
export function routeOf(value) {
  if (!isObject(value)) return null;
  const route = { provider: text(value.provider), model: text(value.model), reasoningEffort: effortOf(value.reasoningEffort) };
  if (!route.provider && !route.model && !route.reasoningEffort) return null;
  return route;
}

/** JSON-safe snapshot of a routing plan (provider/model/effort plus their stated sources). */
export function planRouting(input = {}) {
  return {
    provider: text(input.provider), model: text(input.model), reasoningEffort: effortOf(input.reasoningEffort),
    modelSource: text(input.modelSource) ?? 'unknown', effortSource: text(input.effortSource) ?? 'unknown',
    presetVersion: Number.isSafeInteger(input.presetVersion) ? input.presetVersion : null,
  };
}

/** Human-readable origin of a route value; used by the card, the badge and the history page. */
export function sourceLabel(source) {
  switch (source) {
    case 'explicit': return '主代理指定';
    case 'preset-default': return '预设默认';
    case 'parent-inherited': return '父代理继承';
    case 'adapter-default': return '适配器默认';
    default: return '未知来源';
  }
}

/** One-line description of a route for a narrow surface; never invents a value. */
export function routeText(route, source, { unknown = '未知' } = {}) {
  if (!route || (!route.provider && !route.model)) return unknown;
  const head = route.provider && route.model ? `${route.provider} / ${route.model}` : (route.model || route.provider);
  const effort = route.reasoningEffort ? route.reasoningEffort : (source === 'adapter-default' ? '模型默认（具体值未披露）' : '强度未知');
  return `${head} · ${effort}（${sourceLabel(source)}）`;
}

/** The empty observation state for one child session (also the projection's init shape). */
export function emptyObservationState() {
  return {
    observed: null, observedSeq: null, observedAt: null, firstLive: null,
    requestHeaders: 0, changes: [],
    // An observation-level fact, not a per-change one: the adapter declared an effort default of
    // its own, so a header that discloses no effort is that default rather than an unknown.
    adapterEffortDefault: false,
    // The highest `seq` already folded. Any event at or below it was folded before, so replaying
    // a log — or a catch-up read over a prefix that was already seen — cannot count a request
    // twice, however old the repeated event is. -1 means "nothing folded yet".
    maxSeenSeq: -1,
    // The `seq` values already folded, kept for schema compatibility only.
    seenSeqs: [],
    // The configuration currently in force for this observation: the value a later header is
    // compared against. It is set when the first header establishes `observed` and replaced only
    // when the route really changes, so a repeat is not a change and a return to it is.
    baseline: null,
  };
}

/** The observation-bearing fields of one state, defaulted and detached. */
function observationFields(state) {
  const current = isObject(state) ? state : {};
  const seenSeqs = Array.isArray(current.seenSeqs) ? current.seenSeqs.filter(seq => Number.isSafeInteger(seq)) : [];
  // A state written before the high-water mark existed still has its retained `seq` window, so the
  // mark is derived from it rather than reset to -1: a replay of those events must stay idempotent.
  const carried = Number.isSafeInteger(current.maxSeenSeq) ? current.maxSeenSeq : -1;
  return {
    observed: isObject(current.observed) ? current.observed : null,
    observedSeq: Number.isSafeInteger(current.observedSeq) ? current.observedSeq : null,
    observedAt: Number.isSafeInteger(current.observedAt) ? current.observedAt : null,
    firstLive: Number.isSafeInteger(current.firstLive) ? current.firstLive : null,
    requestHeaders: Number.isSafeInteger(current.requestHeaders) && current.requestHeaders > 0 ? current.requestHeaders : 0,
    changes: Array.isArray(current.changes) ? current.changes : [],
    adapterEffortDefault: current.adapterEffortDefault === true,
    maxSeenSeq: seenSeqs.reduce((highest, seq) => (seq > highest ? seq : highest), carried),
    seenSeqs,
    baseline: isObject(current.baseline) ? current.baseline : null,
  };
}

/**
 * Fold one committed session event into an observation state.
 *
 * Only `request/header` matters, and only the first one is the "actual" routing:
 * later headers are recorded as verifiable changes rather than replacing the
 * first observation. An unrelated event returns the same reference, which is
 * what keeps the projection drive cheap.
 *
 * Folding one event list twice returns the same state: an event whose `seq` was
 * already folded is ignored, so a live feed and a catch-up read over the same log
 * cannot count the same request twice. An event without a `seq` can carry no such
 * proof and is only ever folded when it really changes the recorded configuration.
 */
export function applyObservationEvent(state, event) {
  const current = isObject(state) ? state : emptyObservationState();
  if (!isObject(event) || event.type !== 'request/header') return current;
  const header = event.data?.header;
  if (!isObject(header)) return current;
  const config = isObject(header.config) ? header.config : {};
  const adapterDefaults = isObject(header.adapterDefaults) ? header.adapterDefaults : {};
  const route = routeOf(config);
  if (!route) return current;
  const seq = Number.isSafeInteger(event.seq) ? event.seq : null;
  const time = Number.isSafeInteger(event.time) ? event.time : null;
  const fields = observationFields(current);
  // High-water dedup: every event at or below the mark was folded already, so the same log — or a
  // catch-up read that repeats a prefix — cannot count one request twice. The retained `seenSeqs`
  // window is only a schema-compatible trace and never decides this.
  if (seq !== null && seq <= fields.maxSeenSeq) return current;
  const adapterEffort = adapterDefaults.reasoningEffort === true;
  const seenSeqs = seq === null ? fields.seenSeqs : [...fields.seenSeqs, seq].slice(-MAX_SEEN_SEQS);
  const maxSeenSeq = seq === null ? fields.maxSeenSeq : Math.max(fields.maxSeenSeq, seq);
  // Every other key the caller's state carries (a projection state's `agentPreset`,
  // `parentSession` and `origin`, for instance) is carried over untouched: this fold only owns
  // the observation fields, and dropping a foreign key here would corrupt the projection.
  const next = (patch = {}) => ({
    ...current,
    observed: fields.observed, observedSeq: fields.observedSeq, observedAt: fields.observedAt,
    adapterEffortDefault: fields.adapterEffortDefault || adapterEffort,
    changes: fields.changes, baseline: fields.baseline,
    requestHeaders: fields.requestHeaders + 1, maxSeenSeq, seenSeqs,
    ...patch,
  });
  if (fields.observed === null) {
    // The first committed request IS the configuration in force, so it also becomes the baseline a
    // later header is compared against: A -> B records B once, and A -> B -> A records the return.
    const established = { seq, time, route, ...(adapterEffort ? { effortFromAdapter: true } : {}) };
    return next({ observed: route, observedSeq: seq, observedAt: time, baseline: established });
  }
  const baseline = fields.baseline ?? { seq: fields.observedSeq, time: fields.observedAt, route: fields.observed };
  const baselineAdapter = fields.baseline === null ? fields.adapterEffortDefault : fields.baseline.effortFromAdapter === true;
  if (JSON.stringify(baseline.route) === JSON.stringify(route) && (adapterEffort || fields.adapterEffortDefault) === baselineAdapter) {
    // A repeat of the configuration in force: the request is counted, the adapter-declared default
    // is learned, and no change is recorded. The baseline is left exactly as it was.
    return next();
  }
  // The configuration really changed, so the new value becomes the baseline: it is now what is in
  // force, and a later repeat of it is not another change.
  const change = { seq, time, route, ...(adapterEffort ? { effortFromAdapter: true } : {}) };
  return next({ changes: [...fields.changes, change].slice(-MAX_CHANGES), baseline: change });
}

/** Start an observation: the plan is known, no request has been observed yet. */
export function observationFromPlan({ childSessionId = null, callId = null, plannedRouting = null, at = null } = {}) {
  const planned = isObject(plannedRouting) ? plannedRouting : null;
  const plan = planRouting({
    provider: planned?.provider, model: planned?.model, reasoningEffort: planned?.reasoningEffort,
    modelSource: planned?.modelSource, effortSource: planned?.effortSource, presetVersion: planned?.presetVersion,
  });
  return {
    state: 'pending',
    childSessionId,
    callId,
    plan,
    ...emptyObservationState(),
    createdAt: at,
    finishedAt: null,
  };
}

/** The child session now exists under the reserved id: still no observed request. */
export function observationCreated(observation, { childSessionId = null, at = null } = {}) {
  const current = isObject(observation) ? observation : observationFromPlan();
  return { ...current, state: 'created', childSessionId: childSessionId ?? current.childSessionId, createdAt: current.createdAt ?? at };
}

/**
 * Fold the child's committed events into the observation. Idempotent per event list:
 * `applyObservationEvent` ignores a `seq` it has already folded, so folding a log that was
 * partly folded before — or the same list twice — lands on the same state. When nothing new was
 * learned the INPUT reference is returned, which is how a caller tells "no news" from a change.
 */
export function observationWithEvents(observation, events = []) {
  const current = isObject(observation) ? observation : observationFromPlan();
  let state = { ...current, ...observationFields(current) };
  for (const event of events) state = applyObservationEvent(state, event);
  const next = { ...state, state: state.observed ? 'observed' : current.state };
  const unchanged = next.observed === current.observed
    && next.observedSeq === current.observedSeq
    && next.adapterEffortDefault === current.adapterEffortDefault
    && next.requestHeaders === current.requestHeaders
    && next.changes === current.changes
    && next.seenSeqs.length === (Array.isArray(current.seenSeqs) ? current.seenSeqs.length : 0)
    && next.state === current.state;
  return unchanged ? current : next;
}

/**
 * Settle an observation with the dispatch outcome. A cancelled or failed
 * dispatch keeps whatever was observed; it never turns a plan into an actual.
 */
export function observationFinished(observation, status, { at = null, childSessionId = null } = {}) {
  const current = isObject(observation) ? observation : observationFromPlan();
  const state = status === 'completed' ? 'finished' : status === 'aborted' || status === 'interrupted' ? 'interrupted' : 'failed';
  return { ...current, state, childSessionId: childSessionId ?? current.childSessionId, finishedAt: at };
}

/**
 * The two displayed routing values plus how far each is verified. A caller that
 * only has the plan must render `verified: false` and say the actual request is
 * unconfirmed — that is the V10 rule for restored and unfinished records.
 */
export function routingView(observation) {
  const current = isObject(observation) ? observation : null;
  const plan = isObject(current?.plan) ? current.plan : null;
  const observed = isObject(current?.observed) ? current.observed : null;
  // The adapter-declared default is its own recorded fact, never inferred from a missing value:
  // a header that simply omitted an effort discloses nothing about where its effort came from.
  const effortFromAdapter = current?.adapterEffortDefault === true;
  const observedEffortSource = effortOf(observed?.reasoningEffort) === null
    ? (effortFromAdapter ? 'adapter-default' : 'unknown')
    : (plan?.effortSource === 'preset-default' ? 'preset-default' : plan?.effortSource ?? 'unknown');
  return {
    planned: plan ? { ...plan } : null,
    observed: observed ? { ...observed } : null,
    verified: observed !== null,
    observedSeq: current?.observedSeq ?? null,
    observedEffortSource,
    changes: (current?.changes ?? []).map(change => ({
      seq: change.seq ?? null, time: change.time ?? null, route: routeOf(change.route),
      ...(change.effortFromAdapter === true ? { effortFromAdapter: true } : {}),
    })),
  };
}

/**
 * The honest status line for a record. `verified: false` is rendered as a
 * planning value or as an unverified historical record, never as an actual.
 */
export function verificationLabel(observation, { restored = false } = {}) {
  const view = routingView(observation);
  if (view.verified) return { verified: true, label: '实际请求（已核实）', detail: view.observedSeq === null ? '' : `请求序号 ${view.observedSeq}` };
  if (restored) return { verified: false, label: '历史配置，未核实实际请求', detail: '' };
  return { verified: false, label: '计划配置，尚未观察到实际请求', detail: '' };
}

/** Compact summary the history page and the card both render. */
export function observationSummary(observation, { restored = false } = {}) {
  const view = routingView(observation);
  const label = verificationLabel(observation, { restored });
  const status = isObject(observation) ? observation.state : 'pending';
  const plan = view.planned;
  const observed = view.observed;
  return {
    status,
    verified: view.verified,
    planned: plan ? { provider: plan.provider, model: plan.model, reasoningEffort: plan.reasoningEffort, modelSource: plan.modelSource, effortSource: plan.effortSource } : null,
    observed,
    observedEffortSource: view.observedEffortSource,
    changes: view.changes,
    // The verification line and its detail are carried by name as well as spread: a consumer that
    // reads `summary.verification` and `summary.detail` (the visibility API does) must not depend
    // on the spread alone surviving.
    verification: label.label,
    detail: label.detail,
    ...label,
  };
}

/**
 * Build a schema for the Host projection registry from the validator it was handed.
 *
 * `z` is expected to be a real `zod` instance (the Host dependency `host.js` loads for the
 * durable history schema). The registry validates a state through `stateSchema.parse(value)`, so
 * a `.parse` method is attached when the built schema has none — a callable schema library that
 * validates by being called (as `@deepseek-ai/schemastery` does) then works through the same
 * entry point. `.loose()` is used when the library offers it so unknown keys survive a parse;
 * zod's objects are non-stripping already, so its absence is not a compatibility loss.
 */
function sharedSchema(z, shape) {
  const object = z.object(shape);
  const schema = typeof object?.loose === 'function' ? object.loose() : object;
  if (schema && typeof schema.parse !== 'function' && typeof schema === 'function') {
    schema.parse = value => schema(value);
  }
  return schema;
}

/**
 * The Host projection definition for `ROUTE_PROJECTION_KEY`.
 *
 * The unit folds one child session's own committed events: its preset identity
 * comes from the immutable header, its actual route from the first
 * `request/header`. It deliberately does not read the fork parent's headers as
 * this session's routing — an inherited prefix is the parent's history, not
 * this child's request.
 *
 * @param z - the Host's own schema validator.
 * @returns a definition accepted by `ctx.sessionProjections.register`.
 */
export function createRouteProjectionDefinition(z) {
  const stateSchema = sharedSchema(z, {
    agentPreset: z.any(), parentSession: z.any(), origin: z.any(),
    firstLive: z.any(),
    observed: z.any(), observedSeq: z.any(), observedAt: z.any(),
    requestHeaders: z.any(), changes: z.array(z.any()),
    // Declared so a validating registry keeps them: without them the projection would lose the
    // adapter-default fact, the replay high-water mark and the change baseline on every parse.
    adapterEffortDefault: z.any(), maxSeenSeq: z.any(), seenSeqs: z.array(z.any()), baseline: z.any(),
  });
  const viewSchema = sharedSchema(z, {
    agentPreset: z.any(), parentSession: z.any(), origin: z.any(),
    observed: z.any(), observedSeq: z.any(), verified: z.any(),
  });
  const buildView = state => ({
    agentPreset: state.agentPreset ?? null,
    parentSession: state.parentSession ?? null,
    origin: state.origin ?? null,
    observed: state.observed ?? null,
    observedSeq: state.observedSeq ?? null,
    verified: state.observed !== null && state.observed !== undefined,
  });
  let viewCache = { state: null, view: null };
  return {
    key: ROUTE_PROJECTION_KEY,
    stateVersion: OBSERVATION_STATE_VERSION,
    stateSchema,
    init(header, inheritedEventCount) {
      const inherited = Number.isSafeInteger(inheritedEventCount) ? inheritedEventCount : null;
      return {
        agentPreset: text(header?.agentPreset),
        parentSession: text(header?.parentSession),
        origin: text(header?.origin),
        ...emptyObservationState(),
        // The fork cut is written AFTER the empty observation state is spread: that state carries
        // its own `firstLive: null`, so setting it before the spread would reset the borrowed
        // prefix length and leave the `seq < state.firstLive` guard in `apply` unreachable.
        firstLive: inherited,
      };
    },
    apply(state, event) {
      if (!isObject(state) || !isObject(event) || event.type !== 'request/header') return state;
      // A forked session inherits its parent's committed prefix. A `request/header` from that
      // prefix is the PARENT's request, so folding it would mark this child as having verified a
      // request it never made. Only events at or after the first live event belong to this child.
      if (Number.isSafeInteger(state.firstLive) && Number.isSafeInteger(event.seq) && event.seq < state.firstLive) return state;
      return applyObservationEvent({ ...state, ...observationFields(state) }, event);
    },
    wire: {
      viewSchema,
      view(state) {
        // Reuse the object reference while the state reference is unchanged: the
        // registry suppresses publication by `Object.is` on the view result.
        if (viewCache.state !== state) viewCache = { state, view: buildView(state) };
        return viewCache.view;
      },
    },
  };
}
