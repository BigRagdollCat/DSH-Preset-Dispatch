// Test-only fixture for the phase C "used query compaction" contract (docs/09 T08/T09, C04-C11).
//
// Everything here is read-only test material: canonical session-log builders, a strict fake
// session whose `append` refuses to lie about what it recorded, the fixed expected meta
// envelopes, and a loader for the REAL installed host packages (`@deepseek-ai/dsh-session`,
// `@deepseek-ai/dsh-token-meter`) so one test can exercise the official surface/append rules
// instead of only a mock. It is imported by test/query-compaction.test.js only, is not part of
// the published package, and must never be imported by production code.
//
// Shapes below were read from the installed host packages, not guessed:
//  - `SessionEvent` envelope: { type, seq, time, data, surfaceOp?, sourceEventSeqs? }
//    (surfaceOp/sourceEventSeqs are REQUIRED on message-producing types and forbidden elsewhere)
//  - `tool/call` data: { turn, step, callId, name, arguments } with `arguments` an unparsed JSON string
//  - `tool/result` data: { turn, step, message, error?, meta? } with message
//    { id, role: 'tool', source: { kind: 'tool', callId }, toolCallId, content, isError? }
//  - `compaction/prune` data: { shadowedRange: { start, end }, shadowedSeqs, shadowedTokenCount },
//    log-only (no surfaceOp), and its replacement must be appended synchronously right after it
//  - a tool/result surface replacement may change ONLY `message.content`
//    (assertToolResultRewrite in dsh-session/lib/types/surface.js)
//
// Two different official events are involved and they must not be confused:
//  - `subagent/catalog` is the PARENT session's direct-child directory fact
//    (dsh-subagent/lib/types/catalog.d.ts, SUBAGENT_CATALOG_VERSION = 0):
//    { version: 0 | 1, childId, childCreatedAt, mode: 'one-shot' | 'continuable' | 'unknown', label? }
//    It is a necessary, exact child pairing — never proof that a child was started.
//  - `subagent/descriptor` is the CHILD's own durable identity, appended once inside the child's
//    initial turn (dsh-subagent/lib/types/descriptor.d.ts, SUBAGENT_DESCRIPTOR_VERSION = 3):
//    { version: 3, mode: 'one-shot' | 'continuable', provider: string, label? } (+ continuable extras)
//    It belongs to the child log, so the parent log below never fabricates one.
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const QUERY_MARKER = 'preset-dispatch/catalog';
export const DISPATCH_MARKER = 'preset-dispatch/run';
export const CATALOG_ID = 'catalog1';
// The official one-shot catalog mode (SUBAGENT_CATALOG_VERSION) and descriptor format
// (SUBAGENT_DESCRIPTOR_VERSION), read from the installed dsh-subagent package.
export const CATALOG_VERSION = 0;
export const DESCRIPTOR_VERSION = 3;
// The `ctx.subagents` provider name that establishes this plugin's children.
export const SUBAGENT_PROVIDER = 'local-preset-dispatch';
// Session ids: a child session id and the parent session id must differ (parent-session id `p`).
export const PARENT_SESSION_ID = 'p';
export const CHILD_SESSION_ID = 'c';
export const CHILD_CREATED_AT = 123;
export const DISPATCH_CALL_ID = 'd';
export const QUERY_CALL_ID = 'q';

/**
 * The frozen session header shape (`SessionHeader` in dsh-session/lib/types/types.d.ts):
 * { version, id, createdAt, isSeeded, parentSession?, cwd?, origin?, ... }. Only `id` is
 * substantive for this suite; the frozen `createQueryState(header, cut)` takes that header.
 */
export function sessionHeader(id = PARENT_SESSION_ID, patch = {}) {
  return { version: 4, id, createdAt: 1, isSeeded: false, ...patch };
}

// ---------------------------------------------------------------------------------------------
// The frozen C contract (main-agent frozen). Tests assert behavior through these exports only.
// ---------------------------------------------------------------------------------------------
export const CONTRACT_EXPORTS = ['createQueryState', 'reduceQueryState', 'compressionCandidates', 'compactQuery'];
export const MISSING_IMPLEMENTATION = 'query compaction implementation missing';

/** The production module this suite pins; absence of exactly this file is the missing feature. */
export const QUERY_COMPACTION_FILE = fileURLToPath(new URL('../../query-compaction.js', import.meta.url));

