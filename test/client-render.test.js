import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Minimal React hook emulator: enough to render the real client module and drive
// user events without a browser or a second React installation. It is NOT a
// browser: it cannot establish layout, focus, contrast or pointer behaviour.
function makeReact() {
  // These tests mount one root and at most one instance of each component type.
  const stores = new Map();
  let current = null;
  let seen = null;
  let dirty = false;
  const sameDeps = (a, b) => Array.isArray(a) && Array.isArray(b)
    && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
  const cleanupStore = s => {
    s.mounted = false;
    s.effects.clear();
    for (const hook of s.hooks) if (hook?.kind === 'effect' && typeof hook.cleanup === 'function') {
      const cleanup = hook.cleanup; hook.cleanup = undefined; cleanup();
    }
  };
  const Fragment = Symbol('Fragment');
  function store(fn) {
    let s = stores.get(fn);
    if (!s) { s = { hooks: [], cursor: 0, effects: new Map(), mounted: true }; stores.set(fn, s); }
    seen?.add(fn);
    return s;
  }
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
    useState(init) {
      const s = current, i = s.cursor++;
      if (!(i in s.hooks)) s.hooks[i] = typeof init === 'function' ? init() : init;
      return [s.hooks[i], value => {
        if (!s.mounted) return;
        const next = typeof value === 'function' ? value(s.hooks[i]) : value;
        if (!Object.is(next, s.hooks[i])) { s.hooks[i] = next; dirty = true; }
      }];
    },
    useRef(init) { const s = current, i = s.cursor++; if (!(i in s.hooks)) s.hooks[i] = { current: init }; return s.hooks[i]; },
    useEffect(fn, deps) {
      const s = current, i = s.cursor++;
      const hook = s.hooks[i] ?? { kind: 'effect', committed: false };
      s.hooks[i] = hook;
      if (!hook.committed || !sameDeps(hook.deps, deps)) s.effects.set(i, { fn, deps });
    },
    useMemo(fn, deps) {
      const s = current, i = s.cursor++, previous = s.hooks[i];
      if (!previous || !sameDeps(previous.deps, deps)) s.hooks[i] = { value: fn(), deps: deps?.slice() };
      return s.hooks[i].value;
    },
    useCallback(fn, deps) { return React.useMemo(() => fn, deps); },
  };
  const unmount = () => { for (const s of stores.values()) cleanupStore(s); stores.clear(); dirty = false; };
  return {
    React, unmount,
    reset: unmount,
    get dirty() { return dirty; },
    render(component, props) {
      dirty = false; seen = new Set();
      let tree;
      try { tree = React.createElement(component, props); } finally {
        for (const [fn, s] of stores) if (!seen.has(fn)) { cleanupStore(s); stores.delete(fn); }
        seen = null;
      }
      return tree;
    },
    async flush() {
      for (const s of stores.values()) {
        const effects = [...s.effects]; s.effects.clear();
        for (const [i, { fn, deps }] of effects) {
          const hook = s.hooks[i];
          if (typeof hook.cleanup === 'function') hook.cleanup();
          hook.cleanup = undefined;
          hook.deps = deps?.slice(); hook.committed = true;
          const cleanup = fn();
          if (typeof cleanup === 'function') hook.cleanup = cleanup;
        }
      }
      for (let i = 0; i < 8; i++) await new Promise(r => setImmediate(r));
    },
  };
}

test('the React fixture compares deps, cleans up before replacement effects, and cleans up on unmount', async () => {
  const emu = makeReact();
  const lifecycle = [];
  function Observer({ id }) {
    emu.React.useEffect(() => {
      lifecycle.push('subscribe:' + id);
      return () => { lifecycle.push('cleanup:' + id); };
    }, [id]);
    return null;
  }
  emu.render(Observer, { id: 'first' });
  assert.deepEqual(lifecycle, [], 'render alone must not commit an effect');
  await emu.flush();
  assert.deepEqual(lifecycle, ['subscribe:first'], 'mount commits one subscription');
  emu.render(Observer, { id: 'first' });
  await emu.flush();
  assert.deepEqual(lifecycle, ['subscribe:first'], 'equal deps do not resubscribe or clean up');
  emu.render(Observer, { id: 'second' });
  assert.deepEqual(lifecycle, ['subscribe:first'], 'changed deps still wait for commit');
  await emu.flush();
  assert.deepEqual(lifecycle, ['subscribe:first', 'cleanup:first', 'subscribe:second'], 'old cleanup precedes the new effect');
  emu.unmount();
  assert.deepEqual(lifecycle, ['subscribe:first', 'cleanup:first', 'subscribe:second', 'cleanup:second'], 'unmount releases the current effect');
  emu.unmount();
  assert.deepEqual(lifecycle, ['subscribe:first', 'cleanup:first', 'subscribe:second', 'cleanup:second'], 'repeated unmount cannot repeat cleanup');
});

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

/**
 * A strict stand-in for the visibility event stream. The real surface is an SSE endpoint, so a
 * card or badge only ever learns the observed configuration from a frame; recording the URL and
 * replaying frames is what lets the tests assert the URL a surface actually requested, not a
 * second mock renderer.
 */
function makeEventSource() {
  const frames = [];
  const live = [];
  class FakeEventSource {
    constructor(url) {
      this.url = String(url);
      this.listeners = new Map();
      this.closed = false;
      this.closeCount = 0;
      live.push(this);
    }
    addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(fn); }
    emit(type, data) { for (const fn of this.listeners.get(type) ?? []) fn({ type, data: typeof data === 'string' ? data : JSON.stringify(data) }); }
    emitSnapshot(payload) { this.emit('snapshot', payload); }
    emitPending() { this.emit('pending', '{}'); }
    emitError() { this.emit('error', '{}'); }
    close() { this.closed = true; this.closeCount += 1; }
  }
  const emu = {
    FakeEventSource,
    /** Every stream opened so far, oldest first. */
    streams: live,
    /** The most recently opened stream: what a single mounted surface is following now. */
    get current() { return live.at(-1) ?? null; },
    reset() { live.length = 0; frames.length = 0; },
  };
  return { emu, frames, streams: live, get current() { return emu.current; } };
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

// Only declared Host slots can activate an injection. Labels such as "chat surfaces"
// are not slot names and must never run a factory or create a registration.
function makeSlots() {
  const slots = {
    declaredNames: new Set([
      'settings.section',
      'tool.call.toolview',
      'conversation.input.left',
      'conversation.session.header.actions',
    ]),
    injectNames: [], unmatchedInjectNames: [], disposers: [],
    calls: [], byName: new Map(), byNameAndId: new Map(),
    inject(name, factory) {
      slots.injectNames.push(name);
      if (!slots.declaredNames.has(name)) {
        slots.unmatchedInjectNames.push(name);
        return undefined;
      }
      const disposer = factory();
      if (typeof disposer === 'function') slots.disposers.push(disposer);
      return disposer;
    },
    dispose() {
      for (const disposer of slots.disposers.splice(0)) disposer();
    },
  };
  return slots;
}

function assertDeclaredInjections(slots) {
  assert.deepEqual(slots.unmatchedInjectNames, [], 'every plugin inject key must name a declared Host slot');
  for (const name of slots.injectNames) {
    assert.ok(slots.declaredNames.has(name), `the injected slot ${name} must be declared by the Host`);
  }
}

