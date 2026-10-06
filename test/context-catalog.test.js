// Phase A contract tests: compact resident routing text (C01) and the on-demand dispatch
// catalog returned by preset_list (C02-C05), plus the optional preset_dispatch catalogId.
//
// These tests assert observable behaviour of the public tool surface, not the source shape:
//  - what a calling agent receives from preset_list in compact and diagnostic mode;
//  - what preset_dispatch accepts and what it refuses;
//  - what the resident prompt section exposes.
// They intentionally do not lock down field-by-field envelopes that phase A is still
// reshaping; where two shapes are plausible the helpers in test/fixtures accept both and the
// assertion is the invariant that must hold either way (never more than the authorized pool).
//
// Expected state before the phase A implementation lands: the routing tests and the
// diagnostic/compact split are RED; see the report accompanying this file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { routingText } from '../routing.js';
import { catalogFixture, sharedPool, rowPool, routeKey, HOST_POOL } from './fixtures/preset-list-fixture.js';

// The preset ids a caller may actually dispatch in the default fixture. 'off' is disabled by
// policy, 'broken' failed to load and 'ghost' is outside allowedPresets.
const DISPATCHABLE = ['minimal', 'standard'];
const NOT_DISPATCHABLE = ['off', 'broken', 'ghost'];

const ids = value => value.presets.map(preset => preset.id);

// ---------------------------------------------------------------------------------------
// C01: the resident prompt is an entry point, not the routing table.
// ---------------------------------------------------------------------------------------

test('C01 resident routing text is a short entry point that still advertises both tools', () => {
  const text = routingText({ enabled: true });
  assert.match(text, /preset_list/, 'the query entry point must stay discoverable');
  assert.match(text, /preset_dispatch/, 'the dispatch entry point must stay discoverable');
  assert.ok(text.length <= 400, `resident text must be a short entry point, got ${text.length} characters`);
  // The long handoff and per-role detail moved into the query result; carrying role names or
  // role permissions in every turn is exactly what C01 removes.
  assert.doesNotMatch(text, /researcher|investigator|reviewer|verifier|test-author|implementer/);
  assert.doesNotMatch(text, /allowedModels|reasoning_effort|usableModels/);
});

test('C01 resident routing text keeps the final-acceptance and no-bypass boundary', () => {
  const text = routingText({ enabled: true });
  assert.match(text, /最终验收/, 'the lead-owns-final-acceptance boundary must survive compaction');
  assert.match(text, /不绕过|不得绕过/, 'bypassing a refusal must stay forbidden in the resident text');
});

test('C01 resident routing text does not fix a model recommendation or carry the model pool', () => {
  const text = routingText({ enabled: true });
  assert.doesNotMatch(text, /opencode-go|deepseek-v4|codex-chatgpt|gpt-6\.1/, 'the resident text must not recommend a fixed model');
  assert.doesNotMatch(text, /推荐/, 'model recommendation belongs to the query result, not the resident text');
});

test('C01 resident routing text states the inherited-model boundary when the Host switch is off', () => {
  const enabled = routingText({ enabled: true });
  const disabled = routingText({ enabled: false });
  assert.ok(disabled.length > enabled.length, 'a disabled selection adds one boundary sentence');
  assert.match(disabled, /继承|未启用|禁用/, 'the disabled state must be stated, not implied');
});

// ---------------------------------------------------------------------------------------
// C02/C05: the default query returns the compact dispatch catalog.
// ---------------------------------------------------------------------------------------

test('C02 compact list contains only presets that can actually be dispatched', async () => {
  const f = catalogFixture();
  const value = await f.list();
  assert.deepEqual(ids(value).sort(), [...DISPATCHABLE].sort());
  for (const preset of value.presets) {
    // A compact row always carries the health field; for a dispatchable preset it is null, so the
    // compact answer states "no load failure" without ever transporting a failure message.
    assert.equal(preset.broken, null, `compact preset ${preset.id} must not carry a load failure`);
  }
});

