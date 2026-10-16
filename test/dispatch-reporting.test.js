import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSelection, validSelection, summarizeTokenUsage, validTokenUsage } from '../dispatch-reporting.js';
import { createHistory } from '../history.js';
import { runRecord, RUN_FIELDS, RUN_FIELD_TYPES } from '../history-store.js';
import { visibilityPayload } from '../visibility-api.js';
const message = (seq, usage) => ({ type: 'assistant/message', seq, data: { usage, message: { content: [{type:'text',text:'PRIVATE OUTPUT'}] } } });

test('selection is optional bounded advisory metadata with only two fields', () => {
  assert.equal(parseSelection(undefined), null);
  const input = {difficulty:'medium',reason:'  Scoped changes with known evidence  '};
  assert.deepEqual(parseSelection(input), {difficulty:'medium',reason:'Scoped changes with known evidence'});
  assert.notEqual(parseSelection(input), input);
  assert.equal(validSelection(null), true);
  assert.equal(parseSelection({difficulty:'low',reason:'😀'.repeat(160)}).reason, '😀'.repeat(160));
  for (const value of [null, {}, [], 'high', {difficulty:'max',reason:'x'}, {difficulty:'low',reason:' '},
    {difficulty:'high',reason:'x'.repeat(161)}, {difficulty:'low',reason:'x',model:'override'}]) {
    assert.throws(() => parseSelection(value), /selection/);
  }
});

test('usage sums committed replies once and retains counters without double-adding them', () => {
  const a = message(1,{inputTokens:10,outputTokens:5,totalTokens:15,cacheReadTokens:4,cacheWriteTokens:0,reasoningTokens:2});
  const b = message(3,{inputTokens:20,outputTokens:7,totalTokens:27,cacheReadTokens:8,cacheWriteTokens:1,reasoningTokens:3});
  const result = summarizeTokenUsage([a,b,a,{type:'tool/result',seq:2,data:{usage:{inputTokens:999,outputTokens:999}}}]);
  assert.equal(result.status,'reported');
  assert.equal(result.reportedMessages,2);
  assert.equal(result.inputTokens,30);
  assert.equal(result.outputTokens,12);
  assert.equal(result.totalTokens,42);
  assert.equal(result.cacheReadTokens,12);
  assert.equal(result.cacheWriteTokens,1);
  assert.equal(result.reasoningTokens,5);
  assert.ok(validTokenUsage(result));
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE OUTPUT/);
});

test('missing optional counters and missing entire usage are not fabricated as zero', () => {
  const result = summarizeTokenUsage([message(1,{inputTokens:0,outputTokens:0}), message(2,{inputTokens:2,outputTokens:3,totalTokens:5})]);
  assert.equal(result.status,'reported');
  assert.equal(result.inputTokens,2);
  assert.equal(result.totalTokens,null,'do not derive a total or mix partial counters');
  assert.equal(result.cacheReadTokens,null);
  const empty = summarizeTokenUsage([]);
  assert.equal(empty.status,'unknown');
  assert.equal(empty.inputTokens,null);
  const zero = summarizeTokenUsage([message(1,{inputTokens:0,outputTokens:0,totalTokens:0})]);
  assert.equal(zero.totalTokens,0,'explicitly reported zero is real');
});

test('missing replies and unmetered attempts disclose partial coverage', () => {
  const result = summarizeTokenUsage([message(1,{inputTokens:9,outputTokens:4}), message(2,undefined),
    {type:'assistant/attempt',seq:3,data:{stream:[]}}]);
  assert.equal(result.status,'partial');
  assert.equal(result.reportedMessages,1);
  assert.equal(result.missingMessages,1);
  assert.equal(result.unmeteredAttempts,1);
  assert.equal(result.inputTokens,9);
  assert.ok(validTokenUsage(result));
  const bad = summarizeTokenUsage([message(0,{inputTokens:-1,outputTokens:4}), message(2,{inputTokens:NaN,outputTokens:2})]);
  assert.equal(bad.status,'unknown');
  assert.equal(bad.missingMessages,2);
  const overflow=summarizeTokenUsage([message(1,{inputTokens:Number.MAX_SAFE_INTEGER,outputTokens:1}),message(2,{inputTokens:1,outputTokens:1})]);
  assert.equal(overflow.status,'partial'); assert.equal(overflow.inputTokens,null);
  const invalidSeq=summarizeTokenUsage([message(1,{inputTokens:1,outputTokens:1}),message(undefined,{inputTokens:999,outputTokens:999})]);
  assert.equal(invalidSeq.status,'partial'); assert.equal(invalidSeq.inputTokens,1); assert.equal(invalidSeq.missingMessages,1);
});

test('history and persistence keep decisions immutable, filter extra nested data, and retain unknown usage', async () => {
  const rows = new Map();
  const store = {put:async row=>rows.set(row.id,runRecord(row)),remove:async id=>rows.delete(id),load:async()=>[...rows.values()]};
  const history=createHistory(50,store);
  const selection={difficulty:'high',reason:'High error cost; use a verified route'};
  const row=history.begin({preset:'reviewer',selection,task:'PRIVATE TASK'});
  selection.reason='mutated';
  assert.equal(row.selection.reason,'High error cost; use a verified route');
  assert.deepEqual(history.update(row,{selection:{difficulty:'low',reason:'rewrite'}}),[]);
  const tokenUsage=summarizeTokenUsage([message(1,{inputTokens:8,outputTokens:2,totalTokens:10})]);
  assert.deepEqual(history.update(row,{tokenUsage}),['tokenUsage']);
  history.finish(row,'completed','child');
  await new Promise(resolve=>setImmediate(resolve));
  const restored=createHistory(50,store); await restored.restore();
  assert.deepEqual(restored.list()[0].selection,row.selection);
  assert.deepEqual(restored.list()[0].tokenUsage,tokenUsage);
  assert.equal(restored.list()[0].task,undefined);
  assert.equal(runRecord({...row,selection:{...row.selection,task:'secret'}}).selection,undefined);
  assert.equal(runRecord({...row,tokenUsage:{...tokenUsage,output:'secret'}}).tokenUsage,undefined);
  assert.deepEqual(RUN_FIELDS.slice().sort(),Object.keys(RUN_FIELD_TYPES).sort());
  assert.equal(runRecord({id:'old',preset:'p',startedAt:'t',status:'completed'}).tokenUsage,undefined);
});

test('visibility reports the saved decision and child usage without adding task or reply text', () => {
  const selection={difficulty:'low',reason:'Bounded lookup'};
  const tokenUsage=summarizeTokenUsage([message(1,{inputTokens:3,outputTokens:1})]);
  const payload=visibilityPayload({preset:'researcher',selection,tokenUsage,task:'PRIVATE TASK',output:'PRIVATE OUTPUT'});
  assert.deepEqual(payload.selection,selection);
  assert.deepEqual(payload.tokenUsage,tokenUsage);
  assert.doesNotMatch(JSON.stringify(payload),/PRIVATE/);
  assert.equal(visibilityPayload({preset:'old'}).tokenUsage,null);
});
