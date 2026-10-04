import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Minimal React hook emulator: enough to render the real client module and drive
// user events without a browser or a second React installation. It is NOT a
// browser: it cannot establish layout, focus, contrast or pointer behaviour.
function makeReact() {
  const stores = new Map();
  let current = null;
  const Fragment = Symbol('Fragment');
  function store(fn) { let s = stores.get(fn); if (!s) { s = { hooks: [], cursor: 0, effects: [] }; stores.set(fn, s); } return s; }
  const emulate = (fn, props) => {
    const s = store(fn); const prev = current; current = s; s.cursor = 0;
    try { return fn(props); } finally { current = prev; }
  };
  const React = {
    Fragment,
    createElement(type, props, ...children) {
      const flat = children.flat(Infinity).filter(c => c !== null && c !== undefined && c !== false && c !== true);
      if (typeof type === 'function') return emulate(type, { ...(props || {}), children: flat });
      return { type, props: props || {}, children: flat };
    },
    useState(init) { const s = current, i = s.cursor++; if (!(i in s.hooks)) s.hooks[i] = typeof init === 'function' ? init() : init;
      return [s.hooks[i], v => { s.hooks[i] = typeof v === 'function' ? v(s.hooks[i]) : v; }]; },
    useRef(init) { const s = current, i = s.cursor++; if (!(i in s.hooks)) s.hooks[i] = { current: init }; return s.hooks[i]; },
    useEffect(fn) { current.effects.push(fn); },
    useMemo(fn) { return fn(); },
    useCallback(fn) { return fn; },
  };
  return {
    React,
    reset() { for (const s of stores.values()) { s.cursor = 0; s.effects = []; } },
    async flush() { for (const s of stores.values()) { const es = s.effects; s.effects = []; for (const f of es) { const cleanup = f(); if (typeof cleanup === 'function') cleanup(); } }
      for (let i = 0; i < 8; i++) await new Promise(r => setImmediate(r)); },
  };
}

function walk(node, visit) {
  if (Array.isArray(node)) { node.forEach(n => walk(n, visit)); return; }
  visit(node);
  if (node && typeof node === 'object') (node.children || []).forEach(n => walk(n, visit));
}
const texts = node => { const out = []; walk(node, n => { if (typeof n === 'string') out.push(n); }); return out; };
const findAll = (node, pred) => { const out = []; walk(node, n => { if (n && typeof n === 'object' && !Array.isArray(n) && pred(n)) out.push(n); }); return out; };
const byText = (node, label) => findAll(node, n => n.type === 'button' && texts(n).join('').includes(label))[0];
const checkboxes = node => findAll(node, n => n.type === 'input' && n.props?.type === 'checkbox');
/** The checkbox inside the innermost label mentioning `label`. */
function checkboxNear(node, label) {
  const hosts = findAll(node, n => n && typeof n === 'object' && !Array.isArray(n) && texts(n).join(' ').includes(label))
    .map(host => ({ host, boxes: checkboxes(host) }))
    .filter(entry => entry.boxes.length)
    .sort((a, b) => a.boxes.length - b.boxes.length);
  return hosts[0]?.boxes[0];
}

let fetchImpl = async () => { throw new Error('fetch not stubbed'); };
// Set by a test that needs two loadClient() instances to share one tab's storage,
// which is how a page refresh is modelled. Null means each load gets a fresh store.
let storage = null;
const freshStore = () => ({
  held: new Map(),
  getItem(key) { return this.held.has(key) ? this.held.get(key) : null; },
  setItem(key, value) { this.held.set(key, String(value)); },
  removeItem(key) { this.held.delete(key); },
});

function loadClient() {
  const code = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
  const emu = makeReact();
  let captured;
  const listeners = {};
  const sandbox = {
    console, setTimeout, clearTimeout, setImmediate,
    fetch: (...args) => fetchImpl(...args),
    document: { activeElement: null, addEventListener: (t, f) => { listeners[t] = f; }, removeEventListener: t => { delete listeners[t]; }, querySelector: () => null },
    window: { __ModuleLoader__: { load: m => { captured = m; } }, confirm: () => true, addEventListener() {}, removeEventListener() {} },
    sessionStorage: storage ?? freshStore(),
    require: name => { if (name === 'react') return emu.React; throw new Error('unexpected import ' + name); },
  };
  vm.runInNewContext(code, sandbox, { filename: 'client.js' });
  assert.equal(captured.id, '@local/dsh-preset-dispatch');
  const api = captured.factory(sandbox.require);
  return { api, emu };
}