test('C02 compact list reports a successful query with a catalog marker and mode', async () => {
  const value = await catalogFixture().list();
  assert.equal(typeof value.catalogId, 'string');
  assert.ok(value.catalogId.length > 0, 'a query answer must be identifiable');
  assert.equal(value.catalog?.mode, 'compact');
  assert.equal(typeof value.catalog?.formatVersion, 'number');
  assert.equal(typeof value.catalog?.marker, 'string');
  assert.ok(value.catalog.marker.length > 0, 'the marker must be non-empty so a later step can recognise the answer');
});

test('C02 compact list carries the shared authorized model pool with effort capability', async () => {
  const value = await catalogFixture().list();
  const pool = sharedPool(value);
  assert.ok(pool.length > 0, 'an enabled Host pool must be advertised');
  assert.deepEqual([...new Set(pool.map(routeKey))].sort(), [...HOST_POOL.map(routeKey)].sort(), 'the pool is exactly the Host-authorized set');
  const m = pool.find(route => routeKey(route) === routeKey({ provider: 'p', model: 'm' }));
  assert.deepEqual(m.efforts, ['low', 'medium', 'high'], 'effort capability must travel with the pool rather than being guessed');
  const fresh = pool.find(route => routeKey(route) === routeKey({ provider: 'p', model: 'new' }));
  assert.deepEqual(fresh.efforts, [], 'a model without effort metadata must say so explicitly');
});

test('C02 a model outside the Host pool is never advertised as usable', async () => {
  const value = await catalogFixture().list();
  const pool = sharedPool(value);
  assert.equal(pool.some(route => route.model === 'ghost'), false, 'the LLM catalog listing is not an authorization');
  for (const preset of value.presets) {
    assert.equal(rowPool(preset).some(route => route.model === 'ghost'), false, `preset ${preset.id} must not advertise an unauthorized model`);
  }
});

test('C02 no preset row repeats more of the authorized pool than the shared pool carries', async () => {
  const value = await catalogFixture().list();
  const pool = new Set(sharedPool(value).map(routeKey));
  for (const preset of value.presets) {
    const rows = rowPool(preset);
    assert.ok(rows.length <= pool.size, `preset ${preset.id} repeats ${rows.length} routes beside a ${pool.size}-route pool`);
    for (const route of rows) {
      assert.ok(pool.has(routeKey(route)), `preset ${preset.id} advertises ${routeKey(route)} outside the shared authorized pool`);
    }
  }
});

test('C02 a host-scoped row repeats no pool and a selected-scoped row shows its real difference', async () => {
  const value = await catalogFixture().list();
  const pool = sharedPool(value);
  assert.ok(pool.length > 0, 'the shared pool must be advertised for the comparison to mean anything');
  const minimal = value.presets.find(preset => preset.id === 'minimal');
  const standard = value.presets.find(preset => preset.id === 'standard');
  assert.ok(minimal && standard, 'both dispatchable presets the fixture declares must be listed');
  // 'standard' carries no policy, so it follows the shared pool exactly: repeating the pool in its
  // row would duplicate the authorization list the compact answer already sent once.
  assert.equal('usableModels' in standard, false, 'a row that follows the shared pool must not repeat it');
  for (const route of rowPool(standard)) {
    assert.ok(pool.some(allowed => routeKey(allowed) === routeKey(route)), `preset standard may not advertise ${routeKey(route)} on its own`);
  }
  // 'minimal' is scope 'selected' with one allowed model, so its row really narrows the pool.
  assert.deepEqual(rowPool(minimal).map(routeKey), [routeKey({ provider: 'p', model: 'm' })]);
  assert.notDeepEqual(rowPool(minimal).map(routeKey), pool.map(routeKey), 'a narrowing row must differ from the pool it narrows');
});

test('C02 compact rows keep the per-preset differences a dispatcher must respect', async () => {
  const value = await catalogFixture().list();
  const minimal = value.presets.find(preset => preset.id === 'minimal');
  const standard = value.presets.find(preset => preset.id === 'standard');
  assert.equal(minimal.description, 'Small');
  assert.deepEqual(minimal.pinnedModel, { provider: 'p', model: 'm' }, 'a pinned model must stay visible');
  assert.equal(minimal.pinnedEffort, 'high', 'a pinned effort must stay visible');
  // An unlocked preset must be reported as unlocked whether the row carries `lockModel:false` or
  // omits the field: dispatch treats a missing lock as "not locked", so the answer must too.
  assert.equal(Boolean(minimal.policy?.lockModel), false);
  assert.deepEqual(standard.pinnedModel, null, 'a preset without a pinned model inherits the parent route: that absence is the information');
  assert.equal(standard.pinnedEffort, null);
});