/**
 * Load the not-yet-existing production module without ever converting absence into an import
 * crash. The missing feature is decided by resolving the production file itself, so a missing
 * *dependency* of that file, an unreadable directory import or any other load error stays an
 * environment failure and is rethrown naming the failing module url. A broken fixture or a
 * broken dependency can therefore never masquerade as the missing implementation.
 */
export async function loadQueryCompaction() {
  let present = true;
  try {
    requireFromHere.resolve('../../query-compaction.js');
  } catch {
    present = false;
  }
  if (!present) {
    return { module: null, error: new Error(`${QUERY_COMPACTION_FILE} does not exist`), missing: true, target: QUERY_COMPACTION_FILE };
  }
  try {
    const module = await import('../../query-compaction.js');
    return { module, error: null, missing: false, target: QUERY_COMPACTION_FILE };
  } catch (error) {
    const where = error?.url ?? `<no url>`;
    throw new Error(`${QUERY_COMPACTION_FILE} exists but could not be loaded (${error?.code ?? error?.name}: ${error?.message ?? error}); the failing module url was ${where} — a missing dependency or an unreadable path is an environment failure, not the missing query compaction feature`);
  }
}

// ---------------------------------------------------------------------------------------------
// Canonical meta envelopes.
// ---------------------------------------------------------------------------------------------

/** Compact preset_list answer, exactly as the C contract states it (and as core.js reports it today). */
export function catalogAnswer(patch = {}) {
  const { catalog: catalogPatch, ...rest } = patch;
  return {
    catalogId: CATALOG_ID,
    catalog: {
      marker: QUERY_MARKER,
      formatVersion: 1,
      mode: 'compact',
      sessionBound: true,
      parentSessionId: PARENT_SESSION_ID,
      // The catalog id correlates records; it is never an authorization ticket.
      authorizationTicket: false,
      ...catalogPatch,
    },
    modelSelectionEnabled: true,
    explicitSelectionAvailable: true,
    models: [{ provider: 'p', model: 'm', name: 'M One', efforts: ['low', 'high'] }],
    presets: [{ id: 'researcher', name: 'Researcher', dispatchable: true }],
    rules: { ownership: '主代理负责调度与最终验收；叶子不派遣。' },
    omittedPresets: 0,
    ...rest,
  };
}

/**
 * The canonical query content wrapper. A canonical query result embeds the catalog answer as JSON
 * text; `mode`/`authorizationTicket` are readable from the parsed `catalog` object.
 */
export function queryContent(patch = {}) {
  return [{ type: 'text', text: JSON.stringify(catalogAnswer(patch)) }];
}

/**
 * Fixed expected dispatch meta for phase C. If the actual B implementation writes different
 * field names, phase C unifies the meta — this object is the target, not a description of
 * whatever the in-memory history happens to hold.
 */
export function dispatchMeta(patch = {}) {
  return {
    marker: DISPATCH_MARKER,
    formatVersion: 1,
    runId: 'run-1',
    childSessionId: CHILD_SESSION_ID,
    parentSessionId: PARENT_SESSION_ID,
    callId: DISPATCH_CALL_ID,
    catalogId: CATALOG_ID,
    preset: 'researcher',
    observationState: 'observed',
    observedRouting: { provider: 'p', model: 'm', reasoningEffort: 'high', requestSeq: 4 },
    status: 'completed',
    ...patch,
  };
}

/**
 * Official `subagent/catalog` payload: the PARENT session's direct-child directory fact for one
 * child (`establishCatalogChild` in dsh-subagent/lib/types/catalog.js). It records identity
 * (childId + childCreatedAt) and the mode/label frozen with the child; it is not a start proof and
 * never carries a child descriptor's `provider`.
 */
export function catalogData(patch = {}) {
  return {
    version: CATALOG_VERSION,
    childId: CHILD_SESSION_ID,
    childCreatedAt: CHILD_CREATED_AT,
    mode: 'one-shot',
    label: 'preset:researcher',
    ...patch,
  };
}

/**
 * Official `subagent/descriptor` payload for the child's OWN log
 * (SUBAGENT_DESCRIPTOR_VERSION = 3, snapshotSubagentDescriptor in dsh-subagent): mode, the
 * establishing provider name, and an optional label. The parent log never gets one of these.
 */
