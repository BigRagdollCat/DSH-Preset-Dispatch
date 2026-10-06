import test from 'node:test';
import assert from 'node:assert/strict';
import { createHistory } from '../history.js';

const metadata = (patch = {}) => ({ id: 'run-1', preset: 'minimal', role: 'implementer', provider: 'p', model: 'm', depth: 1, parentSession: 'parent', ...patch });
const iso = value => typeof value === 'string' && value === new Date(value).toISOString();

test('begin keeps exactly the metadata it was given', () => {
  const history = createHistory();
  const row = history.begin(metadata());
  assert.equal(row.id, 'run-1');
  assert.equal(row.preset, 'minimal');
  assert.equal(row.role, 'implementer');
  assert.equal(row.provider, 'p');
  assert.equal(row.model, 'm');
  assert.equal(row.depth, 1);
  assert.equal(row.parentSession, 'parent');
  assert.equal(row.status, 'running');
  assert.equal(iso(row.startedAt), true, `unexpected startedAt ${row.startedAt}`);
  assert.deepEqual(history.list(), [row]);
  assert.deepEqual(Object.keys(row).sort(), ['depth', 'id', 'model', 'parentSession', 'preset', 'provider', 'role', 'startedAt', 'status']);
});

test('history stores metadata only and never task, output or reasoning', () => {
  const history = createHistory();
  const request = metadata({
    task: 'secret task text',
    prompt: 'secret prompt',
    output: 'secret output',
    reasoning: 'secret chain of thought',
    result: 'secret result',
    messages: [{ role: 'user', content: 'secret' }],
  });
  history.begin(request);
  const [row] = history.list();
  for (const key of ['task', 'prompt', 'output', 'reasoning', 'result', 'messages']) {
    assert.equal(key in row, false, `history persisted ${key}`);
  }
  assert.deepEqual(Object.keys(row).sort(), ['depth', 'id', 'model', 'parentSession', 'preset', 'provider', 'role', 'startedAt', 'status']);
  const raw = JSON.stringify(history.list());
  assert.equal(/secret/.test(raw), false, 'history serialization leaked payload text');
});

test('history keeps the newest runs first and one row per run', () => {
  const history = createHistory();
  const first = history.begin(metadata({ id: 'run-1' }));
  const second = history.begin(metadata({ id: 'run-2' }));
  const third = history.begin(metadata({ id: 'run-3' }));
  assert.deepEqual(history.list().map(r => r.id), ['run-3', 'run-2', 'run-1']);
  assert.deepEqual(history.list(), [third, second, first]);
  assert.equal(history.list().length, 3);
});

test('history is bounded at fifty runs by default', () => {
  const history = createHistory();
  for (let i = 1; i <= 60; i++) history.begin(metadata({ id: 'run-' + i }));
  const rows = history.list();
  assert.equal(rows.length, 50);
  assert.deepEqual(rows.map(r => r.id), Array.from({ length: 50 }, (_, i) => 'run-' + (60 - i)));
  assert.equal(rows.at(0).id, 'run-60');
  assert.equal(rows.at(-1).id, 'run-11');
  assert.equal(rows.some(r => r.id === 'run-1'), false, 'evicted run still listed');
});

test('history honors an explicit bound and stays at the default for outlier args', () => {
  const small = createHistory(3);
  for (let i = 1; i <= 5; i++) small.begin(metadata({ id: 'run-' + i }));
  assert.deepEqual(small.list().map(r => r.id), ['run-5', 'run-4', 'run-3']);

  const single = createHistory(1);
  single.begin(metadata({ id: 'first' }));
  single.begin(metadata({ id: 'second' }));
  assert.deepEqual(single.list().map(r => r.id), ['second']);

  for (const limit of [undefined, 0, -2, null, '7']) {
    const history = createHistory(limit);
    for (let i = 1; i <= 51; i++) history.begin(metadata({ id: 'run-' + i }));
    assert.equal(history.list().length, 50, `limit ${String(limit)} changed the default bound`);
  }
});