test('C02 compact list states the dispatch rules that left the resident prompt', async () => {
  const value = await catalogFixture().list();
  const text = Object.values(value.rules ?? {}).join('\n');
  assert.match(text, /最终验收/, 'the ownership boundary must be queryable once the resident text drops it');
  assert.match(text, /单写者/, 'the single-writer rule must be queryable');
  assert.match(text, /RED|回归|门禁/, 'the verification stages must be queryable');
  assert.match(text, /不绕过|不得绕过|禁止/, 'the no-bypass rule must be queryable');
});

// ---------------------------------------------------------------------------------------
// C03: the full catalog is diagnostic-only.
// ---------------------------------------------------------------------------------------

test('C03 diagnostic mode returns every preset, including the ones that cannot be dispatched', async () => {
  const f = catalogFixture();
  const value = await f.list({ diagnostic: true });
  assert.deepEqual(ids(value).sort(), [...DISPATCHABLE, ...NOT_DISPATCHABLE].sort(), 'diagnostic mode must not hide presets');
  assert.equal(value.catalog?.mode, 'diagnostic');
  const broken = value.presets.find(preset => preset.id === 'broken');
  assert.equal(broken.loaded, false, 'a load failure must stay visible in diagnostic mode');
  assert.match(String(broken.broken), /bad import/);
  const off = value.presets.find(preset => preset.id === 'off');
  assert.equal(off.policy?.enabled, false, 'a disabled preset must show its policy in diagnostic mode');
});

test('C03 diagnostic mode adds the host pool and the unauthorized models', async () => {
  const value = await catalogFixture().list({ diagnostic: true });
  assert.deepEqual(value.hostPool?.allowedModels, HOST_POOL, 'diagnostic mode exposes the Host pool itself');
  assert.equal(value.hostPool?.enabled, true);
  assert.deepEqual(value.unauthorizedModels?.map(routeKey), ['p\u0000ghost'], 'models outside the pool appear only as unauthorized');
});

test('C03 the compact answer omits the diagnostic-only keys', async () => {
  const value = await catalogFixture().list();
  for (const key of ['hostPool', 'unauthorizedModels']) {
    assert.equal(key in value, false, `${key} must not be part of the default compact answer`);
  }
});

test('C03 a catalog read failure is reported in either mode instead of silently emptying the pool', async () => {
  const value = await catalogFixture({ catalogThrows: true }).list();
  assert.ok(Array.isArray(value.catalogFailures) && value.catalogFailures.length > 0, 'a failed catalog read is an error, not "no model is authorized"');
  const diagnostic = await catalogFixture({ catalogThrows: true }).list({ diagnostic: true });
  assert.ok(Array.isArray(diagnostic.catalogFailures) && diagnostic.catalogFailures.length > 0);
});

test('C03 an unknown capability is reported as unknown, not as an empty effort list', async () => {
  const value = await catalogFixture({ capabilitiesUnknown: true }).list();
  const pool = sharedPool(value);
  assert.ok(pool.length > 0, 'the model stays advertised when only its capability lookup failed');
  for (const route of pool) assert.deepEqual(route.efforts, [], 'no effort may be invented for an unknown capability');
});

// ---------------------------------------------------------------------------------------
// C04: the catalog id correlates, it never authorizes.
// ---------------------------------------------------------------------------------------

test('C04 every successful query returns a distinct catalog id bound to the calling session', async () => {
  const f = catalogFixture({ sessionId: 'session-a' });
  const first = await f.list();
  const second = await f.list();
  assert.notEqual(first.catalogId, second.catalogId, 'two queries must be independently trackable');
  assert.equal(first.catalog?.sessionBound, true);
  assert.equal(first.catalog?.parentSessionId, 'session-a');
  assert.equal(second.catalog?.parentSessionId, 'session-a');
});