export function descriptorData(patch = {}) {
  return {
    version: DESCRIPTOR_VERSION,
    mode: 'one-shot',
    provider: SUBAGENT_PROVIDER,
    label: 'preset:researcher',
    ...patch,
  };
}

// ---------------------------------------------------------------------------------------------
// Canonical session-log builders. `seq` is optional and filled by `attachSeqs`.
// ---------------------------------------------------------------------------------------------

export function turnStart(turn) { return { type: 'turn/start', data: { turn } }; }
export function turnEnd(turn, reason = { kind: 'completed' }) { return { type: 'turn/end', data: { turn, reason } }; }
export function stepStart(turn, step) { return { type: 'step/start', data: { turn, step } }; }
export function stepEnd(turn, step) { return { type: 'step/end', data: { turn, step } }; }

export function systemMessageEvent(turn, step, text = 'system prompt') {
  return {
    type: 'system/message',
    data: { turn, step, message: { id: 'm-sys-1', role: 'system', source: { kind: 'system-prompt' }, content: [{ type: 'text', text }] } },
    surfaceOp: 'append',
  };
}

export function assistantEvent(turn, step, patch = {}) {
  return {
    type: 'assistant/message',
    data: {
      turn,
      step,
      message: { id: `m-asst-${turn}-${step}`, role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'text', text: 'calling a tool' }] },
      stream: [],
      ...patch,
    },
    surfaceOp: 'append',
  };
}

export function toolCallEvent(turn, step, callId, name, args) {
  return { type: 'tool/call', data: { turn, step, callId, name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } };
}

/** A tool/result whose payload is the canonical JSON query answer. */
export function queryResultEvent(turn, step, options = {}) {
  const { callId = QUERY_CALL_ID, content = queryContent(options.answer), meta, isError = false } = options;
  return {
    type: 'tool/result',
    data: {
      turn,
      step,
      message: {
        id: options.messageId ?? 'm-query-1',
        role: 'tool',
        source: { kind: 'tool', callId },
        toolCallId: callId,
        content,
        ...(isError ? { isError: true } : {}),
      },
      ...(meta === undefined ? {} : { meta }),
      ...(isError ? { error: { name: 'ToolError', code: 'tool/error', reason: 'query failed' } } : {}),
    },
    surfaceOp: 'append',
  };
}

/** The query step: assistant asks for preset_list, the tool answers with the catalog. */
export function queryExchange(turn, step, options = {}) {
  const callId = options.callId ?? QUERY_CALL_ID;
  const name = options.name ?? 'preset_list';
  const content = options.content ?? (name === 'preset_list' ? queryContent(options.answer) : [{ type: 'text', text: 'diagnostic catalog' }]);
  return [
    assistantEvent(turn, step),
    toolCallEvent(turn, step, callId, name, options.args ?? { diagnostic: false }),
    queryResultEvent(turn, step, { ...options, callId, content }),
  ];
}

/**
 * The dispatch step: assistant asks for preset_dispatch, the tool answers with the fixed
 * meta envelope. `patch` overrides the meta; `content` overrides the whole result content.
 */
export function dispatchExchange(turn, step, options = {}) {
  const callId = options.callId ?? DISPATCH_CALL_ID;
  const meta = options.meta === undefined ? dispatchMeta(options.metaPatch) : options.meta;
  const content = options.content ?? [{ type: 'text', text: JSON.stringify(options.answer ?? { kind: 'foreground', preset: 'researcher', childSessionId: CHILD_SESSION_ID }) }];
  return [
    assistantEvent(turn, step),
    toolCallEvent(turn, step, callId, 'preset_dispatch', options.args ?? { preset: 'researcher', catalogId: CATALOG_ID, task: 'do it' }),
    queryResultEvent(turn, step, { callId, content, meta, isError: options.isError === true, messageId: options.messageId ?? 'm-dispatch-1' }),
  ];
}

/**
 * The parent's child-directory entry. Created for exactly one child when that child is established;
 * it pairs the dispatched child session id with its creation time and is never a start proof.
 */
export function catalogEvent(patch = {}) {
  return { type: 'subagent/catalog', data: catalogData(patch) };
}

