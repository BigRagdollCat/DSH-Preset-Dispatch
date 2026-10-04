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

test('separate histories do not share runs', () => {
  const a = createHistory(2);
  const b = createHistory(2);
  a.begin(metadata({ id: 'run-a' }));
  assert.deepEqual(b.list(), []);
  b.begin(metadata({ id: 'run-b' }));
  assert.deepEqual(a.list().map(r => r.id), ['run-a']);
  assert.deepEqual(b.list().map(r => r.id), ['run-b']);
});