const FLASH = { provider: 'opencode-go', model: 'deepseek-v4.1-flash' };
const SOL = { provider: 'codex-chatgpt', model: 'gpt-6.1-sol' };

function snapshot(overrides = {}) {
  return {
    definitionRevision: 'def-1', settingsRevision: 7,
    definitions: [{ id: 'planner', name: '规划架构', description: '只读规划', prompt: '分析目标。', template: 'readonly', version: 1, tools: ['read'] }],
    templates: { readonly: '只读', researcher: '研究检索', implementer: '实现开发', 'test-author': '测试编写', verifier: '测试验证' },
    external: [{ id: 'standard', isDefault: true }],
    presets: [{ id: 'standard', isDefault: true }, { id: 'planner', name: '规划架构' }],
    catalog: { groups: [
      { provider: 'opencode-go', name: 'opencode-go', models: [{ ...FLASH, name: 'Flash', efforts: [{ id: 'low' }, { id: 'high' }] }] },
      { provider: 'codex-chatgpt', name: 'codex-chatgpt', models: [{ ...SOL, name: '6.1 Sol', efforts: [{ id: 'medium' }, { id: 'high' }] }] },
    ], failures: [] },
    hostPool: { enabled: true, allowedModels: [FLASH], revision: 3, writable: true },
    config: { maxDepth: 1, allowedPresets: [], presetPolicies: [
      { preset: 'planner', enabled: true, defaultModel: FLASH, allowedModels: [FLASH], modelScope: 'selected', lockModel: false, defaultEffort: 'high', allowedEfforts: [] },
    ] },
    ...overrides,
  };
}

function boot(responses, opts = {}) {
  const { api, emu } = loadClient();
  const calls = [];
  global.fetch = fetchImpl = async (url, options) => {
    const key = String(url).split('/api/preset-dispatch/')[1];
    calls.push({ key, options, body: options?.body ? JSON.parse(options.body) : undefined });
    if (opts.throwOn && opts.throwOn.includes(key)) throw new Error('fetch failed');
    if (opts.fail && opts.fail.includes(key)) return { ok: false, status: 500, json: async () => ({ error: 'boom' }) };
    const body = responses[key];
    if (body === undefined) throw new Error('unexpected request ' + key);
    return { ok: true, status: 200, json: async () => (typeof body === 'function' ? body(options) : body) };
  };
  const registered = {};
  const dictionaries = {};
  const ctx = {
    locale: { getLocale: () => ({ locales: [{ id: 'zh-CN' }] }),
      register: (ns, _lang, value) => { dictionaries[ns] = value; },
      bind: ns => key => (dictionaries[ns] && dictionaries[ns][key]) ?? key },
    effect: fn => { const d = fn(); return typeof d === 'function' ? d : () => {}; },
    slots: { inject: (_name, factory) => factory(), register: (def, Page) => { registered.page = Page; return () => {}; } },
  };
  api.apply(ctx);
  assert.ok(registered.page, 'the settings.section page must be registered');
  return { Page: registered.page, emu, calls };
}

async function render(Page, emu, times = 2) {
  let tree;
  for (let i = 0; i < times; i++) { tree = emu.React.createElement(Page, {}); await emu.flush(); }
  return tree;
}

test('one page lists owned and read-only presets, and a card opens a single dialog with both sections', async () => {
  const { Page, emu, calls } = boot({ state: snapshot(), history: { runs: [] } });
  let tree = await render(Page, emu);
  assert.ok(calls.some(c => c.key === 'state'), 'the combined state must be requested');
  assert.equal(calls.some(c => c.key === 'presets'), false, 'the retired per-page endpoint must not be called');

  const labels = texts(tree).join('|');
  assert.match(labels, /Agent 管理/);
  assert.match(labels, /本插件管理/);
  assert.match(labels, /其他预设（只读）/);
  assert.match(labels, /规划架构/);
  assert.doesNotMatch(labels, /子代理派遣$/, 'the separate dispatch page must be gone');

  byText(tree, '规划架构').props.onClick();
  tree = await render(Page, emu);
  const after = texts(tree).join('|');
  assert.match(after, /预设设置/, 'the dialog must contain the preset section');
  assert.match(after, /子代理派遣设置/, 'the dialog must contain the dispatch section');
  assert.ok(findAll(tree, n => n.type === 'textarea' && n.props?.value === '分析目标。').length, 'the editor must load the stored prompt');
  assert.match(after, /允许作为子代理派遣/);
  assert.equal(findAll(tree, n => n.props?.role === 'dialog').length, 1, 'both sections must live in one dialog');
});