/** The child's own durable identity event; only the child log may carry it. */
export function descriptorEvent(patch = {}) {
  return { type: 'subagent/descriptor', data: descriptorData(patch) };
}

/** The shadow-price event C appends immediately before its replacement. */
export function pruneEvent(seq, tokenCount) {
  return { type: 'compaction/prune', data: { shadowedRange: { start: seq, end: seq }, shadowedSeqs: [seq], shadowedTokenCount: tokenCount } };
}

/** The replacement query result: same identity/source/meta, only `content` differs. */
export function replacementEvent(original, content) {
  return {
    type: 'tool/result',
    data: { ...original.data, message: { ...original.data.message, content } },
    surfaceOp: { op: 'replace', startSeq: original.seq, endSeq: original.seq },
    sourceEventSeqs: [original.seq],
  };
}

/** Give every event a contiguous `seq` and a `time`, exactly like the real log does. */
export function attachSeqs(events, from = 0) {
  return events.map((event, index) => ({ ...event, seq: from + index, time: 1000 + from + index }));
}

/**
 * One complete canonical log: step (1,1) is the query, step (1,2) is the dispatch and the parent's
 * child-directory entry, step (1,3) is unrelated later work.
 * `overrides.query` / `overrides.dispatch` replace a whole exchange (assistant, tool/call,
 * tool/result), `overrides.before` / `overrides.after` prepend or append raw events.
 */
export function canonicalLog(overrides = {}) {
  const query = overrides.query ?? queryExchange(1, 1);
  const dispatch = overrides.dispatch ?? dispatchExchange(1, 2);
  const events = [
    turnStart(1),
    stepStart(1, 1),
    ...query,
    stepEnd(1, 1),
    stepStart(1, 2),
    ...dispatch,
    catalogEvent(),
    stepEnd(1, 2),
    stepStart(1, 3),
    assistantEvent(1, 3),
    stepEnd(1, 3),
    turnEnd(1),
  ];
  return attachSeqs([...(overrides.before ?? []), ...events, ...(overrides.after ?? [])], overrides.from ?? 0);
}

// ---------------------------------------------------------------------------------------------
// Strict fake session: records every append verbatim, can fail one chosen append without
// mutating state, and folds the shadow-price protocol so double deduction is observable.
// ---------------------------------------------------------------------------------------------

/** Surface-eligible event types; a replacement is any surfaceOp other than 'append'. */
const SURFACE_TYPES = new Set(['system/message', 'developer/message', 'user/message', 'assistant/message', 'tool/result']);

export function deriveMessage(event) {
  if (!SURFACE_TYPES.has(event.type)) return null;
  if (event.type === 'tool/result') return event.data?.message ?? null;
  const message = event.data?.message;
  if (!message) return null;
  return (message.content ?? []).length === 0 ? null : message;
}

