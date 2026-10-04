import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCatalog, catalogIndex, routeKey } from '../catalog.js';

const model = (provider, id, name) => ({ provider, id, name });
const llm = (providers, models, info = {}) => ({
  listProviders: () => providers,
  listModels: async provider => { const value = models[provider]; if (value instanceof Error) throw value; return value; },
  resolveModelInfo: async (provider, id) => { const value = info[`${provider}/${id}`]; if (value instanceof Error) throw value; return value ?? { name: id }; },
});

test('the catalog groups models by provider and carries reasoning efforts', async () => {
  const catalog = await buildCatalog(llm(
    [{ id: 'a', name: 'Provider A' }, { id: 'b', name: 'Provider B' }],
    { a: [model('a', 'a-1', 'A One')], b: [model('b', 'b-1', 'B One')] },
    { 'a/a-1': { name: 'A One', reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'high' }, context: { contextWindow: 1000 } } },
  ));
  assert.equal(catalog.failures.length, 0);
  assert.deepEqual(catalog.groups.map(group => group.provider), ['a', 'b']);
  const first = catalog.groups[0].models[0];
  assert.equal(first.model, 'a-1');
  assert.deepEqual(first.efforts.map(effort => effort.id), ['low', 'high']);
  assert.equal(first.defaultEffort, 'high');
  assert.equal(first.contextWindow, 1000);
  assert.equal(catalog.groups[1].models[0].efforts.length, 0, 'a model without capability metadata still appears');
});

test('one unreachable provider is isolated and never empties the catalog', async () => {
  const catalog = await buildCatalog(llm(
    [{ id: 'a', name: 'Provider A' }, { id: 'broken', name: 'Broken' }],
    { a: [model('a', 'a-1', 'A One')], broken: new Error('endpoint down') },
  ));
  assert.deepEqual(catalog.groups.map(group => group.provider), ['a']);
  assert.equal(catalog.failures.length, 1);
  assert.equal(catalog.failures[0].provider, 'broken');
  assert.match(catalog.failures[0].message, /endpoint down/);
});

test('empty provider groups are dropped and capability lookup failures stay advisory', async () => {
  const catalog = await buildCatalog(llm(
    [{ id: 'empty', name: 'Empty' }, { id: 'a', name: 'Provider A' }],
    { empty: [], a: [model('a', 'a-1', 'A One')] },
    { 'a/a-1': new Error('no metadata') },
  ));
  assert.deepEqual(catalog.groups.map(group => group.provider), ['a']);
  assert.equal(catalog.groups[0].models[0].capabilityUnknown, true);
  assert.deepEqual(catalog.groups[0].models[0].efforts, []);
});

test('catalogIndex maps each route to its advertised efforts', async () => {
  const catalog = await buildCatalog(llm([{ id: 'a', name: 'A' }], { a: [model('a', 'a-1', 'A One')] }, { 'a/a-1': { reasoning: { efforts: [{ id: 'low' }] } } }));
  const index = catalogIndex(catalog);
  assert.deepEqual(index.get(routeKey({ provider: 'a', model: 'a-1' })), ['low']);
  assert.equal(index.get(routeKey({ provider: 'a', model: 'ghost' })), undefined);
});

test('an unknown capability is absent from the index rather than meaning "no efforts"', async () => {
  const catalog = await buildCatalog(llm([{ id: 'a', name: 'A' }], { a: [model('a', 'a-1', 'A One')] }, { 'a/a-1': new Error('metadata unavailable') }));
  const index = catalogIndex(catalog);
  assert.equal(index.has(routeKey({ provider: 'a', model: 'a-1' })), false, 'an empty list would reject every configured effort');
});

test('a missing LLM service fails loudly instead of reporting an empty catalog', async () => {
  await assert.rejects(() => buildCatalog(undefined), /LLM service unavailable/);
});