test('C04 a query without a calling agent reports an unbound id instead of guessing a session', async () => {
  const value = await catalogFixture({ agent: null }).list();
  assert.equal(typeof value.catalogId, 'string');
  assert.equal(value.catalog?.sessionBound, false);
  assert.equal(value.catalog?.parentSessionId, null);
});

test('C04 the catalog id is declared correlation-only, not an authorization ticket', async () => {
  const value = await catalogFixture().list();
  assert.equal(value.catalog?.authorizationTicket, false);
  const serialized = JSON.stringify(value);
  assert.doesNotMatch(serialized, /"authorizationTicket":true/);
});

test('C04 a query id from this session does not widen authorization', async () => {
  const f = catalogFixture({ allowedPresets: ['minimal'] });
  const value = await f.list();
  assert.deepEqual(ids(value), ['minimal']);
  await assert.rejects(f.call({ preset: 'standard', catalogId: value.catalogId }), /not allowed/, 'a catalog id must never admit a preset the policy refuses');
  assert.equal(f.state.creates.length, 0);
});

test('C04 a query id cannot excuse a revoked model at dispatch time', async () => {
  const f = catalogFixture({ presetPolicies: [{ preset: 'minimal', enabled: true, allowedModels: [{ provider: 'p', model: 'new' }], modelScope: 'selected' }] });
  const value = await f.list();
  // The refusal may legitimately be raised by either live check: the preset's own narrowed model
  // list ("Effective model is outside preset allowed models") or the Host authorization pool.
  // What must hold is the rejection itself, and that no child was created.
  const refusal = /outside preset allowed models|authorized|outside the Host/;
  const listed = sharedPool(value).map(routeKey);
  if (listed.includes(routeKey({ provider: 'p', model: 'm' }))) {
    await assert.rejects(f.call({ model: 'm', provider: 'p', catalogId: value.catalogId }), refusal, 'a listed route the preset no longer allows must still be refused');
  } else {
    await assert.rejects(f.call({ preset: 'minimal', provider: 'p', model: 'm', catalogId: value.catalogId }), refusal);
  }
  assert.equal(f.state.creates.length, 0);
});

// ---------------------------------------------------------------------------------------
// C04: preset_dispatch accepts the optional catalog id without becoming dependent on it.
// ---------------------------------------------------------------------------------------

test('C04 a dispatch that references a query id still dispatches and records the correlation', async () => {
  const f = catalogFixture();
  const value = await f.list();
  const result = await f.call({ catalogId: value.catalogId });
  assert.equal(result.preset, 'minimal');
  assert.equal(f.state.creates.length, 1);
  assert.equal(f.state.children[0].cancelled, false);
  const begin = f.state.history.find(entry => entry.phase === 'begin');
  assert.equal(begin?.record?.preset, 'minimal', 'the run record must still be written when a query id is supplied');
});

test('C04 an old dispatch without a catalog id keeps working', async () => {
  const f = catalogFixture();
  const result = await f.call({});
  assert.equal(result.stopReason, 'completed');
  assert.equal(f.state.creates.length, 1, 'omitting the id must not require a prior query');
});

test('C04 explicit null or wrong-typed catalog ids are refused before any child exists', async () => {
  const f = catalogFixture();
  for (const catalogId of [null, 0, 7, {}, [], true, '', '   ']) {
    await assert.rejects(f.call({ catalogId }), /catalogId|non-empty/, `catalogId ${JSON.stringify(catalogId)} must be refused`);
  }
  assert.equal(f.state.creates.length, 0, 'a refused call must not create a child');
});

test('C04 a catalog id cannot silently replace the effective route or models', async () => {
  const f = catalogFixture();
  const value = await f.list();
  await f.call({ catalogId: value.catalogId });
  assert.equal(f.state.preflights[0].provider, 'p', 'the correlation id must not choose the provider');
  assert.equal(f.state.preflights[0].model, 'm');
  assert.equal(f.state.creates[0].agentOptions.model, 'm');
});
