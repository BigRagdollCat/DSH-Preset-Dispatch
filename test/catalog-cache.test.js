import test from 'node:test';
import assert from 'node:assert/strict';
import { createCatalogCache } from '../catalog-cache.js';

const catalog = tag => ({ groups: [{ provider: 'p', models: [{ provider: 'p', model: tag }] }], failures: [] });

/** A clock and a build counter the tests drive directly. */
function fixture(ttlMs = 1000) {
  let clock = 0;
  const state = { builds: 0, resolvers: [], tag: 'a' };
  const cache = createCatalogCache({
    ttlMs,
    now: () => clock,
    build: signal => {
      state.builds += 1;
      const tag = state.tag;
      return new Promise((resolve, reject) => state.resolvers.push({ resolve, reject, tag, signal }));
    },
  });
  return { cache, state, advance: ms => { clock += ms; } };
}

test('concurrent readers share one build', async () => {
  const { cache, state } = fixture();
  const first = cache.read();
  const second = cache.read();
  const third = cache.read();
  assert.equal(state.builds, 1, 'three readers must not cause three provider round-trips');
  state.resolvers[0].resolve(catalog('a'));
  assert.deepEqual(await first, await second);
  assert.deepEqual(await third, catalog('a'));
  assert.equal(state.builds, 1);
});

test('a cached catalog is served until the ttl passes, then rebuilt', async () => {
  const { cache, state, advance } = fixture(1000);
  const pending = cache.read();
  state.resolvers.shift().resolve(catalog('a'));
  await pending;
  assert.equal((await cache.read()).groups[0].models[0].model, 'a');
  assert.equal(state.builds, 1, 'within the ttl the cached value is reused');
  advance(1000);
  const stale = cache.read();
  assert.equal(state.builds, 2, 'past the ttl a new build starts');
  state.resolvers.shift().resolve(catalog('b'));
  assert.equal((await stale).groups[0].models[0].model, 'b');
});

test('a superseded build never becomes the cached value', async () => {
  const { cache, state } = fixture();
  const slow = cache.read();
  const slowResolver = state.resolvers.shift();
  cache.invalidate();
  const newer = cache.read();
  state.resolvers.shift().resolve(catalog('new'));
  await newer;
  // The older read lands last and must not overwrite the newer result.
  slowResolver.resolve(catalog('old'));
  assert.equal((await slow).groups[0].models[0].model, 'old', 'the caller still gets what it asked for');
  assert.equal((await cache.read()).groups[0].models[0].model, 'new', 'but the cache keeps the newer value');
  assert.equal(state.builds, 2);
});

test('a failed rebuild keeps the last good catalog and reports it as stale', async () => {
  const { cache, state, advance } = fixture(0);
  const first = cache.read();
  state.resolvers.shift().resolve(catalog('a'));
  await first;
  advance(1);
  const failing = cache.read();
  state.resolvers.shift().reject(new Error('provider registry exploded'));
  assert.equal((await failing).groups[0].models[0].model, 'a', 'the previous catalog is still served');
  const status = cache.status();
  assert.equal(status.stale, true);
  assert.match(status.error, /provider registry exploded/);
});

test('a first build that fails rejects instead of inventing a catalog', async () => {
  const { cache, state } = fixture();
  const failing = cache.read();
  state.resolvers.shift().reject(new Error('llm service unavailable'));
  await assert.rejects(failing, /llm service unavailable/);
  assert.equal(cache.status().cached, false);
});

test('a forced refresh rebuilds inside the ttl without disturbing readers it still serves', async () => {
  const { cache, state } = fixture(10000);
  const first = cache.read();
  state.resolvers.shift().resolve(catalog('a'));
  await first;
  const refresh = cache.refresh();
  assert.equal(state.builds, 2, 'a refresh rebuilds even inside the ttl');
  const served = await cache.read();
  assert.equal(served.groups[0].models[0].model, 'a', 'a read inside the ttl is served immediately, not held behind the refresh');
  state.resolvers.shift().resolve(catalog('b'));
  await refresh;
  assert.equal((await cache.read()).groups[0].models[0].model, 'b', 'once the refresh lands, readers see the new catalog');
  assert.equal(state.builds, 2);
});

test('one caller giving up does not cancel the shared build for the others', async () => {
  const { cache, state } = fixture();
  const controller = new AbortController();
  const abandoned = cache.read({ signal: controller.signal });
  const patient = cache.read();
  controller.abort();
  await assert.rejects(abandoned, /abort/);
  assert.equal(state.builds, 1, 'the shared build keeps running');
  state.resolvers.shift().resolve(catalog('a'));
  assert.equal((await patient).groups[0].models[0].model, 'a');
  assert.equal((await cache.read()).groups[0].models[0].model, 'a', 'the completed build was cached');
});

test('the cache only ever holds the catalog it was given', async () => {
  const { cache, state } = fixture();
  const pending = cache.read();
  state.resolvers.shift().resolve({ groups: [], failures: [], note: 'no authorization here' });
  const value = await pending;
  assert.deepEqual(Object.keys(value).sort(), ['failures', 'groups', 'note']);
  assert.equal('allowedModels' in value, false, 'authorization must never be cached here');
  assert.equal('hostPool' in value, false);
});
