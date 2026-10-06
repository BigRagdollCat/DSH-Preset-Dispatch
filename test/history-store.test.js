import test from 'node:test';
import assert from 'node:assert/strict';
import { createHistoryStore, DOMAIN_NAME, DOMAIN_VERSION, RUNS_TABLE, RUN_FIELDS, RUN_FIELD_TYPES, runRecord } from '../history-store.js';
import { createHistory } from '../history.js';

/** Stand-in for the storage-domain facility: records the spec and serves a Map table. */
function fakeFacility() {
  const opened = { spec: null, closed: false };
  const records = new Map();
  const table = {
    get: key => records.get(key),
    entries: () => records.entries(),
    keys: () => records.keys(),
    get size() { return records.size; },
    async put(key, value) { records.set(key, value); },
    async delete(key) { return records.delete(key); },
  };
  return {
    opened, records,
    async open(spec) {
      opened.spec = spec;
      return { name: spec.name, table: () => table, async close() { opened.closed = true; } };
    },
  };
}

function helpers() {
  const seen = [];
  return {
    seen,
    defineDomain: spec => { seen.push(spec); return spec; },
    domainTable: schema => ({ schema }),
    schema: { marker: 'run-schema' },
  };
}

const tick = () => new Promise(resolve => setImmediate(resolve));
const run = patch => ({ id: 'run-1', preset: 'planner', startedAt: '2026-01-01T00:00:00.000Z', status: 'completed', ...patch });

test('the domain is declared once, with a durable layout and a validated table schema', async () => {
  const facility = fakeFacility();
  const injected = helpers();
  const store = createHistoryStore(injected);
  assert.equal(injected.seen.length, 1, 'the declaration must be validated by the storage package');
  const spec = injected.seen[0];
  assert.equal(spec.name, DOMAIN_NAME);
  assert.equal(spec.version, DOMAIN_VERSION);
  assert.equal(spec.layout, 'per-record', 'independent records belong in separate documents');
  assert.equal(spec.invalidRecords, 'backup-and-skip', 'derived data must not become unreadable because of one bad record');
  assert.equal(spec.tables[RUNS_TABLE].schema, injected.schema);
  await store.open(facility);
  assert.equal(facility.opened.spec, spec);
  await store.close();
  assert.equal(facility.opened.closed, true, 'the port must release the domain on unload');
});

test('a record is stored as plain declared data, with undeclared fields and shared references dropped', async () => {
  const facility = fakeFacility();
  const store = createHistoryStore(helpers());
  await store.open(facility);
  const snapshot = { enabled: true, allowedModels: [{ provider: 'p', model: 'm' }] };
  const row = run({ secret: 'must not be stored', policySnapshot: snapshot });
  await store.put(row);
  const stored = facility.records.get('run-1');
  assert.equal(stored.secret, undefined, 'only declared fields may be written');
  assert.deepEqual(stored.policySnapshot, snapshot);
  assert.notEqual(stored.policySnapshot, snapshot, 'the stored copy must not alias caller state');
  assert.equal(runRecord(row).status, 'completed');
  assert.deepEqual((await store.load()).map(entry => entry.id), ['run-1']);
});

test('a failing medium is reported instead of breaking dispatch', async () => {
  const failing = { put: async () => { throw new Error('medium down'); }, remove: async () => {}, load: async () => [], clear: async () => {} };
  const history = createHistory(50, failing);
  const row = history.begin({ id: 'child-1', preset: 'planner' });
  assert.equal(row.status, 'running', 'begin must succeed even though the write will fail');
  history.finish(row, 'completed');
  await tick();
  assert.match(history.storageError(), /medium down/);
  assert.equal(history.list().length, 1, 'the in-memory view stays usable');
});

test('restore reports an untraceable run as interrupted instead of pretending it is running', async () => {
  const facility = fakeFacility();
  const store = createHistoryStore(helpers());
  await store.open(facility);
  facility.records.set('run-1', run({ id: 'run-1', status: 'running' }));
  facility.records.set('run-2', run({ id: 'run-2', status: 'completed', startedAt: '2026-01-02T00:00:00.000Z' }));
  const history = createHistory(50, store);
  const outcome = await history.restore();
  assert.deepEqual(outcome, { restored: 2, interrupted: 1 });
  const [newest, oldest] = history.list();
  assert.equal(newest.id, 'run-2', 'rows come back newest first');
  assert.equal(oldest.status, 'interrupted');
  assert.equal(facility.records.get('run-1').status, 'interrupted', 'the correction must be durable, not only in memory');
});

test('restore keeps only the retained window and reports nothing when there is no medium', async () => {
  const facility = fakeFacility();
  const store = createHistoryStore(helpers());
  await store.open(facility);
  for (let index = 0; index < 5; index += 1) facility.records.set('run-' + index, run({ id: 'run-' + index, startedAt: '2026-01-0' + (index + 1) + 'T00:00:00.000Z' }));
  const history = createHistory(2, store);
  assert.deepEqual(await history.restore(), { restored: 2, interrupted: 0 });
  assert.deepEqual(history.list().map(entry => entry.id), ['run-4', 'run-3']);
  assert.deepEqual(await createHistory(50, null).restore(), { restored: 0, interrupted: 0 }, 'no medium simply means no restore');
});