export function createFakeSession(events = [], { header = sessionHeader(), inheritedEventCount = 0 } = {}) {
  const log = [...events];
  const appends = [];
  const meterCalls = [];
  const errors = [];
  let failAppendIndex = null;
  let nodes = [];
  let pendingClaim = null;
  let surfaceTokens = 0;
  let replaceGeneration = 0;
  let contentGeneration = 0;

  // The real estimator prices a message by what it CONTAINS: `estimateMessage` has no notion of
  // a message id. Caching by id would let a replacement that keeps the identity but shortens the
  // content be priced as its original, which would make the "deducted exactly once" assertions
  // below agree with a wrong implementation. Pricing is therefore a pure function of content.
  const priceOf = message => (message?.content ?? []).map(block => (typeof block?.text === 'string' ? block.text : '')).join('').length;

  const meter = {
    estimateMessage(message) {
      meterCalls.push(message);
      return priceOf(message);
    },
  };

  const fold = event => {
    if (event.type === 'compaction/prune' || event.type === 'compaction/summary') {
      const seq = event.data.shadowedRange.start;
      const original = log.find(item => item.seq === seq);
      const price = event.type === 'compaction/summary'
        ? event.data.shadowedTokenCount
        : (original === undefined ? event.data.shadowedTokenCount : meter.estimateMessage(deriveMessage(original)));
      pendingClaim = { start: event.data.shadowedRange.start, end: event.data.shadowedRange.end, tokens: price };
      return;
    }
    if (!SURFACE_TYPES.has(event.type) || event.surfaceOp === undefined) { pendingClaim = null; return; }
    const message = deriveMessage(event);
    const tokens = message === null ? 0 : meter.estimateMessage(message);
    if (event.surfaceOp === 'append') { nodes.push(event.seq); surfaceTokens += tokens; pendingClaim = null; return; }
    const op = event.surfaceOp;
    const start = nodes.indexOf(op.startSeq);
    const end = nodes.indexOf(op.endSeq);
    if (start === -1 || end === -1) throw new Error(`fake session: replacement range ${op.startSeq}-${op.endSeq} is not on the current surface`);
    const claim = pendingClaim;
    if (claim === null || claim.start !== op.startSeq || claim.end !== op.endSeq) {
      throw new Error(`fake session: replace at seq ${event.seq} over ${op.startSeq}-${op.endSeq} has no adjacent shadow price`);
    }
    // dsh-session surface.js applySurfacePlan: the landed event seq occupies the range.
    // Replaced source seqs remain audit events, never current surface nodes.
    nodes.splice(start, end - start + 1, event.seq);
    surfaceTokens += tokens - claim.tokens;
    // The official surface counts every committed positional replacement and every committed
    // message change; a plugin-owned replacement is exactly the latter.
    replaceGeneration += 1;
    contentGeneration += 1;
    pendingClaim = null;
  };

  for (const event of log) fold(event);

  return {
    appends, errors, meterCalls, meter,
    header, inheritedEventCount,
    get events() { return log; },
    // The official public read of the model-visible surface (`Session.surface` → `SessionSurface`):
    // `{ nodes, replaceGeneration, contentGeneration }`. Tests reach the surface through this,
    // exactly as they do on the real installed Session, instead of through a mock-only property.
    get surface() { return { nodes: [...nodes], replaceGeneration, contentGeneration }; },
    // Kept for the assertions written against the fixture before the official read existed.
    get surfaceNodes() { return [...nodes]; },
    get surfaceTokens() { return surfaceTokens; },
    get pendingClaim() { return pendingClaim; },
    /** Make append call number `index` (1-based) throw; the log/surface must not move. */
    failAppendAt(index) { failAppendIndex = index; return () => { failAppendIndex = null; }; },
    append(type, data, opts) {
      const callIndex = appends.length + 1;
      const append = { type, data, opts, callIndex };
      appends.push(append);
      try {
        if (failAppendIndex === callIndex) throw new Error(`fake session: append ${callIndex} refused`);
        const seq = log.length === 0 ? 0 : log.at(-1).seq + 1;
        const event = { type, seq, time: 2000 + seq, data, ...(opts ?? {}) };
        fold(event);
        log.push(event);
        append.seq = event.seq; // Only committed appends have a durable event position.
        return event;
      } catch (error) {
        // A rejected append interrupts the pair. Retry must submit a fresh shadow price.
        pendingClaim = null;
        errors.push(error);
        throw error;
      }
    },
    eventAt(seq) { return log.find(event => event.seq === seq); },
    // Official snapshot range: inclusive fromSeq, exclusive toSeqExclusive; old snapshots stay stable.
    snapshotEvents(fromSeq = 0, toSeqExclusive = (log.at(-1)?.seq ?? -1) + 1) {
      return Object.freeze(log.filter(event => event.seq >= fromSeq && event.seq < toSeqExclusive));
    },
    deriveEventMessage(event) { return deriveMessage(event); },
    deriveMessages() { return nodes.map(seq => deriveMessage(log.find(event => event.seq === seq))).filter(message => message !== null); },
  };
}

/** Shorthand: a fake session holding the canonical log, plus the events a test wants to reach. */
export function fakeCanonicalSession(overrides = {}) {
  const log = canonicalLog(overrides);
  const session = createFakeSession(log);
  return {
    session,
    log,
    queryResult: log.find(event => event.type === 'tool/result' && event.data.message.source.callId === QUERY_CALL_ID),
    dispatchResult: log.find(event => event.type === 'tool/result' && event.data.message.source.callId === DISPATCH_CALL_ID),
    catalog: log.find(event => event.type === 'subagent/catalog'),
  };
}