test('the slot fixture activates only declared slots and releases returned disposers on unload', () => {
  const slots = makeSlots();
  const activated = [], released = [], expectedDisposers = [];
  for (const name of slots.declaredNames) {
    const disposer = () => { released.push(name); };
    expectedDisposers.push(disposer);
    assert.equal(slots.inject(name, () => { activated.push(name); return disposer; }), disposer,
      'inject returns the factory disposer so effect can own it');
  }
  assert.deepEqual(activated, [...slots.declaredNames], 'each declared slot activates its factory exactly once');
  assert.deepEqual(slots.disposers, expectedDisposers, 'inject must retain the factory disposers for unload');
  assertDeclaredInjections(slots);

  let unmatchedFactoryCalls = 0;
  for (const name of ['chat surfaces', '', undefined]) {
    assert.equal(slots.inject(name, () => { unmatchedFactoryCalls += 1; return () => {}; }), undefined,
      'an undeclared slot cannot activate a factory');
  }
  assert.equal(unmatchedFactoryCalls, 0, 'undeclared, empty and missing slot names never run factories');
  assert.deepEqual(slots.unmatchedInjectNames, ['chat surfaces', '', undefined], 'all unmatched inject names are recorded');
  assert.deepEqual(slots.injectNames, [...slots.declaredNames, 'chat surfaces', '', undefined], 'every inject attempt is recorded');
  assert.deepEqual(slots.disposers, expectedDisposers, 'unmatched factories cannot add disposers');
  assert.deepEqual(released, [], 'factory disposers wait until unload');
  slots.dispose();
  assert.deepEqual(released, [...slots.declaredNames], 'unload releases every activated injection');
  slots.dispose();
  assert.deepEqual(released, [...slots.declaredNames], 'repeated unload does not repeat cleanup');
});

function loadClient() {
  const code = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
  const emu = makeReact();
  const events = makeEventSource();
  let captured;
  const listeners = {};
  // Slot registrations are recorded the way the Host keeps them: a ledger keyed by the
  // registration's own id or key, never by "the last one that registered". A mock that only
  // remembered the last settings would make the chat surfaces invisible to every assertion.
  const slots = makeSlots();
  const sandbox = {
    console, setTimeout, clearTimeout, setImmediate,
    fetch: (...args) => fetchImpl(...args),
    EventSource: events.emu.FakeEventSource,
    document: { activeElement: null, addEventListener: (t, f) => { listeners[t] = f; }, removeEventListener: t => { delete listeners[t]; }, querySelector: () => null },
    window: { __ModuleLoader__: { load: m => { captured = m; } }, confirm: () => true, addEventListener() {}, removeEventListener() {} },
    sessionStorage: storage ?? freshStore(),
    require: name => { if (name === 'react') return emu.React; throw new Error('unexpected import ' + name); },
  };
  vm.runInNewContext(code, sandbox, { filename: 'client.js' });
  assert.equal(captured.id, '@local/dsh-preset-dispatch');
  const api = captured.factory(sandbox.require);
  return { api, emu, events, slots };
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

/** Settle the emulator's event loop to expose any unexpected later work. */
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(r => setImmediate(r)); };