test('the dialog offers every catalog model and marks the ones outside the Host pool', async () => {
  const { Page, emu } = boot({ state: snapshot(), history: { runs: [] } });
  let tree = await render(Page, emu);
  byText(tree, '规划架构').props.onClick();
  tree = await render(Page, emu);
  const after = texts(tree).join('|');
  assert.match(after, /Flash/, 'an authorized catalog model must be listed');
  assert.match(after, /6\.1 Sol/, 'a catalog model outside the pool must still be listed');
  assert.match(after, /需授权/, 'an unauthorized model must be marked');
});

test('checking an unauthorized model blocks saving until global authorization is confirmed', async () => {
  const { Page, emu } = boot({ state: snapshot(), history: { runs: [] } });
  let tree = await render(Page, emu);
  byText(tree, '规划架构').props.onClick();
  tree = await render(Page, emu);

  const save = byText(tree, '保存');
  assert.ok(save, 'the dialog must expose a save action');
  assert.equal(save.props.disabled, false, 'a preset whose models are all authorized must save');

  const sol = checkboxNear(tree, '6.1 Sol');
  assert.ok(sol, 'the unauthorized model must have a checkbox');
  sol.props.onChange();
  tree = await render(Page, emu);
  assert.equal(byText(tree, '保存').props.disabled, true, 'saving must be blocked while a model needs authorization');
  assert.match(texts(tree).join('|'), /同时启用 DSH 全局模型授权/);

  checkboxNear(tree, '同时启用 DSH 全局模型授权').props.onChange({ target: { checked: true } });
  tree = await render(Page, emu);
  assert.equal(byText(tree, '保存').props.disabled, false, 'confirming authorization must unblock the save');
});

test('saving an owned preset sends definition, policy and the confirmed authorization in one request', async () => {
  const state = snapshot();
  const { Page, emu, calls } = boot({ state, history: { runs: [] },
    'agent-save': { hostPoolSaved: false, definitionSaved: true, policySaved: true, settingsSaved: false, errors: [], state } });
  let tree = await render(Page, emu);
  byText(tree, '规划架构').props.onClick();
  tree = await render(Page, emu);

  const name = findAll(tree, n => n.type === 'input' && n.props?.value === '规划架构')[0];
  assert.ok(name, 'the name field must be present');
  name.props.onChange({ target: { value: '规划架构二' } });
  tree = await render(Page, emu);
  byText(tree, '保存').props.onClick();
  await emu.flush();

  const save = calls.find(c => c.key === 'agent-save');
  assert.ok(save, 'the unified save endpoint must be used');
  assert.equal(save.body.definition.action, 'update');
  assert.equal(save.body.definition.definition.name, '规划架构二');
  assert.equal(save.body.definition.revision, 'def-1', 'the definition revision must be sent');
  assert.equal(save.body.settingsRevision, 7, 'the settings revision must be sent');
  assert.equal(save.body.policy.preset, 'planner');
  assert.equal(save.body.policy.defaultModel.model, 'deepseek-v4.1-flash');
  assert.equal(save.body.hostPool, undefined, 'no authorization write without confirmation');
});