// ---------------------------------------------------------------------------------------------
// Real host packages. Two roots are tried, because the plugin declares only a `dsh` peer
// dependency: this fixture's own location, then the workspace package, and finally the `dsh`
// package that actually contains the host packages (resolved through its own package.json).
// ---------------------------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const requireFromHere = createRequire(import.meta.url);

function resolveHostPackage(name, subpath = '') {
  const specifier = subpath === '' ? name : `${name}/${subpath}`;
  const tried = [];
  for (const [label, base] of [['fixture', () => requireFromHere.resolve(specifier)], ['workspace', () => createRequire(join(here, '..', '..', 'package.json')).resolve(specifier)]]) {
    try { return { path: base(), tried, via: label }; } catch (error) { tried.push(`${label}: ${error.code ?? error.name}`); }
  }
  return { path: null, tried, via: null };
}

/**
 * The installed host packages. They are nested under the installed `dsh` package, so resolution is
 * rooted at that package's own `package.json`: a declared subpath export is resolved through it
 * (the same tiny resolver node uses for that package) and a bare package through the default file.
 */
const DSH_GLOBAL = join(dirname(process.execPath), 'node_modules', '@deepseek-ai', 'dsh');
const DSH_GLOBAL_FALLBACK = 'G:\\nodes\\node_glabal\\node_modules\\@deepseek-ai\\dsh';
const dshRoot = existsSync(DSH_GLOBAL) ? DSH_GLOBAL : DSH_GLOBAL_FALLBACK;
const requireFromDsh = createRequire(join(dshRoot, 'package.json'));

/** Resolve one host package path, or report every attempted base so the caller can report it. */
export function hostPackagePath(name, subpath = '') {
  const specifier = subpath === '' ? name : `${name}/${subpath}`;
  const tried = [];
  try { return { path: requireFromDsh.resolve(specifier), tried, via: 'dsh-package' }; } catch (error) { tried.push(`dsh-package: ${error.code ?? error.name}`); }
  const resolved = resolveHostPackage(name, subpath);
  return { path: resolved.path, tried: [...tried, ...resolved.tried], via: resolved.via };
}

/**
 * The token-meter's public estimator entry points. `lib/index.js` exports only the TokenMeter
 * service class, so the pure estimator is imported from the declared `./estimate` subpath
 * (`@deepseek-ai/dsh-token-meter/estimate`, package.json `exports`). Guessing a per-message number
 * or falling back to a hand-written estimator would price content this suite cannot justify.
 */
const METER_ESTIMATOR = { name: '@deepseek-ai/dsh-token-meter', subpath: 'estimate', exportName: 'estimateMessage' };

/**
 * Load the real Session class, `deriveEventMessage`, and the token-meter estimator.
 * Returns { ok: true, ... } or { ok: false, reason } — never throws for a missing package.
 */
export async function loadHost() {
  const session = hostPackagePath('@deepseek-ai/dsh-session');
  const meter = hostPackagePath(METER_ESTIMATOR.name, METER_ESTIMATOR.subpath);
  if (session.path === null || meter.path === null) {
    return { ok: false, reason: `host packages not resolvable (session: ${session.path ?? session.tried.join('; ')} | ${METER_ESTIMATOR.name}/${METER_ESTIMATOR.subpath}: ${meter.path ?? meter.tried.join('; ')})` };
  }
  try {
    const sessionModule = await import(pathToFileURL(session.path).href);
    const meterModule = await import(pathToFileURL(meter.path).href);
    if (typeof sessionModule.Session !== 'function') return { ok: false, reason: `${session.path} exports no Session class` };
    if (typeof sessionModule.deriveEventMessage !== 'function') return { ok: false, reason: `${session.path} exports no deriveEventMessage` };
    const estimateMessage = meterModule[METER_ESTIMATOR.exportName];
    if (typeof estimateMessage !== 'function') {
      return { ok: false, reason: `${meter.path} exports no ${METER_ESTIMATOR.exportName} (${METER_ESTIMATOR.name}/${METER_ESTIMATOR.subpath})` };
    }
    return {
      ok: true,
      Session: sessionModule.Session,
      deriveEventMessage: sessionModule.deriveEventMessage,
      estimateMessage,
      sessionPath: session.path,
      meterPath: meter.path,
      meter: { estimateMessage: message => estimateMessage(message) },
    };
  } catch (error) {
    return { ok: false, reason: `host package import failed: ${error?.message ?? error}` };
  }
}