test('finish records status, finish time and an optional child session', () => {
  const history = createHistory();
  const row = history.begin(metadata());
  const started = row.startedAt;
  history.finish(row, 'completed');
  const [stored] = history.list();
  assert.equal(stored.status, 'completed');
  assert.equal(stored.startedAt, started, 'finish replaced startedAt');
  assert.equal(iso(stored.finishedAt), true, `unexpected finishedAt ${stored.finishedAt}`);
  assert.equal(new Date(stored.finishedAt) >= new Date(stored.startedAt), true);
  assert.equal('childSessionId' in stored, false, 'absent child session must stay absent');

  const child = history.begin(metadata({ id: 'run-child' }));
  history.finish(child, 'failed', 'child-42');
  const [finished] = history.list();
  assert.equal(finished.status, 'failed');
  assert.equal(finished.childSessionId, 'child-42');
  assert.equal(iso(finished.finishedAt), true);

  const killed = history.begin(metadata({ id: 'run-killed' }));
  history.finish(killed, 'killed');
  const second = history.begin(metadata({ id: 'run-later' }));
  // This test begins four runs (run-1, run-child, run-killed, run-later). Finishing never evicts,
  // and the default bound of 50 keeps all four, newest first.
  const ids = history.list().map(r => r.id);
  assert.equal(ids.length, 4, `default bound dropped runs: ${ids.join(',')}`);
  assert.deepEqual(ids, ['run-later', 'run-killed', 'run-child', 'run-1']);
  assert.equal(second.status, 'running');
  assert.equal('finishedAt' in second, false, 'a new run must not inherit a finish time');
});

test('finish mutates the returned row and can be corrected by a later call', () => {
  const history = createHistory();
  const row = history.begin(metadata());
  history.finish(row, 'running');
  assert.equal(row.status, 'running');
  history.finish(row, 'completed', 'child-1');
  assert.equal(row.status, 'completed');
  assert.equal(row.childSessionId, 'child-1');
  history.finish(row, 'failed', 'child-2');
  const [stored] = history.list();
  assert.equal(stored.status, 'failed');
  assert.equal(stored.childSessionId, 'child-2');
  assert.equal(iso(stored.finishedAt), true);
});

test('list returns independent snapshots that cannot rewrite stored runs', () => {
  const history = createHistory();
  const row = history.begin(metadata());
  const first = history.list();
  assert.notEqual(first, history.list(), 'list must not expose the stored array');
  first[0].status = 'tampered';
  first[0].id = 'tampered';
  first[0].startedAt = 'tampered';
  first[0].extra = true;
  first.push({ id: 'injected' });
  assert.equal(history.list()[0].status, 'running');
  assert.equal(history.list()[0].id, 'run-1');
  assert.equal(history.list().length, 1);

  row.id = 'renamed-through-begin-handle';
  assert.equal(history.list()[0].id, 'renamed-through-begin-handle', 'begin must return the stored row so the dispatcher can finish it');

  const snapshot = history.list();
  history.begin(metadata({ id: 'run-2' }));
  assert.equal(snapshot.length, 1, 'an earlier snapshot changed after a new run');
});

test('V08 get exposes the internal row for update while list and query return detached snapshots', () => {
  const history = createHistory();
  const begun = history.begin(metadata());
  const internal = history.get(begun.id);
  assert.equal(internal, begun, 'get returns the stored row, not a clone');
  assert.equal(history.get(begun.id), internal, 'repeated lookup retains the internal row identity');
  const listed = history.list()[0];
  const queried = history.query({ preset: 'minimal' }).runs[0];
  assert.notEqual(listed, internal, 'list must not expose the internal row');
  assert.notEqual(queried, internal, 'query must not expose the internal row');
  history.update(internal, { childSessionId: 'child-get', observedRouting: { provider: 'p', model: 'observed' } });
  assert.equal(internal.childSessionId, 'child-get', 'the held internal reference sees update');
  assert.equal(history.get(begun.id), internal, 'update must not replace the internal row reference');
  assert.equal(history.list()[0].childSessionId, 'child-get', 'new list snapshots see the update');
  assert.equal(history.query({ preset: 'minimal' }).runs[0].childSessionId, 'child-get', 'new query snapshots see the update');
  assert.equal(listed.childSessionId, undefined, 'an earlier list snapshot remains unchanged');
  assert.equal(queried.childSessionId, undefined, 'an earlier query snapshot remains unchanged');
  const freshList = history.list()[0], freshQuery = history.query({ preset: 'minimal' }).runs[0];
  assert.notEqual(freshList.observedRouting, internal.observedRouting, 'list nested data is detached');
  assert.notEqual(freshQuery.observedRouting, internal.observedRouting, 'query nested data is detached');
  freshList.observedRouting.model = 'tampered-list';
  freshQuery.observedRouting.model = 'tampered-query';
  assert.equal(internal.observedRouting.model, 'observed', 'snapshot mutations cannot write through');
});