test('the page injects its own stylesheet, so the cards are not bare HTML', async () => {
  const { Page, emu } = boot({ state: snapshot(), history: { runs: [] } });
  const tree = await render(Page, emu);
  const style = findAll(tree, n => n.type === 'style')[0];
  assert.ok(style, 'the section must ship its own <style> element');
  const css = texts(style).join('');
  assert.match(css, /\.pdispatch \.pd-card\{/, 'the card rules must be present');
  assert.match(css, /repeat\(auto-fill,minmax\(268px,1fr\)\)/, 'the native-style card grid must be present');
  assert.match(css, /--dsw-alias/, 'styling must go through theme tokens');
});

test('presets this plugin does not own are completely read-only on this page', async () => {
  const { Page, emu, calls } = boot({ state: snapshot(), history: { runs: [] } });
  let tree = await render(Page, emu);
  const card = findAll(tree, n => n.type === 'li' && texts(n).join('|').includes('标准代理'))[0];
  assert.ok(card, 'the read-only preset must still be listed');
  assert.match(texts(card).join('|'), /只读/, 'it must be labelled read-only');
  assert.equal(findAll(card, n => n.type === 'button').length, 0, 'it must expose no editable control');
  const main = findAll(card, n => n.props?.className === 'pd-card-main')[0];
  assert.equal(main.type, 'div', 'its body must not be a click target');
  assert.equal(main.props.onClick, undefined, 'no click handler may be attached');

  tree = await render(Page, emu);
  assert.equal(findAll(tree, n => n.props?.role === 'dialog').length, 0, 'no editor may open for it');
  assert.equal(calls.some(c => c.key === 'agent-save'), false, 'nothing may be written for it');
});

test('a zero-write failure is never reported as partial success', async () => {
  const state = snapshot();
  const { Page, emu } = boot({ state, history: { runs: [] },
    'agent-save': { definitionSaved: false, policySaved: false, hostPoolSaved: false, settingsSaved: false, errors: [{ part: 'definition', message: 'Preset configuration changed since it was read; reload' }], state } });
  let tree = await render(Page, emu);
  byText(tree, '规划架构').props.onClick();
  tree = await render(Page, emu);
  const name = findAll(tree, n => n.type === 'input' && n.props?.value === '规划架构')[0];
  name.props.onChange({ target: { value: '改名' } });
  tree = await render(Page, emu);
  byText(tree, '保存').props.onClick();
  await emu.flush();
  tree = emu.React.createElement(Page, {});
  await emu.flush();
  const after = texts(tree).join('|');
  assert.match(after, /未保存任何更改/, 'nothing was written, so nothing may be called saved');
  assert.doesNotMatch(after, /部分已保存/, 'a zero-write failure must not read as partial success');
  assert.match(after, /预设定义/);
  assert.match(after, /上次保存未全部完成/, 'a conflict must be surfaced with a way forward');
  assert.ok(byText(tree, '重新读取'), 'the stale draft needs a reload path inside the dialog');
  assert.equal(findAll(tree, n => n.props?.role === 'dialog').length, 1, 'a failed save must keep the dialog open');
});

test('a partial write reports exactly which parts landed and keeps the base revisions', async () => {
  const state = snapshot();
  const bumped = snapshot({ definitionRevision: 'def-2', settingsRevision: 99 });
  const { Page, emu, calls } = boot({ state, history: { runs: [] },
    'agent-save': { definitionSaved: false, policySaved: false, hostPoolSaved: true, settingsSaved: false, errors: [{ part: 'policy', message: '派遣策略已在其他页面更新；请重新读取后再保存' }], state: bumped } });
  let tree = await render(Page, emu);
  byText(tree, '规划架构').props.onClick();
  tree = await render(Page, emu);
  const name = findAll(tree, n => n.type === 'input' && n.props?.value === '规划架构')[0];
  name.props.onChange({ target: { value: '改名' } });
  tree = await render(Page, emu);
  byText(tree, '保存').props.onClick();
  await emu.flush();
  tree = emu.React.createElement(Page, {});
  await emu.flush();
  const after = texts(tree).join('|');
  assert.match(after, /部分已保存（已保存：全局模型授权）/, 'the widened authorization must be reported as landed');
  assert.match(after, /派遣策略/);
  assert.match(after, /配置状态待确认/, 'a partial write must also pause editing until the state is confirmed');
  assert.equal(byText(tree, '＋ 新建预设').props.disabled, true, 'page entry points must be locked as well');

  // The refreshed payload carried newer revisions, and the draft is now stale: the open
  // dialog must keep the original fences and refuse to fire a second save at all.
  const again = byText(tree, '保存');
  assert.equal(again.props.disabled, true, 'the stale dialog must not offer another save');
  again.props.onClick();
  await emu.flush();
  const saves = calls.filter(c => c.key === 'agent-save');
  assert.equal(saves.length, 1, 'a stale draft must not issue a blind retry');
  assert.equal(saves[0].body.definition.revision, 'def-1');
  assert.equal(saves[0].body.settingsRevision, 7);
  assert.equal(saves[0].body.hostPool, undefined, 'no authorization part when every selected model is already authorized');
});

test('the global dialog owns the Host pool, depth and stale policy rows', async () => {
  const state = snapshot();
  state.config.presetPolicies = [...state.config.presetPolicies, { preset: 'deleted-one', enabled: false, defaultModel: null, allowedModels: [], modelScope: 'host', lockModel: false, defaultEffort: null, allowedEfforts: [] }];
  const { Page, emu, calls } = boot({ state, history: { runs: [] },
    'agent-save': { definitionSaved: false, policySaved: false, hostPoolSaved: true, settingsSaved: true, errors: [], state } });
  let tree = await render(Page, emu);
  byText(tree, '全局设置').props.onClick();
  tree = await render(Page, emu);
  const after = texts(tree).join('|');
  assert.match(after, /DSH 子代理模型授权/);
  assert.match(after, /最大派遣深度/);
  assert.match(after, /发现失效策略行/);
  assert.match(after, /deleted-one/);

  byText(tree, '清理失效策略').props.onClick();
  tree = await render(Page, emu);
  byText(tree, '保存').props.onClick();
  await emu.flush();
  const save = calls.find(c => c.key === 'agent-save');
  assert.ok(save, 'the global dialog must save through the unified endpoint');
  assert.equal(save.body.maxDepth, 1);
  assert.equal(save.body.presetPolicies.some(row => row.preset === 'deleted-one'), false, 'cleanup must drop the stale row');
  assert.equal(save.body.hostPool, undefined, 'an untouched pool must not be written');
});

test('history and create entry points still work on the single page', async () => {
  const { Page, emu, calls } = boot({ state: snapshot(), history: { runs: [{ preset: 'planner', status: 'completed', provider: 'opencode-go', model: 'deepseek-v4.1-flash', modelSource: 'preset-default', effortSource: 'preset-default', presetVersion: 1, startedAt: '2026-01-01T00:00:00Z' }] } });
  let tree = await render(Page, emu);
  byText(tree, '调用记录').props.onClick();
  tree = await render(Page, emu);
  assert.ok(calls.some(c => c.key === 'history'), 'opening the history dialog must request runs');
  assert.match(texts(tree).join('|'), /预设默认/);

  byText(tree, '关闭').props.onClick();
  tree = await render(Page, emu);
  byText(tree, '＋ 新建预设').props.onClick();
  tree = await render(Page, emu);
  const after = texts(tree).join('|');
  assert.match(after, /稳定 ID/);
  assert.match(after, /新建 Agent 预设/);
});

test('a transport failure counts as an unknown outcome and demands a reload before retrying', async () => {
  const { Page, emu } = boot({ state: snapshot(), history: { runs: [] } }, { throwOn: ['agent-save'] });
  let tree = await render(Page, emu);
  byText(tree, '规划架构').props.onClick();
  tree = await render(Page, emu);
  const name = findAll(tree, n => n.type === 'input' && n.props?.value === '规划架构')[0];
  name.props.onChange({ target: { value: '改名' } });
  tree = await render(Page, emu);
  byText(tree, '保存').props.onClick();
  await emu.flush();
  tree = emu.React.createElement(Page, {});
  await emu.flush();
  const after = texts(tree).join('|');
  assert.match(after, /结果未知/, 'a lost response must not look like a clean failure');
  assert.ok(byText(tree, '重新读取'), 'the unknown outcome must offer a reload instead of a blind retry');
  assert.equal(findAll(tree, n => n.props?.role === 'dialog').length, 1);
});

test('a 200 response without the part contract is an unknown outcome, not a success', async () => {
  for (const bogus of [{}, [], { error: '失败' }]) {
    const { Page, emu } = boot({ state: snapshot(), history: { runs: [] }, 'agent-save': bogus });
    let tree = await render(Page, emu);
    byText(tree, '规划架构').props.onClick();
    tree = await render(Page, emu);
    const name = findAll(tree, n => n.type === 'input' && n.props?.value === '规划架构')[0];
    name.props.onChange({ target: { value: '改名' } });
    tree = await render(Page, emu);
    byText(tree, '保存').props.onClick();
    await emu.flush();
    tree = emu.React.createElement(Page, {});
    await emu.flush();
    const after = texts(tree).join('|');
    assert.doesNotMatch(after, /已保存并生效/, 'an unverifiable body must never read as saved');
    assert.match(after, /结果未知/);
    assert.match(after, /配置状态待确认/, 'editing must be blocked until the state is confirmed');
    assert.equal(byText(tree, '＋ 新建预设').props.disabled, true, 'no new edit may start on an unconfirmed state');
    assert.equal(byText(tree, '保存').props.disabled, true, 'the open dialog must not retry blindly');
  }
});

test('a successful reload clears the unknown state and restores editing', async () => {
  const { Page, emu, calls } = boot({ state: snapshot(), history: { runs: [] } }, { throwOn: ['agent-save'] });
  let tree = await render(Page, emu);
  byText(tree, '规划架构').props.onClick();
  tree = await render(Page, emu);
  const name = findAll(tree, n => n.type === 'input' && n.props?.value === '规划架构')[0];
  name.props.onChange({ target: { value: '改名' } });
  tree = await render(Page, emu);
  byText(tree, '保存').props.onClick();
  await emu.flush();
  tree = emu.React.createElement(Page, {});
  await emu.flush();
  assert.equal(byText(tree, '＋ 新建预设').props.disabled, true);

  const before = calls.filter(c => c.key === 'state').length;
  byText(tree, '重新读取').props.onClick();
  await emu.flush();
  tree = emu.React.createElement(Page, {});
  await emu.flush();
  assert.ok(calls.filter(c => c.key === 'state').length > before, 'the recovery path must re-read the state');
  const after = texts(tree).join('|');
  assert.doesNotMatch(after, /配置状态待确认/, 'a confirmed read must clear the warning');
  assert.equal(byText(tree, '＋ 新建预设').props.disabled, false, 'editing resumes once the state is confirmed');
});

test('a failed first read leaves a working retry and never opens an editor on missing data', async () => {
  const { Page, emu, calls } = boot({ state: snapshot() }, { fail: ['state'] });
  let tree = await render(Page, emu);
  assert.match(texts(tree).join('|'), /操作失败：boom/);

  const create = byText(tree, '＋ 新建预设');
  assert.equal(create.props.disabled, true, 'create must stay disabled without loaded data');
  create.props.onClick();
  tree = await render(Page, emu);
  assert.equal(texts(tree).join('|').includes('稳定 ID'), false, 'no editor may open without data');

  const retry = byText(tree, '重试读取');
  assert.ok(retry, 'a failed read must leave a retry entry point');
  assert.equal(retry.props.disabled, false);
  const before = calls.length;
  retry.props.onClick();
  await emu.flush();
  assert.ok(calls.length > before, 'retry must re-request the state');
});

test('the owned list follows the roster order, hides a repeated template label, and can be reordered', async () => {
  const state = snapshot();
  state.definitions = [
    { id: 'planner', name: '规划架构', description: '只读规划', prompt: '分析目标。', template: 'readonly', version: 1, order: 30 },
    // Its template label is the same word as its name, so the pill would only repeat it.
    { id: 'audit', name: '只读', description: '只读巡检', prompt: '检查依赖。', template: 'readonly', version: 1, order: 10 },
  ];
  const { Page, emu, calls } = boot({ state, history: { runs: [] } });
  let tree = await render(Page, emu);
  const names = findAll(tree, n => n.type === 'span' && n.props?.className === 'pd-card-name').map(node => texts(node).join(''));
  assert.deepEqual(names.slice(0, 2), ['只读', '规划架构'], 'the roster position decides the order, not the array order');
  const cardOf = label => findAll(tree, n => n.type === 'li' && n.props?.className === 'pd-card' && texts(n).join('|').includes(label))[0];
  const pillsOf = card => findAll(card, n => n.type === 'span' && n.props?.className === 'pd-pill').map(node => texts(node).join(''));
  assert.deepEqual(pillsOf(cardOf('只读巡检')), [], 'a template label that repeats the name must be hidden');
  assert.deepEqual(pillsOf(cardOf('规划架构')), ['只读'], 'a label that adds information must still be shown');

  // The last card cannot move down, the first cannot move up.
  const down = findAll(tree, n => n.type === 'button' && n.props?.['aria-label'] === '下移 规划架构')[0];
  const up = findAll(tree, n => n.type === 'button' && n.props?.['aria-label'] === '上移 只读')[0];
  assert.equal(up.props.disabled, true, 'the first preset cannot move up');
  assert.equal(down.props.disabled, true, 'the last preset cannot move down');

  const moveUp = findAll(tree, n => n.type === 'button' && n.props?.['aria-label'] === '上移 规划架构')[0];
  assert.equal(moveUp.props.disabled, false);
  moveUp.props.onClick();
  await emu.flush();
  const save = calls.filter(c => c.key === 'agent-save').at(-1);
  assert.deepEqual(save.body.definition, { action: 'move', id: 'planner', direction: 'up', revision: 'def-1' });
  assert.equal(save.body.policy, undefined, 'a move must not restate the policy');
});

test('a refused save explains itself inside the dialog, not behind it', async () => {
  // A protocol-level refusal (400 with an error body) never reaches the part contract, so it
  // used to be reported on the page only — hidden behind the modal overlay.
  const { Page, emu } = boot({ state: snapshot(), history: { runs: [] } }, { fail: ['agent-save'] });
  let tree = await render(Page, emu);
  byText(tree, '规划架构').props.onClick();
  tree = await render(Page, emu);
  findAll(tree, n => n.type === 'input' && n.props?.value === '规划架构')[0].props.onChange({ target: { value: '改名' } });
  tree = await render(Page, emu);
  byText(tree, '保存').props.onClick();
  await emu.flush();
  tree = emu.React.createElement(Page, {});
  await emu.flush();
  const dialog = findAll(tree, n => n.props?.role === 'dialog')[0];
  assert.ok(dialog, 'a refused save must keep the dialog open');
  assert.match(texts(dialog).join('|'), /操作失败|boom/, 'the reason must be visible inside the dialog');
});

test('a copied preset can still be named, while an existing preset keeps its id locked', async () => {
  const { Page, emu } = boot({ state: snapshot(), history: { runs: [] } });
  let tree = await render(Page, emu);
  const copy = findAll(tree, n => n.type === 'button' && texts(n).join('').trim() === '复制')[0];
  assert.ok(copy, 'an owned card must offer 复制');
  copy.props.onClick();
  tree = await render(Page, emu);
  const copyId = findAll(tree, n => n.type === 'input' && String(n.props?.value ?? '').endsWith('-copy'))[0];
  assert.ok(copyId, 'the copy dialog must prefill a new id');
  assert.equal(copyId.props.disabled, false, 'a copied preset must be nameable before it is created');

  byText(tree, '取消').props.onClick();
  tree = await render(Page, emu);
  byText(tree, '规划架构').props.onClick();
  tree = await render(Page, emu);
  const lockedId = findAll(tree, n => n.type === 'input' && n.props?.value === 'planner')[0];
  assert.ok(lockedId, 'the editor must show the stable id');
  assert.equal(lockedId.props.disabled, true, 'an existing preset id stays immutable');
});

test('resuming a save submits only the parts that did not land', async () => {
  const state = snapshot();
  // The definition really landed, so the outcome's own state shows the newer definition
  // revision; the settings revision was untouched because no policy was written.
  const landed = snapshot({ definitionRevision: 'def-2' });
  const { Page, emu, calls } = boot({
    state: () => landed,
    history: { runs: [] },
    'agent-save': { definitionSaved: true, policySaved: false, hostPoolSaved: false, settingsSaved: false,
      requested: { definitionSaved: true, policySaved: true, hostPoolSaved: false, settingsSaved: false },
      errors: [{ part: 'policy', code: 'conflict', message: '派遣策略已在其他页面更新；请重新读取后再保存' }], state: landed },
  });
  let tree = await render(Page, emu);
  byText(tree, '规划架构').props.onClick();
  tree = await render(Page, emu);
  byText(tree, '保存').props.onClick();
  await emu.flush();
  tree = emu.React.createElement(Page, {});
  await emu.flush();
  const panel = texts(tree).join('|');
  assert.match(panel, /上次保存未全部完成/, 'the dialog must report the unfinished save');
  assert.match(panel, /预设定义：已保存/, 'each requested part must state whether it landed');
  assert.match(panel, /派遣策略：未保存/);

  byText(tree, '提交未完成部分').props.onClick();
  await emu.flush();
  const saves = calls.filter(c => c.key === 'agent-save');
  assert.equal(saves.length, 2, 'resuming must issue exactly one more save');
  assert.equal(saves[1].body.definition, undefined, 'a landed part must not be written twice');
  assert.equal(saves[1].body.policy.preset, 'planner', 'the unfinished part must be resubmitted');
  assert.equal(saves[1].body.settingsRevision, 7, 'a resume is fenced on the revision it read, not on a stale draft');
  assert.notEqual(saves[1].body.operationId, saves[0].body.operationId, 'a retry is a new operation, never a replay');
});

test('a conflict found while resuming is compared and needs an explicit confirmation', async () => {
  const state = snapshot();
  const landed = snapshot({ definitionRevision: 'def-2' });
  // Someone else moved the settings revision after this draft was opened.
  const moved = snapshot({ definitionRevision: 'def-2', settingsRevision: 42 });
  let stateCalls = 0;
  const { Page, emu, calls } = boot({
    state: () => { stateCalls++; return stateCalls === 1 ? state : moved; },
    history: { runs: [] },
    'agent-save': { definitionSaved: false, policySaved: false, hostPoolSaved: false, settingsSaved: false,
      errors: [{ part: 'policy', code: 'conflict', message: '派遣策略已在其他页面更新；请重新读取后再保存' }], state: landed },
  });
  let tree = await render(Page, emu);
  byText(tree, '规划架构').props.onClick();
  tree = await render(Page, emu);
  byText(tree, '保存').props.onClick();
  await emu.flush();
  tree = emu.React.createElement(Page, {});
  await emu.flush();

  byText(tree, '提交未完成部分').props.onClick();
  await emu.flush();
  tree = emu.React.createElement(Page, {});
  await emu.flush();
  assert.equal(calls.filter(c => c.key === 'agent-save').length, 1, 'a conflict must not be submitted without confirmation');
  assert.match(texts(tree).join('|'), /检测到其他修改/, 'the difference must be shown, not just a refusal');
  assert.match(texts(tree).join('|'), /派遣策略或全局设置已更新（7 → 42）/, 'the actual revisions must be compared');
  assert.ok(byText(tree, '确认差异并提交'), 'the user needs an explicit way to confirm');

  byText(tree, '确认差异并提交').props.onClick();
  await emu.flush();
  const saves = calls.filter(c => c.key === 'agent-save');
  assert.equal(saves.length, 2, 'confirming submits once');
  assert.equal(saves[1].body.settingsRevision, 42, 'the confirmed retry uses the versions read now');
});

test('an unfinished save is restored after a page reload, without its authorization', async () => {
  storage = freshStore();
  try {
    const state = snapshot();
    const first = boot({ state, history: { runs: [] },
      'agent-save': { definitionSaved: false, policySaved: false, hostPoolSaved: false, settingsSaved: false, errors: [{ part: 'definition', message: 'changed' }], state } });
    let tree = await render(first.Page, first.emu);
    byText(tree, '规划架构').props.onClick();
    tree = await render(first.Page, first.emu);
    findAll(tree, n => n.type === 'input' && n.props?.value === '规划架构')[0].props.onChange({ target: { value: '改过的名字' } });
    tree = await render(first.Page, first.emu);
    byText(tree, '保存').props.onClick();
    await first.emu.flush();
    assert.ok(storage.held.size > 0, 'an unfinished save must be remembered in this tab');
    // The persisted payload is inspected directly: a stored draft must never carry the
    // authorization confirmation, whatever the dialog showed at the time.
    const stored = JSON.parse(storage.held.get('preset-dispatch:drafts'));
    assert.equal(Object.values(stored)[0].draft.authorize, false, 'a persisted draft must not carry the widening confirmation');

    // A new module instance over the same tab storage is what a page refresh looks like.
    const reloaded = boot({ state, history: { runs: [] } });
    tree = await render(reloaded.Page, reloaded.emu);
    byText(tree, '规划架构').props.onClick();
    tree = await render(reloaded.Page, reloaded.emu);
    const after = texts(tree).join('|');
    assert.ok(findAll(tree, n => n.type === 'input' && n.props?.value === '改过的名字').length, 'the unfinished draft must come back');
    assert.match(after, /上次保存未全部完成|已恢复未完成的草稿/, 'the recovered draft must be announced, with its recorded outcome');
    assert.equal(byText(tree, '保存').props.disabled, true, 'a restored draft stays read-only until it is continued or re-read');
    assert.ok(byText(tree, '提交未完成部分'), 'a restored draft must offer a way to finish it');
  } finally { storage = null; }
});
