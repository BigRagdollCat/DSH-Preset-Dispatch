import test from 'node:test';
import assert from 'node:assert/strict';
import { SaveError, fail, errorCode, isInert, assertPolicyWritable, changedPolicies, prospectivePool, requireInteger, fingerprint, createOperationLog } from '../save-protocol.js';

const FLASH = { provider: 'opencode-go', model: 'deepseek-v4.1-flash' };
const SOL = { provider: 'codex-chatgpt', model: 'gpt-6.1-sol' };
const row = patch => ({ preset: 'planner', enabled: false, defaultModel: null, allowedModels: [], modelScope: 'host', lockModel: false, defaultEffort: null, allowedEfforts: [], ...patch });
const scope = (owned = [], roster = []) => ({ ownedIds: new Set(owned), rosterIds: new Set(roster) });

test('a row is inert only when it can grant nothing', () => {
  assert.equal(isInert(row()), true);
  assert.equal(isInert(row({ enabled: true })), false);
  assert.equal(isInert(row({ allowedModels: [FLASH], modelScope: 'selected' })), false);
  assert.equal(isInert(row({ defaultModel: FLASH })), false);
});

test('an owned preset may be configured freely, including granting authority', () => {
  assert.equal(assertPolicyWritable(row({ preset: 'planner', enabled: true, allowedModels: [FLASH], modelScope: 'selected' }), scope(['planner'], ['planner'])), 'owned');
});

test('an external preset may only be reduced to an inert row', () => {
  const ids = scope(['planner'], ['standard', 'planner']);
  assert.equal(assertPolicyWritable(row({ preset: 'standard' }), ids), 'external-inert');
  assert.throws(() => assertPolicyWritable(row({ preset: 'standard', enabled: true }), ids), error => {
    assert.equal(error.code, 'forbidden');
    assert.match(error.message, /不在本插件管理范围内/);
    return true;
  });
  assert.throws(() => assertPolicyWritable(row({ preset: 'standard', allowedModels: [FLASH], modelScope: 'selected' }), ids), { code: 'forbidden' });
});

test('a leftover row for a preset that no longer exists may only be cleared', () => {
  const ids = scope(['planner'], ['planner']);
  assert.equal(assertPolicyWritable(row({ preset: 'ghost' }), ids), 'orphan-inert');
  assert.throws(() => assertPolicyWritable(row({ preset: 'ghost', enabled: true }), ids), { code: 'forbidden' });
});

test('only rows that actually changed are reported, regardless of key order', () => {
  const previous = [row({ preset: 'planner' }), row({ preset: 'ghost', enabled: true })];
  const reordered = [{ ...row({ preset: 'planner' }) }, row({ preset: 'ghost', enabled: true })];
  assert.deepEqual(changedPolicies(previous, reordered), []);
  const next = [row({ preset: 'planner', enabled: true }), row({ preset: 'ghost' })];
  assert.equal(changedPolicies(previous, next).length, 2);
  // A removed row is not a "changed" row: deleting a row only ever reduces authority.
  assert.deepEqual(changedPolicies(previous, [row({ preset: 'planner' })]), []);
});

test('the policy is validated against the pool the request is about to write', () => {
  const current = { enabled: true, allowedModels: [FLASH], revision: 3, writable: true };
  assert.equal(prospectivePool(current, null), current);
  const widened = prospectivePool(current, { enabled: true, allowedModels: [FLASH, SOL], revision: 3 });
  assert.deepEqual(widened.allowedModels, [FLASH, SOL]);
  assert.equal(widened.writable, true);
});

test('a missing revision is a typed validation failure that names its part', () => {
  assert.equal(requireInteger(7, '派遣策略', 'policy'), 7);
  assert.throws(() => requireInteger(undefined, '派遣策略', 'policy'), error => {
    assert.ok(error instanceof SaveError);
    assert.equal(error.code, 'validation');
    assert.equal(error.part, 'policy');
    return true;
  });
  assert.equal(errorCode(new Error('plain')), 'unknown');
});

test('the same operation id replays its recorded outcome and refuses a different request', () => {
  const log = createOperationLog(2);
  assert.equal(log.replay('op-1', 'a'), null);
  log.record('op-1', 'a', { policySaved: true });
  assert.deepEqual(log.replay('op-1', 'a'), { policySaved: true });
  assert.deepEqual(log.get('op-1'), { policySaved: true });
  assert.throws(() => log.replay('op-1', 'b'), error => {
    assert.equal(error.code, 'conflict');
    return true;
  });
  // An absent id simply means "no idempotency requested".
  assert.equal(log.replay(undefined, 'a'), null);
  assert.throws(() => log.replay('   ', 'a'), { code: 'validation' });
  // The log stays bounded.
  log.record('op-2', 'b', 2);
  log.record('op-3', 'c', 3);
  assert.equal(log.get('op-1'), null);
  assert.equal(log.get('op-3'), 3);
});

test('fingerprints separate identical retries from different requests', () => {
  assert.equal(fingerprint({ a: 1 }), fingerprint({ a: 1 }));
  assert.notEqual(fingerprint({ a: 1 }), fingerprint({ a: 2 }));
});