test('separate histories do not share runs', () => {
  const a = createHistory(2);
  const b = createHistory(2);
  a.begin(metadata({ id: 'run-a' }));
  assert.deepEqual(b.list(), []);
  b.begin(metadata({ id: 'run-b' }));
  assert.deepEqual(a.list().map(r => r.id), ['run-a']);
  assert.deepEqual(b.list().map(r => r.id), ['run-b']);
});

// ---------------------------------------------------------------------------------------------
// Phase B: the metadata whitelist, the durable snapshot and the subscribe contract
// (docs/08 V07/V08/V10, docs/09 T04/T05).
// ---------------------------------------------------------------------------------------------

test('V08 update applies only declared fields and reports exactly what it wrote', () => {
  const history = createHistory();
  const row = history.begin(metadata());
  const applied = history.update(row, {
    childSessionId: 'child-1',
    callId: 'call-1',
    rootCallId: 'root-1',
    catalogId: 'catalog-1',
    presetName: 'Minimal',
    presetVersion: 3,
    observationState: 'observed',
    plannedRouting: { provider: 'p', model: 'm', reasoningEffort: 'high', modelSource: 'preset-default', effortSource: 'preset-default' },
    observedRouting: { provider: 'p', model: 'm', reasoningEffort: 'high' },
  });
  assert.deepEqual(applied.sort(), ['callId', 'catalogId', 'childSessionId', 'observationState', 'observedRouting', 'plannedRouting', 'presetName', 'presetVersion', 'rootCallId'].sort());
  assert.equal(row.childSessionId, 'child-1');
  assert.equal(row.observedRouting.reasoningEffort, 'high');
});

test('V08 an undeclared field or a wrong-typed value is refused instead of being stored', () => {
  const history = createHistory();
  // A record with none of the visibility fields yet, so a refused write is unambiguous.
  const row = history.begin(metadata({ childSessionId: undefined, callId: undefined, catalogId: undefined, presetVersion: undefined, plannedRouting: undefined, observedRouting: undefined, observationState: undefined }));
  const before = { ...row };
  const refused = {
    task: 'secret task text', answer: 'secret answer', reasoning: 'secret chain',
    prompt: 'secret prompt', output: 'secret output', messages: [{ role: 'user', content: 'secret' }],
    // Declared names with values the record could not survive: an empty id, a float version,
    // a string where a route object belongs.
    childSessionId: '', callId: '', catalogId: '   ',
    presetVersion: 2.5, plannedRouting: 'not-a-route', observedRouting: 'not-a-route',
    observationState: 7, finishedAt: 0,
  };
  assert.deepEqual(history.update(row, refused), [], 'not one refused field may be reported as written');
  assert.deepEqual(row, before, 'a refused patch must leave the record untouched');
  assert.equal(/secret/.test(JSON.stringify(history.list())), false, 'no refused value may reach the record');
  // An empty string is not an identifier: the record must not gain a key naming no child.
  assert.equal('childSessionId' in history.list()[0], false);
  assert.equal('presetVersion' in history.list()[0], false);
});

test('V10 an explicit null route and version are honest values, not missing ones', () => {
  const history = createHistory();
  const row = history.begin(metadata());
  const applied = history.update(row, { observedRouting: null, presetVersion: null });
  assert.deepEqual(applied.sort(), ['observedRouting', 'presetVersion']);
  assert.equal(row.observedRouting, null, 'a cleared observation must be distinguishable from a never-written one');
  assert.equal(row.presetVersion, null);
  assert.equal(history.update(row, { presetVersion: undefined }).includes('presetVersion'), false, 'undefined is absence, not a value');
});