test('retention removes the dropped record from the medium as well', async () => {
  const facility = fakeFacility();
  const store = createHistoryStore(helpers());
  await store.open(facility);
  const history = createHistory(2, store);
  history.begin({ id: 'run-1', preset: 'planner' });
  history.begin({ id: 'run-2', preset: 'planner' });
  history.begin({ id: 'run-3', preset: 'planner' });
  await tick();
  assert.deepEqual([...facility.records.keys()].sort(), ['run-2', 'run-3']);
});

test('clearing empties both the medium and the in-memory view', async () => {
  const facility = fakeFacility();
  const store = createHistoryStore(helpers());
  await store.open(facility);
  facility.records.set('run-1', run({ id: 'run-1' }));
  const history = createHistory(50, store);
  await history.restore();
  await history.clear();
  assert.equal(history.list().length, 0);
  assert.equal(facility.records.size, 0);
});

test('query filters and paginates while list keeps its array contract', () => {
  const history = createHistory(50);
  history.begin({ id: 'run-1', preset: 'planner' });
  history.begin({ id: 'run-2', preset: 'implementer' });
  history.begin({ id: 'run-3', preset: 'planner' });
  assert.ok(Array.isArray(history.list()), 'the existing list contract must not change');
  assert.deepEqual(history.query({ preset: 'planner' }).runs.map(entry => entry.id), ['run-3', 'run-1']);
  assert.deepEqual(history.query({ preset: 'planner', limit: 1, offset: 1 }), { total: 2, offset: 1, runs: [history.query({ preset: 'planner' }).runs[1]] });
  assert.equal(history.query({ status: 'running' }).total, 3);
  assert.equal(history.query({ status: 'completed' }).total, 0);
});

test('the writer and the durable schema describe exactly the same fields', () => {
  assert.deepEqual(Object.keys(RUN_FIELD_TYPES).sort(), [...RUN_FIELDS].sort(), 'a field cannot be written without being declared, or declared without being written');
  assert.deepEqual(
    runRecord({ id: 'r', preset: 'p', startedAt: 's', status: 'running', undeclared: 'nope', alsoUndefined: undefined }),
    { id: 'r', preset: 'p', startedAt: 's', status: 'running' },
    'undeclared fields are dropped rather than stored, and undefined never reaches the medium',
  );
});

test('a run reaches the medium under its own id, never under the key "undefined"', async () => {
  // Found on the real medium: a record was stored as `runs/undefined.json` because `begin`
  // never assigned an id, so it could never be addressed again.
  const rows = new Map();
  const store = {
    async load() { return [...rows.values()]; },
    async put(row) { rows.set(row.id, row); },
    async remove(id) { rows.delete(id); },
  };
  const history = createHistory(5, store);
  const row = history.begin({ preset: 'planner' });
  await Promise.resolve();
  assert.equal(typeof row.id, 'string');
  assert.match(row.id, /^run-/, 'the record needs a real address');
  assert.deepEqual([...rows.keys()], [row.id], 'the medium key must be the run id, not undefined');
  history.begin({ preset: 'planner' });
  await Promise.resolve();
  assert.equal(rows.size, 2, 'a second run must not overwrite the first');
  assert.equal([...rows.keys()].includes('undefined'), false);
});

test('a record the medium cannot address is not loaded back', async () => {
  // Leftovers from the pre-id bug are inert rather than shown as a bogus history entry.
  const store = createHistoryStore({ defineDomain: spec => spec, domainTable: schema => ({ schema }), schema: {} });
  // A Map yields [key, record] pairs, exactly like the real table's entries().
  const rows = new Map([['undefined', { status: 'running' }], ['run-1', { id: 'run-1', status: 'done' }]]);
  const table = { entries: () => rows.entries(), put: async () => {}, delete: async () => {}, keys: () => rows.keys() };
  await store.open({ open: async () => ({ table: () => table, close: async () => {} }) });
  assert.deepEqual(await store.load(), [{ id: 'run-1', status: 'done' }], 'only addressable records come back');
});

test('the port refuses to write before it is open', async () => {
  const store = createHistoryStore(helpers());
  await assert.rejects(() => store.put(run()), /not open/);
  assert.deepEqual(await store.load().catch(error => String(error.message)), 'history storage is not open');
});

// ---------------------------------------------------------------------------------------------
// Phase B: the durable whitelist and old-record compatibility (docs/08 V07/V10, docs/09 T05).
// ---------------------------------------------------------------------------------------------