async function boot(responses, opts = {}) {
  const { api, emu, events, slots } = loadClient();
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
  const dictionaries = {};
  const slotDisposers = slots.disposers;
  const navigation = { sessions: [], resources: [], lookups: [] };
  const services = {
    uiWorkspace: { openSession: sessionId => { navigation.sessions.push(sessionId); } },
    sidebarRight: { openResource: (resource, options) => { navigation.resources.push({ resource, options: { ...options } }); } },
    ...opts.services,
  };
  const ctx = {
    // Deliberately no direct uiWorkspace/sidebarRight properties: exercise the Host's get path.
    get(name) { navigation.lookups.push(name); return services[name]; },
    locale: { getLocale: () => ({ locales: [{ id: 'zh-CN' }] }),
      register: (ns, _lang, value) => { dictionaries[ns] = value; },
      bind: ns => key => (dictionaries[ns] && dictionaries[ns][key]) ?? key },
    effect: fn => { const d = fn(); return typeof d === 'function' ? d : () => {}; },
    slots: {
      inject: slots.inject,
      // The Host keeps a ledger of registrations. Keying by the registration's own id/key is
      // what makes several contributions to one slot observable instead of only the last one.
      register: (definition, component) => {
        const entry = {
          definition, component,
          name: definition?.name ?? null, id: definition?.id ?? null, key: definition?.key ?? null,
          order: definition?.order ?? null,
          label: typeof definition?.label === 'function' ? definition.label() : (definition?.label ?? null),
        };
        slots.calls.push(entry);
        if (!slots.byName.has(entry.name)) slots.byName.set(entry.name, []);
        slots.byName.get(entry.name).push(entry);
        slots.byNameAndId.set(`${entry.name}\u0000${entry.id ?? entry.key ?? `#${slots.calls.length}`}`, entry);
        return () => { entry.disposed = true; };
      },
    },
  };
  api.apply(ctx);
  assert.ok(slots.byName.get('settings.section')?.length, 'the settings.section page must be registered');
  if (opts.disposeAfterApply) {
    // Do not await here: all four contributions must exist synchronously when apply returns.
    const entries = [
      contribution(slots, 'settings.section', 'preset-dispatch'),
      contribution(slots, 'tool.call.toolview', 'preset_dispatch'),
      contribution(slots, 'conversation.input.left', 'preset-dispatch-child'),
      contribution(slots, 'conversation.session.header.actions', 'preset-dispatch-child'),
    ];
    assert.equal(slots.calls.length, 4, 'apply synchronously registers all four contributions');
    assert.equal(entries.filter(entry => entry.disposed === true).length, 0, 'all four contributions are active when apply returns');
    assert.equal(slotDisposers.length, 4, 'each real slot injection supplies its own registration disposer');
    slots.dispose();
    for (const entry of entries) assert.equal(entry.disposed, true, `immediate unload releases the ${entry.name} contribution`);
    assert.equal(slots.calls.filter(entry => entry.disposed !== true).length, 0, 'immediate unload leaves no active contribution');
  }
  // Registrations are synchronous; settling only exposes any unexpected later work.
  await settle();
  assertDeclaredInjections(slots);
  return { Page: slots.byName.get('settings.section')[0].component, emu, calls, slots, events, navigation };
}

/** The registered component for one slot contribution; fails loudly when it was never added. */
function contribution(slots, name, identity) {
  const entry = slots.byNameAndId.get(`${name}\u0000${identity}`);
  assert.ok(entry, `the ${name} slot contribution ${identity} must be registered`);
  return entry;
}

async function render(Page, emu) { return renderWith(Page, emu, {}); }

/** Commit effects, then return the latest tree after any effect/async state updates. */
async function renderWith(component, emu, props) {
  for (let i = 0; i < 20; i++) {
    const tree = emu.render(component, props);
    await emu.flush();
    if (!emu.dirty) return tree;
  }
  throw new Error('React emulator did not settle after 20 committed renders');
}

test('one page lists owned and read-only presets, and a card opens a single dialog with both sections', async () => {
  const { Page, emu, calls } = await boot({ state: snapshot(), history: { runs: [] } });
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
  const { Page, emu } = await boot({ state: snapshot(), history: { runs: [] } });
  let tree = await render(Page, emu);
  byText(tree, '规划架构').props.onClick();
  tree = await render(Page, emu);
  const after = texts(tree).join('|');
  assert.match(after, /Flash/, 'an authorized catalog model must be listed');
  assert.match(after, /6\.1 Sol/, 'a catalog model outside the pool must still be listed');
  assert.match(after, /需授权/, 'an unauthorized model must be marked');
});

test('checking an unauthorized model blocks saving until global authorization is confirmed', async () => {
  const { Page, emu } = await boot({ state: snapshot(), history: { runs: [] } });
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
  const { Page, emu, calls } = await boot({ state, history: { runs: [] },
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
  const { Page, emu } = await boot({ state: snapshot(), history: { runs: [] } });
  const tree = await render(Page, emu);
  const style = findAll(tree, n => n.type === 'style')[0];
  assert.ok(style, 'the section must ship its own <style> element');
  const css = texts(style).join('');
  assert.match(css, /\.pdispatch \.pd-card\{/, 'the card rules must be present');
  assert.match(css, /repeat\(auto-fill,minmax\(268px,1fr\)\)/, 'the native-style card grid must be present');
  assert.match(css, /--dsw-alias/, 'styling must go through theme tokens');
});

test('presets this plugin does not own are completely read-only on this page', async () => {
  const { Page, emu, calls } = await boot({ state: snapshot(), history: { runs: [] } });
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
  const { Page, emu } = await boot({ state, history: { runs: [] },
    'agent-save': { definitionSaved: false, policySaved: false, hostPoolSaved: false, settingsSaved: false, errors: [{ part: 'definition', message: 'Preset configuration changed since it was read; reload' }], state } });
  let tree = await render(Page, emu);
  byText(tree, '规划架构').props.onClick();
  tree = await render(Page, emu);
  const name = findAll(tree, n => n.type === 'input' && n.props?.value === '规划架构')[0];
  name.props.onChange({ target: { value: '改名' } });
  tree = await render(Page, emu);
  byText(tree, '保存').props.onClick();
  await emu.flush();
  tree = await render(Page, emu);
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
  const { Page, emu, calls } = await boot({ state, history: { runs: [] },
    'agent-save': { definitionSaved: false, policySaved: false, hostPoolSaved: true, settingsSaved: false, errors: [{ part: 'policy', message: '派遣策略已在其他页面更新；请重新读取后再保存' }], state: bumped } });
  let tree = await render(Page, emu);
  byText(tree, '规划架构').props.onClick();
  tree = await render(Page, emu);
  const name = findAll(tree, n => n.type === 'input' && n.props?.value === '规划架构')[0];
  name.props.onChange({ target: { value: '改名' } });
  tree = await render(Page, emu);
  byText(tree, '保存').props.onClick();
  await emu.flush();
  tree = await render(Page, emu);
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
  const { Page, emu, calls } = await boot({ state, history: { runs: [] },
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
  const { Page, emu, calls } = await boot({ state: snapshot(), history: { runs: [{ preset: 'planner', status: 'completed', provider: 'opencode-go', model: 'deepseek-v4.1-flash', modelSource: 'preset-default', effortSource: 'preset-default', presetVersion: 1, startedAt: '2026-01-01T00:00:00Z' }] } });
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
  const { Page, emu } = await boot({ state: snapshot(), history: { runs: [] } }, { throwOn: ['agent-save'] });
  let tree = await render(Page, emu);
  byText(tree, '规划架构').props.onClick();
  tree = await render(Page, emu);
  const name = findAll(tree, n => n.type === 'input' && n.props?.value === '规划架构')[0];
  name.props.onChange({ target: { value: '改名' } });
  tree = await render(Page, emu);
  byText(tree, '保存').props.onClick();
  await emu.flush();
  tree = await render(Page, emu);
  const after = texts(tree).join('|');
  assert.match(after, /结果未知/, 'a lost response must not look like a clean failure');
  assert.ok(byText(tree, '重新读取'), 'the unknown outcome must offer a reload instead of a blind retry');
  assert.equal(findAll(tree, n => n.props?.role === 'dialog').length, 1);
});

test('a 200 response without the part contract is an unknown outcome, not a success', async () => {
  for (const bogus of [{}, [], { error: '失败' }]) {
    const { Page, emu } = await boot({ state: snapshot(), history: { runs: [] }, 'agent-save': bogus });
    let tree = await render(Page, emu);
    byText(tree, '规划架构').props.onClick();
    tree = await render(Page, emu);
    const name = findAll(tree, n => n.type === 'input' && n.props?.value === '规划架构')[0];
    name.props.onChange({ target: { value: '改名' } });
    tree = await render(Page, emu);
    byText(tree, '保存').props.onClick();
    await emu.flush();
    tree = await render(Page, emu);
    const after = texts(tree).join('|');
    assert.doesNotMatch(after, /已保存并生效/, 'an unverifiable body must never read as saved');
    assert.match(after, /结果未知/);
    assert.match(after, /配置状态待确认/, 'editing must be blocked until the state is confirmed');
    assert.equal(byText(tree, '＋ 新建预设').props.disabled, true, 'no new edit may start on an unconfirmed state');
    assert.equal(byText(tree, '保存').props.disabled, true, 'the open dialog must not retry blindly');
  }
});

test('a successful reload clears the unknown state and restores editing', async () => {
  const { Page, emu, calls } = await boot({ state: snapshot(), history: { runs: [] } }, { throwOn: ['agent-save'] });
  let tree = await render(Page, emu);
  byText(tree, '规划架构').props.onClick();
  tree = await render(Page, emu);
  const name = findAll(tree, n => n.type === 'input' && n.props?.value === '规划架构')[0];
  name.props.onChange({ target: { value: '改名' } });
  tree = await render(Page, emu);
  byText(tree, '保存').props.onClick();
  await emu.flush();
  tree = await render(Page, emu);
  assert.equal(byText(tree, '＋ 新建预设').props.disabled, true);

  const before = calls.filter(c => c.key === 'state').length;
  byText(tree, '重新读取').props.onClick();
  await emu.flush();
  tree = await render(Page, emu);
  assert.ok(calls.filter(c => c.key === 'state').length > before, 'the recovery path must re-read the state');
  const after = texts(tree).join('|');
  assert.doesNotMatch(after, /配置状态待确认/, 'a confirmed read must clear the warning');
  assert.equal(byText(tree, '＋ 新建预设').props.disabled, false, 'editing resumes once the state is confirmed');
});

test('a failed first read leaves a working retry and never opens an editor on missing data', async () => {
  const { Page, emu, calls } = await boot({ state: snapshot() }, { fail: ['state'] });
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
  const { Page, emu, calls } = await boot({ state, history: { runs: [] } });
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
  const { Page, emu } = await boot({ state: snapshot(), history: { runs: [] } }, { fail: ['agent-save'] });
  let tree = await render(Page, emu);
  byText(tree, '规划架构').props.onClick();
  tree = await render(Page, emu);
  findAll(tree, n => n.type === 'input' && n.props?.value === '规划架构')[0].props.onChange({ target: { value: '改名' } });
  tree = await render(Page, emu);
  byText(tree, '保存').props.onClick();
  await emu.flush();
  tree = await render(Page, emu);
  const dialog = findAll(tree, n => n.props?.role === 'dialog')[0];
  assert.ok(dialog, 'a refused save must keep the dialog open');
  assert.match(texts(dialog).join('|'), /操作失败|boom/, 'the reason must be visible inside the dialog');
});

test('a copied preset can still be named, while an existing preset keeps its id locked', async () => {
  const { Page, emu } = await boot({ state: snapshot(), history: { runs: [] } });
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
  const { Page, emu, calls } = await boot({
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
  tree = await render(Page, emu);
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
  const { Page, emu, calls } = await boot({
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
  tree = await render(Page, emu);

  byText(tree, '提交未完成部分').props.onClick();
  await emu.flush();
  tree = await render(Page, emu);
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
    const first = await boot({ state, history: { runs: [] },
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
    const reloaded = await boot({ state, history: { runs: [] } });
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

// ---------------------------------------------------------------------------------------------
// Phase B chat surfaces: the dispatch card and the child-session badge (docs/08 V01-V10).
//
// These drive the real registered components through the slot ledger. They establish DOM shape
// and data flow only: this emulator has no layout, focus, contrast or pointer behaviour, so no
// assertion here is evidence about the rendered pixels.
// ---------------------------------------------------------------------------------------------

const PARENT_SESSION = 'parent-abc';
const CHILD_SESSION = 'child-9';

/** The host props every chat surface slot receives. */
function hostProps(extra = {}) {
  return {
    parentSession: PARENT_SESSION,
    useDisclosure: () => ({ expanded: false, toggle() {} }),
    inspect: () => {},
    ...extra,
  };
}

/** A result-phase block envelope shaped like the persisted presentation meta. */
function runBlock(patch = {}) {
  const { meta: metaPatch, ...rest } = patch;
  return {
    phase: 'result',
    argsRaw: JSON.stringify({ preset: 'researcher', task: 'do it' }),
    call: { id: 'call-1', argsRaw: JSON.stringify({ preset: 'researcher', task: 'do it' }) },
    content: [{ type: 'text', text: '工作结果正文' }],
    isError: false,
    meta: {
      marker: 'preset-dispatch/run', formatVersion: 1,
      preset: 'researcher', presetName: '研究检索', presetVersion: 2,
      call: { id: 'call-1' }, child: { sessionId: CHILD_SESSION },
      run: { id: 'run-1', status: 'completed' },
      plan: { provider: 'opencode-go', model: 'deepseek-v4.1-flash', reasoningEffort: 'high', modelSource: 'preset-default', effortSource: 'preset-default' },
      ...metaPatch,
    },
    ...rest,
  };
}

/** One frame of the metadata route's payload, exactly as `visibilityPayload` builds it. */
function visibilityFrame(patch = {}) {
  return {
    id: 'run-1', preset: 'researcher', presetName: '研究检索', presetVersion: 2,
    status: 'running', observationStatus: 'observed',
    callId: 'call-1', rootCallId: null, parentSession: PARENT_SESSION, childSessionId: CHILD_SESSION,
    planned: { provider: 'opencode-go', model: 'deepseek-v4.1-flash', reasoningEffort: 'high', modelSource: 'preset-default', effortSource: 'preset-default' },
    observed: { provider: 'opencode-go', model: 'deepseek-v4.1-flash', reasoningEffort: 'high' },
    verified: true, observedEffortSource: 'preset-default', changes: [],
    verification: '实际请求（已核实）', verificationDetail: '', restored: false,
    ...patch,
  };
}

/** Query parameters of the stream URL a surface actually opened. */
const streamParams = stream => {
  assert.ok(stream, 'the surface must have opened a visibility stream');
  return new URL(stream.url, 'http://127.0.0.1').searchParams;
};

test('the chat surfaces are registered as real slot contributions, keyed by their own id or key', async () => {
  const { slots } = await boot({ state: snapshot(), history: { runs: [] } });
  assertDeclaredInjections(slots);
  for (const name of slots.declaredNames) {
    assert.ok(slots.injectNames.includes(name), `the plugin must inject through the real ${name} slot`);
  }

  const toolview = contribution(slots, 'tool.call.toolview', 'preset_dispatch');
  assert.equal(toolview.key, 'preset_dispatch', 'the dispatch card must claim only its own tool key');
  assert.equal(toolview.id, null, 'the tool view is addressed by its tool key, not an id');

  const composer = contribution(slots, 'conversation.input.left', 'preset-dispatch-child');
  assert.equal(composer.id, 'preset-dispatch-child');
  assert.equal(typeof composer.order, 'number', 'an additive list contribution needs a defined position');
  assert.equal(typeof composer.label, 'string', 'the contribution must be able to name itself');
  assert.notEqual(composer.label, '', 'an empty label would be an unlabelled list entry');

  // A one-shot read-only preview replaces the input area, so both additive seats are needed.
  const header = contribution(slots, 'conversation.session.header.actions', 'preset-dispatch-child');
  assert.equal(header.id, 'preset-dispatch-child', 'the header has its own id-addressed registration');
  assert.equal(header.key, null, 'the badge must not claim an official keyed seat');
  assert.equal(composer.key, null, 'the input badge must not claim an official keyed seat');
  assert.notEqual(header, composer, 'each slot must retain its independent registration');
  assert.equal(typeof header.order, 'number', 'the header is an additive ordered contribution');
  const page = contribution(slots, 'settings.section', 'preset-dispatch');
  assert.ok(page.component, 'the settings page must still be registered alongside the chat surfaces');
  assert.ok(toolview.component, 'the dispatch tool card must still be registered');
  assert.equal(slots.calls.filter(entry => entry.name === 'conversation.input.left').length, 1, 'exactly one badge may be contributed per slot');
  assert.equal(slots.calls.filter(entry => entry.name === 'conversation.session.header.actions').length, 1, 'the preview header must have exactly one badge contribution');
});

test('the read-only preview renders the child badge through its header contribution without a composer', async () => {
  const { emu, slots, events } = await boot({ state: snapshot(), history: { runs: [] } });
  const HeaderBadge = contribution(slots, 'conversation.session.header.actions', 'preset-dispatch-child').component;
  const props = { sessionId: CHILD_SESSION, useProjection: () => ({ origin: 'subagent', agentPreset: 'researcher', parentSession: PARENT_SESSION }) };
  await renderWith(HeaderBadge, emu, props);
  assert.equal(events.streams.length, 1, 'a header-only preview independently follows the child');
  events.current.emitSnapshot(visibilityFrame());
  const tree = await renderWith(HeaderBadge, emu, props);
  assert.match(texts(tree).join('|'), /研究检索/, 'the preview header shows the dispatch snapshot name');
  assert.match(texts(tree).join('|'), /deepseek-v4\.1-flash/, 'the preview header shows the observed model without an input area');
  emu.unmount();
  assert.equal(events.current.closeCount, 1, 'closing the preview releases its header observer');
});

test('the badge falls back to the session header when the composer slot is refused, never dropping the surface', async () => {
  const { api, slots } = loadClient();
  api.apply({
    locale: { getLocale: () => ({ locales: [{ id: 'zh-CN' }] }), register() {}, bind: () => key => key },
    effect: fn => { const d = fn(); return typeof d === 'function' ? d : () => {}; },
    slots: {
      inject: slots.inject,
      register: (definition, component) => {
        if (definition?.name === 'conversation.input.left') throw new Error('slot unavailable');
        const entry = { name: definition?.name, id: definition?.id ?? null, key: definition?.key ?? null, component };
        slots.calls.push(entry);
        slots.byNameAndId.set(`${entry.name}\u0000${entry.id ?? entry.key}`, entry);
        if (!slots.byName.has(entry.name)) slots.byName.set(entry.name, []);
        slots.byName.get(entry.name).push(entry);
        return () => {};
      },
    },
    logger: { warn() {} },
  });
  await settle();
  assertDeclaredInjections(slots);
  const header = slots.byNameAndId.get('conversation.session.header.actions\u0000preset-dispatch-child');
  assert.ok(header, 'a refused composer slot must fall back to the session header');
  assert.ok(header.component, 'the fallback must carry the real badge component, not a placeholder');
  assert.equal(header.id, 'preset-dispatch-child', 'the fallback keeps the same identity so it cannot be added twice');
  // The tool view and the settings page must survive a refusal of the composer slot alone.
  assert.ok(slots.byNameAndId.get('tool.call.toolview\u0000preset_dispatch'), 'the dispatch card must not be lost when only the composer slot is refused');
  assert.ok(slots.byNameAndId.get('settings.section\u0000preset-dispatch'), 'the settings page must not be lost either');
});

test('the dispatch card shows the plan, then the real observed request from the stream, in all three phases', async () => {
  const { emu, slots, events } = await boot({ state: snapshot(), history: { runs: [] } });
  const Card = contribution(slots, 'tool.call.toolview', 'preset_dispatch').component;
  const nonce = String(Date.now());

  // 1. preparing: no arguments yet, so nothing may be presented as a chosen configuration.
  const preparing = await renderWith(Card, emu, hostProps({ phase: 'preparing', block: null }));
  const preparingText = texts(preparing).join('|');
  assert.match(preparingText, /准备中/, 'the preparing phase must state that it is only preparing');
  assert.doesNotMatch(preparingText, /deepseek-v4\.1-flash/, 'no route may be shown before anything is known');
  assert.equal(events.streams.length, 0, 'a call with no identifier cannot be followed yet');

  // 2. start: the arguments are shown AS A PLAN, never as the actual configuration.
  const startBlock = { argsRaw: JSON.stringify({ preset: 'researcher', task: nonce }) };
  const started = await renderWith(Card, emu, hostProps({ phase: 'start', callId: 'call-1', block: startBlock }));
  const startedText = texts(started).join('|');
  assert.match(startedText, /计划配置/, 'the start phase must label its values as planned');
  assert.match(startedText, /尚未观察到实际请求|以子会话的首个请求为准/, 'the start phase must say the actual request is not known yet');
  assert.doesNotMatch(startedText, /实际请求（已核实）/, 'a submitted task is not a verified request');
  assert.equal(events.streams.length, 1, 'the start phase must subscribe to the run it just dispatched');
  assert.equal(streamParams(events.current).get('callId'), 'call-1');
  assert.equal(streamParams(events.current).get('childSessionId'), null, 'the start phase has not learned a child id yet');
  // A caller that knows which session dispatched the run must say so: the endpoint binds a
  // record to its parent, and an unbound lookup is what a foreign caller's request looks like.
  assert.equal(streamParams(events.current).get('parentSession'), PARENT_SESSION, 'the visibility request must state the parent session it is asking about');

  // 3. result before any frame: the recorded meta is all there is, and it is a plan, not a fact.
  const resultBlock = runBlock({ content: [{ type: 'text', text: `结果正文 ${nonce}` }] });
  const resultProps = hostProps({ phase: 'result', block: resultBlock, useDisclosure: () => ({ expanded: true, toggle() {} }) });
  let resultTree = await renderWith(Card, emu, resultProps);
  assert.equal(streamParams(events.current).get('childSessionId'), CHILD_SESSION, 'the result phase follows the recorded child');
  const resultText = texts(resultTree).join('|');
  assert.match(resultText, /计划配置/, 'the plan line must render the recorded plan rather than "unknown"');
  assert.match(resultText, /opencode-go \/ deepseek-v4\.1-flash/, 'the planned route must be visible');
  assert.match(resultText, /计划配置，尚未观察到实际请求/, 'with no frame the actual request stays explicitly unverified');

  // The stream now reports what the child actually committed: the card must show THAT value.
  events.current.emitSnapshot(visibilityFrame({ observed: { provider: 'codex-chatgpt', model: 'gpt-6.1-sol', reasoningEffort: 'medium' } }));
  resultTree = await renderWith(Card, emu, resultProps);
  const observedText = texts(resultTree).join('|');
  assert.match(observedText, /codex-chatgpt \/ gpt-6\.1-sol/, 'the observed request from the stream must be displayed');
  assert.match(observedText, /实际请求（已核实）|medium/, 'the observed value must be presented as the actual request');
  assert.match(observedText, /opencode-go \/ deepseek-v4\.1-flash/, 'the plan must remain visible beside the actual so the two can be compared');
  assert.doesNotMatch(observedText, /计划配置，尚未观察到实际请求/, 'a frame with a real observation must clear the unverified line');

  // 4. result: the work result, the error path and the inspection entry point all survive.
  assert.match(resultText, new RegExp(`结果正文 ${nonce}`), 'the work result must not be hidden by the card');
  assert.ok(findAll(resultTree, n => n.type === 'button' && /展开详情|收起详情/.test(texts(n).join(''))).length, 'the result must keep its disclosure control');
  assert.ok(findAll(resultTree, n => n.type === 'button' && texts(n).join('').includes('在轨迹中查看')).length, 'the result must keep its inspection entry point');

  let inspected = 0;
  const errorTree = await renderWith(Card, emu, hostProps({ phase: 'result', block: runBlock({ isError: true, error: { code: 'denied', reason: '拒绝' } }), inspect: () => { inspected += 1; } }));
  const errorText = texts(errorTree).join('|');
  assert.match(errorText, /失败/, 'an errored dispatch must be shown as a failure');
  assert.match(errorText, /错误：拒绝/, 'the refusal reason must be visible on the card');
  findAll(errorTree, n => n.type === 'button' && texts(n).join('').includes('在轨迹中查看'))[0].props.onClick();
  assert.equal(inspected, 1, 'the inspection control must still fire its callback');
});

test('V11 recorded child metadata exposes both navigation actions through ctx.get services', async () => {
  const { emu, slots, navigation } = await boot({ state: snapshot(), history: { runs: [] } });
  const Card = contribution(slots, 'tool.call.toolview', 'preset_dispatch').component;
  const childSessionId = 'child-record-confirmed';
  const tree = await renderWith(Card, emu, hostProps({ phase: 'result', block: runBlock({ meta: { child: { sessionId: childSessionId, started: true } } }) }));
  const enter = byText(tree, '进入子会话');
  const sidebar = byText(tree, '在侧边栏打开');
  assert.ok(enter, 'a recorded confirmed child must offer entry into its session');
  assert.ok(sidebar, 'a recorded confirmed child must offer a sidebar entry');
  await enter.props.onClick();
  assert.deepEqual(navigation.sessions, [childSessionId], 'entry calls uiWorkspace.openSession with the recorded id');
  assert.equal(navigation.resources.length, 0, 'entering the child must not also open a sidebar pane');
  await sidebar.props.onClick();
  assert.deepEqual(navigation.resources, [{ resource: 'dsh-resource://subagentchat/session/' + childSessionId, options: { kind: 'subagentchat', preferNewPane: true } }], 'sidebar entry uses the official resource URI and pane options');
  assert.deepEqual(navigation.sessions, [childSessionId], 'sidebar entry must not switch the current session');
  assert.ok(['uiWorkspace', 'sidebarRight'].every(name => navigation.lookups.includes(name)), 'navigation services are obtained through ctx.get');
});

test('V11 a visibility frame confirms the child id when no child metadata was recorded', async () => {
  const { emu, slots, events, navigation } = await boot({ state: snapshot(), history: { runs: [] } });
  const Card = contribution(slots, 'tool.call.toolview', 'preset_dispatch').component;
  const props = hostProps({ phase: 'start', callId: 'call-1', block: { argsRaw: JSON.stringify({ preset: 'researcher' }) } });
  let tree = await renderWith(Card, emu, props);
  assert.equal(byText(tree, '进入子会话'), undefined, 'a submitted call is not yet a confirmed child');
  assert.equal(byText(tree, '在侧边栏打开'), undefined, 'no sidebar target may be guessed before a frame');
  const childSessionId = 'child-frame-confirmed';
  events.current.emitSnapshot(visibilityFrame({ childSessionId }));
  tree = await renderWith(Card, emu, props);
  const enter = byText(tree, '进入子会话');
  const sidebar = byText(tree, '在侧边栏打开');
  assert.ok(enter, 'the frame-confirmed child must offer session entry while the card is running');
  assert.ok(sidebar, 'the frame-confirmed child must offer sidebar entry while the card is running');
  await enter.props.onClick();
  assert.deepEqual(navigation.sessions, [childSessionId], 'entry uses the child id from the frame, not a call id or label');
  assert.equal(navigation.resources.length, 0, 'session entry must not open a resource pane');
  await sidebar.props.onClick();
  assert.deepEqual(navigation.resources, [{ resource: 'dsh-resource://subagentchat/session/' + childSessionId, options: { kind: 'subagentchat', preferNewPane: true } }]);
  assert.deepEqual(navigation.sessions, [childSessionId], 'opening the resource leaves the current session unchanged');
  assert.ok(['uiWorkspace', 'sidebarRight'].every(name => navigation.lookups.includes(name)), 'frame navigation also reads services through ctx.get');
});

for (const [name, extra] of [
  ['preparing', { phase: 'preparing', block: null }],
  ['result without meta.child', { phase: 'result', block: runBlock({ meta: { child: null } }) }],
  // core's background childStarted:false becomes presentation meta.child.started:false.
  ['background childStarted:false with a reserved id', { phase: 'result', block: runBlock({ meta: { kind: 'background', observationState: 'pending', childSessionId: 'reserved-not-started', child: { sessionId: 'reserved-not-started', started: false, jobId: 'job-pending' }, run: { status: 'running' } } }) }],
]) {
  test(`V11 ${name} hides both navigation actions until a child is confirmed`, async () => {
    const { emu, slots, navigation } = await boot({ state: snapshot(), history: { runs: [] } });
    const Card = contribution(slots, 'tool.call.toolview', 'preset_dispatch').component;
    const tree = await renderWith(Card, emu, hostProps(extra));
    assert.equal(byText(tree, '进入子会话'), undefined, 'an unconfirmed child must not expose session entry');
    assert.equal(byText(tree, '在侧边栏打开'), undefined, 'an unconfirmed child must not expose resource entry');
    assert.deepEqual(navigation.sessions, [], 'rendering an unconfirmed child must not switch sessions');
    assert.deepEqual(navigation.resources, [], 'rendering an unconfirmed child must not open resources');
  });
}

for (const [name, services, canEnter, canOpenSidebar] of [
  ['uiWorkspace missing', { uiWorkspace: undefined }, false, true],
  ['sidebarRight missing', { sidebarRight: undefined }, true, false],
  ['both services missing', { uiWorkspace: undefined, sidebarRight: undefined }, false, false],
]) {
  test(`V11 ${name} hides only unavailable navigation actions without throwing`, async () => {
    const { emu, slots, navigation } = await boot({ state: snapshot(), history: { runs: [] } }, { services });
    const Card = contribution(slots, 'tool.call.toolview', 'preset_dispatch').component;
    let tree;
    await assert.doesNotReject(async () => { tree = await renderWith(Card, emu, hostProps({ phase: 'result', block: runBlock({ meta: { child: { sessionId: CHILD_SESSION, started: true } } }) })); }, 'missing optional services must not break rendering');
    assert.equal(Boolean(byText(tree, '进入子会话')), canEnter, 'session entry is available only when uiWorkspace exists');
    assert.equal(Boolean(byText(tree, '在侧边栏打开')), canOpenSidebar, 'resource entry is available only when sidebarRight exists');
    assert.deepEqual(navigation.sessions, [], 'rendering must not trigger navigation');
    assert.deepEqual(navigation.resources, [], 'rendering must not open a pane');
  });
}

for (const observationStatus of ['pending', 'missing', 'created', 'observed', 'finished']) {
  test(`V11 a frame with ${observationStatus} observationStatus gates both child navigation actions`, async () => {
    const { emu, slots, events, navigation } = await boot({ state: snapshot(), history: { runs: [] } });
    try {
      const Card = contribution(slots, 'tool.call.toolview', 'preset_dispatch').component;
      const props = hostProps({ phase: 'start', callId: 'call-1', block: { argsRaw: JSON.stringify({ preset: 'researcher' }) } });
      let tree = await renderWith(Card, emu, props);
      assert.equal(byText(tree, '进入子会话'), undefined, 'there is no recorded confirmation before the frame');
      const childSessionId = 'child-frame-' + observationStatus;
      const hasObservedRequest = observationStatus === 'observed' || observationStatus === 'finished';
      const frame = visibilityFrame({ childSessionId, observationStatus,
        status: observationStatus === 'finished' ? 'completed' : 'running',
        observed: hasObservedRequest ? visibilityFrame().observed : null,
        verified: hasObservedRequest,
        verification: hasObservedRequest ? '实际请求（已核实）' : '计划配置，尚未观察到实际请求' });
      if (observationStatus === 'missing') delete frame.observationStatus;
      events.current.emitSnapshot(frame);
      tree = await renderWith(Card, emu, props);
      const enter = byText(tree, '进入子会话');
      const sidebar = byText(tree, '在侧边栏打开');
      const confirmed = ['created', 'observed', 'finished'].includes(observationStatus);
      assert.equal(Boolean(enter), confirmed, 'a reserved frame id alone is not proof of child creation');
      assert.equal(Boolean(sidebar), confirmed, 'both V11 actions require a confirmed observation state');
      assert.deepEqual(navigation.sessions, [], 'rendering never navigates');
      assert.deepEqual(navigation.resources, [], 'rendering never opens a pane');
      if (confirmed) {
        await enter.props.onClick();
        await sidebar.props.onClick();
        assert.deepEqual(navigation.sessions, [childSessionId]);
        assert.deepEqual(navigation.resources, [{ resource: 'dsh-resource://subagentchat/session/' + childSessionId, options: { kind: 'subagentchat', preferNewPane: true } }]);
      }
    } finally { emu.unmount(); }
  });
}

for (const [status, label] of [['failed', '失败'], ['completed', '已完成'], ['aborted', '已取消']]) {
  test(`a start-phase card displays the record's ${status} status instead of waiting for the child`, async () => {
    const { emu, slots, events } = await boot({ state: snapshot(), history: { runs: [] } });
    try {
      const Card = contribution(slots, 'tool.call.toolview', 'preset_dispatch').component;
      const props = hostProps({ phase: 'start', callId: 'call-1', block: { argsRaw: JSON.stringify({ preset: 'researcher' }) } });
      let tree = await renderWith(Card, emu, props);
      assert.match(texts(tree).join('|'), /已派遣，等待子会话/, 'without a row, start still has its existing waiting state');
      events.current.emitSnapshot(visibilityFrame({ status, observationStatus: status === 'completed' ? 'finished' : status === 'aborted' ? 'interrupted' : 'failed' }));
      tree = await renderWith(Card, emu, props);
      const head = findAll(tree, node => node.props?.className === 'pdv-head')[0];
      assert.ok(head, 'the visible card header must exist');
      const headerText = texts(head).join('|');
      assert.match(headerText, new RegExp(label), 'the status badge must show the settled row outcome even while Host phase is start');
      assert.doesNotMatch(headerText, /已派遣，等待子会话/, 'a settled record must replace the fixed start label');
    } finally { emu.unmount(); }
  });
}

test('unloading after registration releases the settings page and all three chat contributions', async () => {
  const { slots } = await boot({ state: snapshot(), history: { runs: [] } });
  const entries = [
    contribution(slots, 'settings.section', 'preset-dispatch'),
    contribution(slots, 'tool.call.toolview', 'preset_dispatch'),
    contribution(slots, 'conversation.input.left', 'preset-dispatch-child'),
    contribution(slots, 'conversation.session.header.actions', 'preset-dispatch-child'),
  ];
  assert.equal(entries.filter(entry => entry.disposed === true).length, 0, 'all four contributions are active before unload');
  assert.equal(slots.disposers.length, 4, 'each real slot injection returns its own registration disposer');
  const registrationsBeforeUnload = slots.calls.slice();
  slots.dispose();
  for (const entry of entries) assert.equal(entry.disposed, true, `unload releases the ${entry.name} contribution`);
  assert.equal(slots.calls.filter(entry => entry.disposed !== true).length, 0, 'no contribution remains active after unload');
  await settle();
  assert.deepEqual(slots.calls, registrationsBeforeUnload, 'no new registration may land after unload, even if immediately disposed');
  assert.equal(slots.calls.filter(entry => entry.disposed !== true).length, 0, 'later work cannot resurrect an unloaded contribution');
});

test('unloading immediately after synchronous apply releases all four contributions and prevents later registrations', async () => {
  const { slots } = await boot({ state: snapshot(), history: { runs: [] } }, { disposeAfterApply: true });
  const entries = [
    contribution(slots, 'settings.section', 'preset-dispatch'),
    contribution(slots, 'tool.call.toolview', 'preset_dispatch'),
    contribution(slots, 'conversation.input.left', 'preset-dispatch-child'),
    contribution(slots, 'conversation.session.header.actions', 'preset-dispatch-child'),
  ];
  assert.equal(slots.calls.length, 4, 'no registration may land after immediate unload');
  for (const entry of entries) assert.equal(entry.disposed, true, `the ${entry.name} contribution stays released after immediate unload`);
  assert.equal(slots.calls.filter(entry => entry.disposed !== true).length, 0, 'all four synchronous contributions must be released after immediate unload');
  const registrationsAfterUnload = slots.calls.slice();
  await settle();
  assert.deepEqual(slots.calls, registrationsAfterUnload, 'later work must not add any registration, even if immediately disposed');
  assert.equal(slots.calls.filter(entry => entry.disposed !== true).length, 0, 'later work must not resurrect a card or badge contribution');
});

test('the card follows the record it was given and never another session\'s, even when the observer changes', async () => {
  const { emu, slots, events } = await boot({ state: snapshot(), history: { runs: [] } });
  const Card = contribution(slots, 'tool.call.toolview', 'preset_dispatch').component;
  const firstBlock = runBlock({ content: [{ type: 'text', text: 'first run result' }] });

  await renderWith(Card, emu, hostProps({ phase: 'result', block: firstBlock }));
  const first = events.current;
  assert.equal(streamParams(first).get('childSessionId'), CHILD_SESSION);

  // A second dispatch is observed by the same card surface: it must follow the NEW record.
  const secondBlock = runBlock({ content: [{ type: 'text', text: 'second run result' }], meta: { call: { id: 'call-2' }, child: { sessionId: 'child-other' } } });
  const secondProps = hostProps({ phase: 'result', block: secondBlock });
  let secondTree = await renderWith(Card, emu, secondProps);
  const second = events.current;
  assert.notEqual(second, first, 'a different run must open its own stream rather than reuse the previous one');
  assert.equal(streamParams(second).get('callId'), 'call-2');
  assert.equal(streamParams(second).get('childSessionId'), 'child-other');
  assert.equal(first.closed, true, 'the previous run\'s stream must be released when the observer moves on');
  assert.equal(first.closeCount, 1, 'the released observer must not keep following the old record');

  // A frame on the new record must never resurrect the old one's values.
  second.emitSnapshot(visibilityFrame({ callId: 'call-2', childSessionId: 'child-other', observed: { provider: 'codex-chatgpt', model: 'gpt-6.1-sol', reasoningEffort: 'medium' } }));
  secondTree = await renderWith(Card, emu, secondProps);
  const movedText = texts(secondTree).join('|');
  assert.match(movedText, /codex-chatgpt \/ gpt-6\.1-sol/);
  assert.equal(first.closed, true, 'a stale observer stays closed after the new frame arrives');
});

test('V02 the result card keeps the dispatch-time name and version despite a later SSE rename', async () => {
  const { emu, slots, events } = await boot({ state: snapshot(), history: { runs: [] } });
  const Card = contribution(slots, 'tool.call.toolview', 'preset_dispatch').component;
  const block = runBlock({ meta: { preset: 'researcher', presetName: '旧名字', presetVersion: 2 }, content: [{ type: 'text', text: 'result' }] });
  const props = hostProps({ phase: 'result', block });
  let tree = await renderWith(Card, emu, props);
  const initialText = texts(tree).join('|');
  assert.match(initialText, /旧名字/, 'the persisted dispatch snapshot name must be shown');
  assert.match(initialText, /版本 2/, 'the dispatch-time version snapshot must be shown');

  events.current.emitSnapshot(visibilityFrame({ presetName: '新名字', presetVersion: 3 }));
  tree = await renderWith(Card, emu, props);
  const updatedText = texts(tree).join('|');
  assert.match(updatedText, /旧名字/, 'a later rename must not rewrite this dispatch snapshot');
  assert.match(updatedText, /版本 2/, 'a later version must not rewrite this dispatch snapshot');
  assert.doesNotMatch(updatedText, /新名字|版本 3/, 'the same run must not adopt a later preset definition');
});

test('V02 a running card learns its frozen name and version from the record, falling back to meta before a record', async () => {
  const { emu, slots, events } = await boot({ state: snapshot(), history: { runs: [] } });
  const Card = contribution(slots, 'tool.call.toolview', 'preset_dispatch').component;
  const props = hostProps({ phase: 'start', callId: 'call-1', block: runBlock({ meta: { presetName: '元数据快照', presetVersion: 2 } }) });
  let tree = await renderWith(Card, emu, props);
  assert.match(texts(tree).join('|'), /元数据快照/, 'before a record the running card falls back to recorded meta');
  assert.match(texts(tree).join('|'), /版本 2/, 'the fallback includes the recorded version');
  events.current.emitSnapshot(visibilityFrame({ presetName: '派遣记录快照', presetVersion: 4 }));
  tree = await renderWith(Card, emu, props);
  assert.match(texts(tree).join('|'), /派遣记录快照/, 'a running card uses the dispatch row name');
  assert.match(texts(tree).join('|'), /版本 4/, 'a running card uses the dispatch row version');
  assert.doesNotMatch(texts(tree).join('|'), /元数据快照|版本 2/, 'the row is authoritative once available');
  events.current.emitSnapshot(visibilityFrame({ presetName: '后来重命名', presetVersion: 5 }));
  tree = await renderWith(Card, emu, props);
  assert.match(texts(tree).join('|'), /派遣记录快照/, 'the same run retains its first record snapshot name');
  assert.match(texts(tree).join('|'), /版本 4/, 'the same run retains its first record snapshot version');
  assert.doesNotMatch(texts(tree).join('|'), /后来重命名|版本 5/, 'later SSE metadata cannot rewrite the dispatch snapshot');
});

test('the child badge appears only for this plugin\'s own child and states what was actually observed', async () => {
  const { emu, slots, events } = await boot({ state: snapshot(), history: { runs: [] } });
  const Badge = contribution(slots, 'conversation.input.left', 'preset-dispatch-child').component;
  const childRoute = { origin: 'subagent', agentPreset: 'researcher', agentSessionId: CHILD_SESSION, parentSession: PARENT_SESSION };

  // A main session, or a child some other plugin created, must render nothing at all.
  const foreign = await renderWith(Badge, emu, { sessionId: 'main-session', useProjection: () => null });
  assert.equal(foreign, null, 'a session this plugin did not dispatch must not carry the badge');
  const otherPlugin = await renderWith(Badge, emu, { sessionId: 'other-child', useProjection: () => ({ origin: 'other', agentPreset: 'x' }) });
  assert.equal(otherPlugin, null, 'a subagent from another channel must not be claimed by this badge');
  assert.equal(events.streams.length, 0, 'no stream may be opened for a session this plugin does not own');

  // A pending frame is not a record either: nothing may be shown for it.
  const badgeProps = { sessionId: CHILD_SESSION, useProjection: () => childRoute };
  let pendingTree = await renderWith(Badge, emu, badgeProps);
  assert.equal(events.streams.length, 1, 'the plugin\'s own child must be followed');
  assert.equal(streamParams(events.current).get('childSessionId'), CHILD_SESSION);
  events.current.emitPending();
  pendingTree = await renderWith(Badge, emu, badgeProps);
  assert.equal(texts(pendingTree).join('|'), '', 'a run with nothing recorded yet must render as nothing, not as a guess');

  // A real frame must show the observed request and label an unverified one honestly.
  events.current.emitSnapshot(visibilityFrame({ observed: null, verified: false, observedEffortSource: 'unknown', verification: '计划配置，尚未观察到实际请求' }));
  pendingTree = await renderWith(Badge, emu, badgeProps);
  const plannedText = texts(pendingTree).join('|');
  assert.match(plannedText, /计划配置，尚未观察到实际请求|未核实/, 'a record without an observed request must say so');
  assert.match(plannedText, /研究检索/, 'the preset snapshot name must be shown');

  events.current.emitSnapshot(visibilityFrame());
  pendingTree = await renderWith(Badge, emu, badgeProps);
  const observedText = texts(pendingTree).join('|');
  assert.match(observedText, /deepseek-v4\.1-flash/, 'the observed model must be displayed');
  assert.match(observedText, /high/, 'the observed effort must be displayed');

  // The expanded details must name where each value came from, so a reader can tell them apart.
  const badge = findAll(pendingTree, n => n.type === 'button')[0];
  badge.props.onClick();
  pendingTree = await renderWith(Badge, emu, badgeProps);
  const detailText = texts(pendingTree).join('|');
  assert.match(detailText, /计划配置/, 'the expanded badge must separate the plan from the actual request');
  assert.match(detailText, /实际请求/, 'the expanded badge must label the observed value');
  assert.match(detailText, /预设快照/, 'the expanded badge must state the preset snapshot and version');
  assert.match(detailText, /子会话/, 'the expanded badge must name the child session it describes');
});

test('V09 a mounted badge retains its stream until session change or unmount, never until a mere flush', async () => {
  const { emu, slots, events } = await boot({ state: snapshot(), history: { runs: [] } });
  const Badge = contribution(slots, 'conversation.input.left', 'preset-dispatch-child').component;
  const props = { sessionId: CHILD_SESSION, useProjection: () => ({ origin: 'subagent', agentPreset: 'researcher', parentSession: PARENT_SESSION }) };
  await renderWith(Badge, emu, props);
  const first = events.current;
  assert.equal(first.closed, false, 'committing the mount must not run cleanup');
  assert.equal(events.streams.length, 1, 'one mounted observer opens one stream');
  await renderWith(Badge, emu, props);
  assert.equal(events.current, first, 'unchanged dependencies reuse the mounted subscription');
  assert.equal(events.streams.length, 1, 'an unchanged render must not resubscribe');
  assert.equal(first.closeCount, 0, 'an unchanged render must not clean up');
  const moved = { ...props, sessionId: 'child-other' };
  await renderWith(Badge, emu, moved);
  const second = events.current;
  assert.notEqual(second, first, 'session change opens a new subscription');
  assert.equal(first.closeCount, 1, 'session change cleans up the previous subscription once');
  assert.equal(second.closed, false, 'the new subscription remains open after commit');
  emu.unmount();
  assert.equal(second.closeCount, 1, 'unmount cleans up the active subscription once');
  emu.unmount();
  assert.equal(second.closeCount, 1, 'a second unmount cannot repeat cleanup');
});

test('the badge never invents a thinking level the provider did not disclose', async () => {
  const { emu, slots, events } = await boot({ state: snapshot(), history: { runs: [] } });
  const Badge = contribution(slots, 'conversation.input.left', 'preset-dispatch-child').component;
  const props = { sessionId: CHILD_SESSION, useProjection: () => ({ origin: 'subagent', agentPreset: 'researcher', parentSession: PARENT_SESSION }) };
  let tree = await renderWith(Badge, emu, props);

  events.current.emitSnapshot(visibilityFrame({
    observed: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' },
    observedEffortSource: 'adapter-default',
    verified: true,
    verification: '实际请求（已核实）',
  }));
  tree = await renderWith(Badge, emu, props);
  const shown = texts(tree).join('|');
  assert.match(shown, /deepseek-v4\.1-flash/, 'the model is disclosed, so it must be shown');
  for (const level of ['low', 'medium', 'high']) {
    assert.doesNotMatch(shown, new RegExp(`·\\s*${level}`), `an undisclosed adapter default must not be printed as ${level}`);
  }
  findAll(tree, n => n.type === 'button')[0].props.onClick();
  tree = await renderWith(Badge, emu, props);
  const detail = texts(tree).join('|');
  assert.match(detail, /模型默认（具体值未披露）|未知/, 'an undisclosed default must be stated as undisclosed');
});