test('V08 update is a no-op that notifies nobody when it changes nothing', () => {
  const history = createHistory();
  const row = history.begin(metadata());
  const seen = [];
  history.subscribe((changed, kind) => seen.push(kind));
  assert.deepEqual(history.update(row, {}), []);
  assert.deepEqual(history.update(row, { task: 'x' }), []);
  assert.deepEqual(seen, [], 'an empty patch must not announce an update that did not happen');
});

test('V07 the record is metadata only, and a stored row cannot be rewritten through an update patch', () => {
  const history = createHistory();
  const row = history.begin(metadata());
  history.update(row, { id: 'hijacked', startedAt: '1999-01-01T00:00:00.000Z', status: 'completed', preset: 'other' });
  const [stored] = history.list();
  assert.notEqual(stored.id, 'hijacked', 'the record address must not be rewritable through an update patch');
  assert.equal(stored.preset, 'minimal');
  assert.equal(stored.status, 'running', 'only finish may settle a record');
  assert.equal(/secret/.test(JSON.stringify(stored)), false);
});

test('V08 update writes a detached copy, so a later caller mutation cannot rewrite the record', () => {
  const history = createHistory();
  const row = history.begin(metadata());
  const plan = { provider: 'p', model: 'm', reasoningEffort: 'high' };
  history.update(row, { plannedRouting: plan });
  plan.model = 'tampered';
  assert.equal(history.list()[0].plannedRouting.model, 'm', 'the stored plan must not alias caller state');
});

test('V08 every record change announces its row and its kind, and the disposer stops it', () => {
  const history = createHistory();
  const seen = [];
  const dispose = history.subscribe((changed, kind) => seen.push({ kind, id: changed?.id, status: changed?.status }));
  const row = history.begin({ ...metadata(), id: 'run-1' });
  history.update(row, { childSessionId: 'child-1' });
  history.finish(row, 'completed', 'child-1');
  assert.deepEqual(seen.map(entry => entry.kind), ['begin', 'update', 'finish']);
  assert.deepEqual(seen.map(entry => entry.id), ['run-1', 'run-1', 'run-1']);
  assert.equal(seen.at(-1).status, 'completed', 'the announced row must be the record as it now stands');

  dispose();
  history.begin(metadata({ id: 'run-2' }));
  assert.equal(seen.length, 3, 'a disposed subscriber must stop hearing changes');
});

test('V08 a failing subscriber cannot break the write or the other subscribers', () => {
  const history = createHistory();
  const heard = [];
  history.subscribe(() => { throw new Error('observer exploded'); });
  history.subscribe((_row, kind) => heard.push(kind));
  const row = history.begin(metadata());
  history.finish(row, 'completed');
  assert.equal(row.status, 'completed', 'the record must be written even when an observer fails');
  assert.deepEqual(heard, ['begin', 'finish'], 'the healthy subscribers must still be told');
  assert.equal(history.list().length, 1);
});

test('V10 restore keeps an old record readable and reports an untraceable run as interrupted', async () => {
  // A row written before the visibility fields existed: no callId, no observation, no child.
  const legacy = { id: 'run-old', preset: 'researcher', status: 'completed', startedAt: '2026-01-01T00:00:00.000Z', model: 'm', modelSource: 'preset-default' };
  const rows = new Map([[legacy.id, legacy]]);
  const store = { async load() { return [...rows.values()]; }, async put(row) { rows.set(row.id, row); }, async remove(id) { rows.delete(id); } };
  const history = createHistory(50, store);
  assert.deepEqual(await history.restore(), { restored: 1, interrupted: 0 });
  const [restored] = history.list();
  assert.equal(restored.id, 'run-old');
  assert.equal(restored.status, 'completed', 'a finished legacy run must not be turned into another state');
  assert.equal(restored.modelSource, 'preset-default');
  assert.equal('observedRouting' in restored, false, 'restore must not invent an observed value the record never had');
  assert.equal('observationState' in restored, false);
  assert.notEqual(history.restoredAt(), null, 'a restored history must say when it was seeded');
});