/** Every declared visibility field, filled with a value of its declared type. */
const fullRow = () => run({
  role: 'implementer', provider: 'p', model: 'm', depth: 1, parentSession: 'parent-1', reasoningEffort: 'high',
  modelSource: 'preset-default', effortSource: 'preset-default', presetVersion: 3,
  policySnapshot: { enabled: true, allowedModels: [{ provider: 'p', model: 'm' }] },
  finishedAt: '2026-01-01T00:01:00.000Z', childSessionId: 'child-1', callId: 'call-1',
  rootCallId: 'root-1', catalogId: 'catalog-1', presetName: 'Minimal',
  plannedRouting: { provider: 'p', model: 'm', reasoningEffort: 'high', modelSource: 'preset-default', effortSource: 'preset-default' },
  observedRouting: { provider: 'p', model: 'm', reasoningEffort: 'high' },
  observationState: 'observed',
});

test('every declared record field survives a write and a load, and none is silently dropped', async () => {
  const facility = fakeFacility();
  const store = createHistoryStore(helpers());
  await store.open(facility);
  await store.put(fullRow());

  const [loaded] = await store.load();
  const expected = runRecord(fullRow());
  assert.deepEqual(Object.keys(loaded).sort(), [...RUN_FIELDS].sort(), 'exactly the declared fields must come back');
  for (const field of RUN_FIELDS) assert.deepEqual(loaded[field], expected[field], `${field} did not survive the round trip`);
  assert.equal(loaded.observationState, 'observed');
  assert.deepEqual(loaded.plannedRouting, fullRow().plannedRouting, 'a nested route must come back intact');
  assert.notEqual(loaded.plannedRouting, fullRow().plannedRouting, 'and must not alias caller state');
});

test('a payload key that is not declared is dropped rather than reaching the medium', () => {
  const row = { ...fullRow(), task: 'secret task', answer: 'secret answer', reasoning: 'secret chain', apiKey: 'sk-live-1' };
  const stored = runRecord(row);
  for (const key of ['task', 'answer', 'reasoning', 'apiKey']) assert.equal(key in stored, false, `${key} must never be stored`);
  assert.equal(/secret|sk-live/.test(JSON.stringify(stored)), false, 'no payload text may be stored');
});

test('a record written before the visibility fields existed stays valid and readable', async () => {
  // The shape an older version wrote: the original plan metadata, no ids, no observation.
  const legacy = { id: 'run-legacy', preset: 'researcher', role: 'researcher', provider: 'p', model: 'm', depth: 1, parentSession: 'parent-1', startedAt: '2025-12-01T00:00:00.000Z', status: 'completed' };
  const facility = fakeFacility();
  facility.records.set(legacy.id, legacy);
  const store = createHistoryStore(helpers());
  await store.open(facility);

  const [loaded] = await store.load();
  assert.equal(loaded.id, 'run-legacy', 'an old record must still be addressable');
  assert.deepEqual(loaded, legacy, 'loading must not rewrite an old record into a new shape');
  for (const field of ['observedRouting', 'observationState', 'callId', 'childSessionId', 'catalogId']) {
    assert.equal(field in loaded, false, `an old record must not gain ${field}`);
  }
  // A record that predates the new fields keeps validating, so the medium does not move it aside.
  assert.deepEqual(runRecord(loaded), legacy, 're-writing an old record must preserve exactly what it already had');
});

test('restoring an old record cannot invent an observed configuration for it', async () => {
  const facility = fakeFacility();
  facility.records.set('run-old', { id: 'run-old', preset: 'researcher', startedAt: '2025-12-01T00:00:00.000Z', status: 'running', model: 'm', modelSource: 'preset-default' });
  const store = createHistoryStore(helpers());
  await store.open(facility);
  const history = createHistory(50, store);
  assert.deepEqual(await history.restore(), { restored: 1, interrupted: 1 });

  const [row] = history.list();
  assert.equal(row.status, 'interrupted', 'an untraceable run must be corrected, not presented as running');
  assert.equal('observedRouting' in row, false, 'restore must not supply an actual request the record never had');
  assert.equal('observationState' in row, false);
  assert.equal(row.modelSource, 'preset-default', 'the original plan metadata must survive the correction');
});

test('the declared field set and the durable schema agree after the visibility fields were added', () => {
  // One assertion that closes the loop for the new fields specifically: each is declared in the
  // writer and in the schema, so a field cannot be written into a document the schema rejects.
  for (const field of ['callId', 'rootCallId', 'catalogId', 'presetName', 'plannedRouting', 'observedRouting', 'observationState', 'childSessionId']) {
    assert.ok(RUN_FIELDS.includes(field), `${field} must be declared by the writer`);
    assert.equal(typeof RUN_FIELD_TYPES[field], 'function', `${field} must have a declared durable type`);
  }
  assert.deepEqual(Object.keys(RUN_FIELD_TYPES).sort(), [...RUN_FIELDS].sort());
  assert.equal(DOMAIN_VERSION, 1, 'adding optional fields must not bump the domain version, which would orphan every existing record');
});
