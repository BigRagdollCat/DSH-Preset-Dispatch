import test from 'node:test';
import assert from 'node:assert/strict';
import { ROLES, roleTools } from '../roles.js';
import { TEMPLATES, templateRole, revisionOf, validateDefinition, definitionRow, definitionsFrom, initialDefinitions, mutateDefinitions, orderOf } from '../managed-presets.js';

const ROLE_ENTRY = 'file:///plugin/role-managed.js';
const MAX = { name: 120, description: 1000, prompt: 24000 };
const TEMPLATE_NAMES = ['readonly', 'researcher', 'implementer', 'test-author', 'verifier'];
const BASE_PLUGINS = ['tool-presentation', 'persona', 'agent-instructions', 'tool-fs', 'tool-fs-search', 'skill-filesystem', 'tool-skill'];
const TEMPLATE_PLUGINS = ['tool-pwsh', 'tool-jobs', 'tool-web'];
const TOOL_OF_PLUGIN = { 'tool-pwsh': 'pwsh', 'tool-jobs': 'pwsh', 'tool-web': 'web_search' };
const readOnlyIds = ['planner', 'investigator', 'reviewer'];

const valid = patch => ({ id: 'night-audit', name: '夜间审计', description: '只读巡检', prompt: '检查依赖。', template: 'readonly', ...patch });
const definitionWith = patch => ({ id: 'custom', name: '自定义', description: '自定义描述', prompt: '自定义提示', template: 'verifier', ...patch });
const safe = row => structuredClone(row);

function ownedRows(ids = ['alpha', 'beta']) {
  const roleEntry = ROLE_ENTRY;
  return ids.map((id, i) => definitionRow(definitionWith({ id, name: '角色 ' + id, template: i === 0 ? 'implementer' : 'readonly' }), roleEntry));
}
const mutate = (rows, input, extra = {}) => mutateDefinitions(rows, input, { roleEntry: ROLE_ENTRY, roster: [], ...extra });
const withRevision = (rows, input) => ({ revision: revisionOf(rows), ...input });

// ---------------------------------------------------------------- validateDefinition

test('validateDefinition rejects non-object identities', () => {
  for (const bad of [undefined, null, 'night-audit', 7, true, [], ['night-audit'], new Date(), () => valid()]) {
    assert.throws(() => validateDefinition(bad), /Invalid preset definition/, `accepted ${String(bad)}`);
  }
});

test('validateDefinition keeps valid ids and rejects malformed ones', () => {
  for (const id of ['a', 'night-audit', 'a1-b2-c3', 'x9']) assert.equal(validateDefinition(valid({ id })).id, id);
  for (const id of ['', 'Night-Audit', 'night_audit', 'night audit', '-night', 'night-', 'night--audit', '9night', 'night.audit', 'ä-night']) {
    assert.throws(() => validateDefinition(valid({ id })), /Invalid preset id/, `accepted id ${id}`);
  }
  for (const id of [1, null, undefined, {}, ['night-audit']]) {
    assert.throws(() => validateDefinition(valid({ id })), /Invalid preset id/, `accepted id ${String(id)}`);
  }
  const longest = 'a' + '-a'.repeat(31);
  assert.equal(longest.length, 63);
  assert.equal(validateDefinition(valid({ id: longest })).id, longest);
  assert.throws(() => validateDefinition(valid({ id: 'a'.repeat(65) })), /Invalid preset id/);
});

test('validateDefinition rejects unknown permission templates', () => {
  for (const template of ['', 'READONLY', 'read-only', 'planner', 'admin', 'verifer', 1, null, undefined, {}, ['readonly']]) {
    assert.throws(() => validateDefinition(valid({ template })), /Invalid permission template/, `accepted ${String(template)}`);
  }
  for (const template of TEMPLATE_NAMES) assert.equal(validateDefinition(valid({ template })).template, template);
  assert.equal(templateRole('readonly'), 'planner');
  assert.equal(templateRole('verifier'), 'verifier');
});

test('validateDefinition bounds name, description and prompt', () => {
  assert.throws(() => validateDefinition(valid({ name: '' })), /Invalid name/);
  assert.throws(() => validateDefinition(valid({ name: '   ' })), /Invalid name/);
  assert.throws(() => validateDefinition(valid({ name: 7 })), /Invalid name/);
  assert.throws(() => validateDefinition(valid({ description: 7 })), /Invalid description/);
  assert.throws(() => validateDefinition(valid({ prompt: null })), /Invalid prompt/);
  for (const key of Object.keys(MAX)) assert.throws(() => validateDefinition(valid({ [key]: undefined })), new RegExp('Invalid ' + key));
  assert.equal(validateDefinition(valid({ name: 'n'.repeat(MAX.name) })).name.length, MAX.name);
  assert.throws(() => validateDefinition(valid({ name: 'n'.repeat(MAX.name + 1) })), /Invalid name/);
  assert.equal(validateDefinition(valid({ description: 'd'.repeat(MAX.description) })).description.length, MAX.description);
  assert.throws(() => validateDefinition(valid({ description: 'd'.repeat(MAX.description + 1) })), /Invalid description/);
  assert.equal(validateDefinition(valid({ prompt: 'p'.repeat(MAX.prompt) })).prompt.length, MAX.prompt);
  assert.throws(() => validateDefinition(valid({ prompt: 'p'.repeat(MAX.prompt + 1) })), /Invalid prompt/);
  assert.equal(validateDefinition(valid({ description: '' })).description, '');
  assert.equal(validateDefinition(valid({ prompt: '' })).prompt, '');
});

test('validateDefinition normalizes name and version without mutating input', () => {
  const input = valid({ name: '  角色  ', version: 4 });
  const d = validateDefinition(input);
  assert.equal(d.name, '角色');
  assert.equal(d.version, 4);
  assert.notEqual(d, input);
  assert.equal(input.name, '  角色  ', 'input mutated');
  assert.deepEqual(Object.keys(d).sort(), ['description', 'id', 'name', 'order', 'prompt', 'template', 'version']);
  assert.deepEqual(validateDefinition(valid()), { ...valid(), name: '夜间审计', version: 1, order: 20 });
  for (const version of [undefined, 0, -3, 1.5, '2', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(validateDefinition(valid({ version })).version, 1, `accepted version ${String(version)}`);
  }
  assert.equal(validateDefinition(valid({ version: 1 })).version, 1);
  assert.equal(validateDefinition(valid({ version: 25 })).version, 25);
});

// ---------------------------------------------------------------- initialDefinitions

test('initialDefinitions keeps the seven built-in role definitions unchanged', () => {
  const defs = initialDefinitions();
  const ids = Object.keys(ROLES);
  assert.equal(ids.length, 7);
  assert.deepEqual(defs.map(d => d.id), ids);
  assert.equal(new Set(defs.map(d => d.id)).size, 7);
  for (const d of defs) {
    const role = ROLES[d.id];
    assert.deepEqual(d, {
      id: d.id,
      name: role.name,
      description: role.description,
      prompt: role.prompt,
      template: readOnlyIds.includes(d.id) ? 'readonly' : d.id,
      version: 1,
    });
    assert.equal(Object.hasOwn(TEMPLATES, d.template), true, `unknown template ${d.template}`);
    assert.equal(validateDefinition(d).template, d.template);
    assert.equal(templateRole(d.template), readOnlyIds.includes(d.id) ? 'planner' : d.id);
  }
  assert.equal(validateDefinition({ ...defs[0], id: 'night', version: 1 }).version, 1);
  assert.notEqual(initialDefinitions(), defs, 'expected a fresh array');
});

// ---------------------------------------------------------------- definitionRow

test('definitionRow declares an owned native preset row with the base plugin set', () => {
  const d = validateDefinition(valid());
  const row = definitionRow(d, ROLE_ENTRY);
  assert.deepEqual(Object.keys(row).sort(), ['config', 'id', 'name']);
  assert.equal(row.id, 'preset-night-audit');
  assert.equal(row.name, '@deepseek-ai/dsh-agent-preset');
  assert.equal(row.config.id, 'night-audit');
  assert.equal(row.config.name, '夜间审计');
  assert.equal(row.config.description, '只读巡检');
  assert.equal(row.config.order, 20);
  const ids = row.config.plugins.map(p => p.id);
  assert.deepEqual(ids, [...BASE_PLUGINS, 'role-policy']);
  assert.equal(ids.includes('tool-presentation'), true);
  for (const id of TEMPLATE_PLUGINS) assert.equal(ids.includes(id), false, `readonly row declared ${id}`);
  const presented = row.config.plugins.find(p => p.id === 'tool-presentation');
  assert.equal(presented.name, '@deepseek-ai/dsh-agent-tool-presentation');
  assert.equal(presented.config.mode, 'native');
  assert.equal(row.config.plugins.find(p => p.id === 'persona').name, '@deepseek-ai/dsh-persona');
  assert.equal(typeof row.config.plugins.find(p => p.id === 'persona').config.prefix, 'string');
  assert.deepEqual(row.config.plugins.find(p => p.id === 'agent-instructions').config, { maxBytes: 65536 });
  assert.deepEqual(row.config.plugins.find(p => p.id === 'tool-fs').config, undefined);
  assert.deepEqual(row.config.plugins.find(p => p.id === 'tool-fs-search').config, { sampleOverCapGlobResults: false });
  assert.equal(row.config.plugins.find(p => p.id === 'skill-filesystem').name, '@deepseek-ai/dsh-skill-filesystem');
  assert.equal(row.config.plugins.find(p => p.id === 'tool-skill').name, '@deepseek-ai/dsh-tool-skill');
  const role = row.config.plugins.at(-1);
  assert.equal(role.id, 'role-policy');
  assert.equal(role.name, ROLE_ENTRY);
  assert.equal(role.config.role, 'planner');
  assert.deepEqual(role.config.definition, d);
  for (const p of row.config.plugins.filter(p => p.id !== 'role-policy')) assert.match(p.name, /^@deepseek-ai\/dsh-/, `unnamespaced plugin ${p.id}`);
});

test('definitionRow declares exactly the tools the template role grants', () => {
  for (const template of TEMPLATE_NAMES) {
    const role = templateRole(template);
    const row = definitionRow(definitionWith({ template }), ROLE_ENTRY);
    const allowed = roleTools(role);
    const ids = row.config.plugins.map(p => p.id);
    for (const [plugin, tool] of Object.entries(TOOL_OF_PLUGIN)) {
      assert.equal(ids.includes(plugin), allowed.has(tool), `${template} (${role}) declared ${plugin} without ${tool}`);
    }
    for (const id of ids) assert.equal(BASE_PLUGINS.includes(id) || TEMPLATE_PLUGINS.includes(id) || id === 'role-policy', true, `unknown plugin ${id}`);
    assert.equal(row.config.plugins.find(p => p.id === 'role-policy').config.role, role);
    if (role === 'researcher') assert.deepEqual(row.config.plugins.find(p => p.id === 'tool-web').config, { fetch: true, searchTimeoutMs: 60000 });
    else assert.equal(ids.includes('tool-web'), false);
  }
  const implementer = definitionRow(definitionWith({ template: 'implementer' }), ROLE_ENTRY);
  assert.deepEqual(implementer.config.plugins.map(p => p.id), [...BASE_PLUGINS, 'tool-pwsh', 'tool-jobs', 'role-policy']);
  const researcher = definitionRow(definitionWith({ template: 'researcher' }), ROLE_ENTRY);
  assert.deepEqual(researcher.config.plugins.map(p => p.id), [...BASE_PLUGINS, 'tool-web', 'role-policy']);
});

test('definitionRow rejects invalid definitions and stores the normalized one', () => {
  assert.throws(() => definitionRow(valid({ id: 'Bad Id' }), ROLE_ENTRY), /Invalid preset id/);
  assert.throws(() => definitionRow(valid({ template: 'ops' }), ROLE_ENTRY), /Invalid permission template/);
  assert.throws(() => definitionRow(null, ROLE_ENTRY), /Invalid preset definition/);
  const row = definitionRow(valid({ name: '  火车  ' }), ROLE_ENTRY);
  assert.equal(row.config.name, '火车');
  assert.deepEqual(row.config.plugins.find(p => p.name === ROLE_ENTRY).config.definition, { ...valid(), name: '火车', version: 1, order: 20 });
});

// ---------------------------------------------------------------- definitionsFrom

test('definitionsFrom round-trips rows this plugin wrote', () => {
  const defs = initialDefinitions();
  const rows = defs.map((d, i) => definitionRow({ ...d, template: TEMPLATE_NAMES[i % TEMPLATE_NAMES.length] }, ROLE_ENTRY));
  assert.deepEqual(definitionsFrom(rows), rows.map(row => row.config.plugins.at(-1).config.definition));
  assert.deepEqual(definitionsFrom([]), []);
});

test('definitionsFrom rejects foreign or damaged group rows', () => {
  const good = definitionRow(valid(), ROLE_ENTRY);
  assert.throws(() => definitionsFrom(undefined), /Managed preset group unavailable/);
  assert.throws(() => definitionsFrom(null), /Managed preset group unavailable/);
  assert.throws(() => definitionsFrom({}), /Managed preset group unavailable/);
  assert.throws(() => definitionsFrom('[]'), /Managed preset group unavailable/);

  const foreignName = safe(good);
  foreignName.name = '@deepseek-ai/dsh-agent-standard';
  assert.throws(() => definitionsFrom([foreignName]), /Unmanaged row in preset group/);

  const missingPolicy = safe(good);
  missingPolicy.config.plugins = missingPolicy.config.plugins.filter(p => p.id !== 'role-policy');
  assert.throws(() => definitionsFrom([missingPolicy]), /Unmanaged row in preset group/);

  const emptyPlugins = safe(good);
  emptyPlugins.config.plugins = [];
  assert.throws(() => definitionsFrom([emptyPlugins]), /Unmanaged row in preset group/);

  const noConfig = safe(good);
  delete noConfig.config;
  assert.throws(() => definitionsFrom([noConfig]), /Unmanaged row in preset group/);

  const noDefinition = safe(good);
  delete noDefinition.config.plugins.at(-1).config.definition;
  assert.throws(() => definitionsFrom([noDefinition]), /Unmanaged row in preset group/);

  const rowIdMismatch = safe(good);
  rowIdMismatch.id = 'preset-other';
  assert.throws(() => definitionsFrom([rowIdMismatch]), /Preset identity mismatch/);

  const configIdMismatch = safe(good);
  configIdMismatch.config.id = 'other';
  assert.throws(() => definitionsFrom([configIdMismatch]), /Preset identity mismatch/);

  const noRowId = safe(good);
  delete noRowId.id;
  assert.throws(() => definitionsFrom([noRowId]), /Preset identity mismatch/);

  const invalidDefinition = safe(good);
  invalidDefinition.config.plugins.at(-1).config.definition.template = 'ops';
  assert.throws(() => definitionsFrom([invalidDefinition]), /Invalid permission template/);

  assert.throws(() => definitionsFrom([safe(good), foreignName]), /Unmanaged row in preset group/, 'one foreign row must fail the whole group');
});

// ---------------------------------------------------------------- mutateDefinitions

test('mutateDefinitions rejects a stale revision before acting', () => {
  const rows = ownedRows();
  for (const action of ['create', 'update', 'copy', 'delete']) {
    assert.throws(() => mutate(rows, {
      action, id: 'alpha', revision: revisionOf(rows) + 'stale', definition: definitionWith({ id: 'alpha' }),
    }), /Preset configuration changed since it was read; reload/, `stale ${action} accepted`);
  }
  assert.throws(() => mutate(rows, { action: 'create', definition: definitionWith({ id: 'gamma' }) }), /changed since it was read/);
  assert.throws(() => mutate(rows, { action: 'create', revision: null, definition: definitionWith({ id: 'gamma' }) }), /changed since it was read/);
  assert.equal(mutate(rows, withRevision(rows, { action: 'delete', id: 'alpha' })).length, 1);
});

test('mutateDefinitions create rejects duplicate ids from the roster and the group', () => {
  const rows = ownedRows(['alpha', 'beta']);
  assert.throws(() => mutate(rows, withRevision(rows, { action: 'create', definition: definitionWith({ id: 'beta' }) })), /Preset id already exists/);
  assert.throws(() => mutate(rows, withRevision(rows, { action: 'create', definition: definitionWith({ id: 'standard' }) }), { roster: [{ id: 'standard' }] }), /Preset id already exists/);
  assert.throws(() => mutate(rows, withRevision(rows, { action: 'create', definition: definitionWith({ id: 'alpha' }) })), /Preset id already exists/);
  const created = mutate(rows, withRevision(rows, { action: 'create', definition: definitionWith({ id: 'gamma', version: 9, template: 'researcher' }) }, { roster: [{ id: 'standard' }] }));
  assert.equal(created.length, 3);
  assert.deepEqual(created.slice(0, 2), rows, 'existing rows changed');
  assert.equal(created[2].config.id, 'gamma');
  assert.equal(created[2].config.plugins.at(-1).config.definition.version, 1, 'created version must start at 1');
  assert.equal(created[2].config.plugins.at(-1).config.role, 'researcher');
  assert.equal(created[2].config.plugins.some(p => p.id === 'tool-web'), true);
  assert.deepEqual(created[2].config.plugins.at(-1).config.definition, validateDefinition(definitionsFrom([created[2]])[0]));
  assert.deepEqual(created[2].config.plugins.at(-1).config.definition, { ...definitionWith({ id: 'gamma' }), template: 'researcher', version: 1, order: 30 });
  assert.equal(created[2].config.order, 30, 'a new preset goes last among the owned ones');
});

test('mutateDefinitions update keeps the id, bumps the version and rebuilds the row', () => {
  const rows = ownedRows(['alpha', 'beta']);
  const before = revisionOf(rows);
  const next = mutate(rows, withRevision(rows, { action: 'update', id: 'alpha', definition: definitionWith({ id: 'alpha', name: '新的名字', template: 'verifier' }) }));
  assert.equal(revisionOf(rows), before, 'input rows mutated');
  assert.equal(next.length, 2);
  assert.deepEqual(next[1], rows[1], 'unrelated row changed');
  assert.equal(next[0].id, 'preset-alpha');
  assert.equal(next[0].config.name, '新的名字');
  assert.equal(next[0].config.plugins.at(-1).config.definition.version, 2);
  assert.deepEqual(next[0].config.plugins.at(-1).config.definition, { id: 'alpha', name: '新的名字', description: definitionWith({}).description, prompt: definitionWith({}).prompt, template: 'verifier', version: 2, order: 20 });
  assert.equal(revisionOf(next) === before, false);
  assert.throws(() => mutate(next, withRevision(rows, { action: 'update', id: 'alpha', definition: definitionWith({ id: 'alpha' }) })), /changed since it was read/, 'stale revision after update');
  const third = mutate(next, withRevision(next, { action: 'update', id: 'alpha', definition: definitionWith({ id: 'alpha' }) }));
  assert.equal(third[0].config.plugins.at(-1).config.definition.version, 3);
  assert.equal(third[0].config.plugins.at(-1).config.role, 'verifier');
  assert.equal(third[0].config.plugins.some(p => p.id === 'tool-pwsh'), true);
});

test('mutateDefinitions update rejects id changes, unknown or foreign targets', () => {
  const rows = ownedRows(['alpha', 'beta']);
  assert.throws(() => mutate(rows, withRevision(rows, { action: 'update', id: 'alpha', definition: definitionWith({ id: 'gamma' }) })), /Preset id is immutable/);
  assert.throws(() => mutate(rows, withRevision(rows, { action: 'update', id: 'gamma', definition: definitionWith({ id: 'gamma' }) })), /Preset id is immutable/);
  assert.throws(() => mutate(rows, withRevision(rows, { action: 'update', id: 'alpha', definition: definitionWith({ id: 'Bad Id' }) })), /Invalid preset id/);
  assert.throws(() => mutate(rows, withRevision(rows, { action: 'update', id: 'alpha', definition: definitionWith({ id: 'alpha', prompt: 'p'.repeat(MAX.prompt + 1) }) })), /Invalid prompt/);
  assert.deepEqual(mutate(rows, withRevision(rows, { action: 'update', id: 'beta', definition: definitionWith({ id: 'beta' }) })).length, 2);
});

test('mutateDefinitions copy creates a fresh version-1 preset under the new id', () => {
  const rows = ownedRows(['alpha']);
  const next = mutate(rows, withRevision(rows, { action: 'copy', id: 'alpha', definition: { id: 'alpha-copy', name: '副本' } }));
  assert.equal(next.length, 2);
  assert.deepEqual(next[0], rows[0], 'source row changed');
  assert.equal(next[1].id, 'preset-alpha-copy');
  assert.equal(next[1].config.name, '副本');
  const definition = next[1].config.plugins.at(-1).config.definition;
  assert.equal(definition.version, 1, 'copied preset must restart at version 1');
  assert.equal(definition.description, rows[0].config.plugins.at(-1).config.definition.description, 'unspecified fields must be inherited');
  assert.equal(definition.prompt, rows[0].config.plugins.at(-1).config.definition.prompt);
  assert.equal(definition.template, rows[0].config.plugins.at(-1).config.definition.template);
  assert.equal(rows[0].config.plugins.at(-1).config.definition.version, 1, 'source version must stay unchanged');
  assert.throws(() => mutate(rows, withRevision(rows, { action: 'copy', id: 'gamma', definition: { id: 'gamma-copy' } })), /Preset is not owned by this plugin/);
  assert.throws(() => mutate(rows, withRevision(rows, { action: 'copy', id: 'alpha', definition: { id: 'alpha' } })), /Preset id already exists/);
  assert.throws(() => mutate(rows, withRevision(rows, { action: 'copy', id: 'alpha', definition: { id: 'alpha-copy', template: 'ops' } })), /Invalid permission template/);
});

test('mutateDefinitions delete refuses the default preset and presets with active sessions', () => {
  const rows = ownedRows(['alpha', 'beta']);
  assert.throws(() => mutate(rows, withRevision(rows, { action: 'delete', id: 'alpha' }), { roster: [{ id: 'alpha', isDefault: true }] }), /Cannot delete default preset/);
  assert.throws(() => mutate(rows, withRevision(rows, { action: 'delete', id: 'alpha' }), { usage: ['alpha'] }), /active sessions/);
  assert.throws(() => mutate(rows, withRevision(rows, { action: 'delete', id: 'alpha' }), { roster: [{ id: 'alpha', isDefault: true }], usage: ['alpha'] }), /Cannot delete default preset/);
  assert.throws(() => mutate(rows, withRevision(rows, { action: 'delete', id: 'gamma' }), { roster: [{ id: 'alpha', isDefault: true }] }), /not owned by this plugin/);
  assert.throws(() => mutate(rows, withRevision(rows, { action: 'delete', id: 'standard' }), { roster: [{ id: 'standard', isDefault: true }], usage: ['standard'] }), /not owned by this plugin/);
});

test('mutateDefinitions delete removes only the target row and keeps the rest', () => {
  const rows = ownedRows(['alpha', 'beta', 'gamma']);
  const next = mutate(rows, withRevision(rows, { action: 'delete', id: 'beta' }));
  assert.deepEqual(next, [rows[0], rows[2]]);
  assert.deepEqual(next.map(r => r.config.id), ['alpha', 'gamma']);
  const none = mutate(rows, withRevision(rows, { action: 'delete', id: 'alpha' }));
  assert.deepEqual(none, [rows[1], rows[2]]);
  for (const row of none) assert.match(row.id, /^preset-/);
});

test('mutateDefinitions rejects unknown actions and unmanaged groups', () => {
  const rows = ownedRows(['alpha']);
  for (const action of ['rename', 'reset', '', 'DELETE', null, undefined]) {
    assert.throws(() => mutate(rows, withRevision(rows, { action, id: 'alpha', definition: definitionWith({ id: 'alpha' }) })), /Invalid action/, `accepted action ${String(action)}`);
  }
  assert.throws(() => mutate([{ id: 'preset-x', name: 'other', config: {} }], { action: 'delete', id: 'x', revision: revisionOf([{ id: 'preset-x', name: 'other', config: {} }]) }), /Unmanaged row in preset group/);
  assert.throws(() => mutate('nope', { action: 'delete', id: 'alpha', revision: 'x' }), /Managed preset group unavailable/);
});

test('moving a preset swaps roster positions and spreads tied positions first', () => {
  const rows = ownedRows(['alpha', 'beta']);
  assert.deepEqual(rows.map(row => row.config.order), [20, 20], 'rows written before order existed are tied');
  const next = mutate(rows, withRevision(rows, { action: 'move', id: 'beta', direction: 'up' }));
  assert.deepEqual(definitionsFrom(next).map(definition => definition.id), ['beta', 'alpha'], 'the page order follows the roster order');
  assert.deepEqual(next.map(row => row.config.order), [10, 20], 'tied positions are spread out so the move is visible');
  assert.deepEqual(definitionsFrom(next).map(definition => definition.order), [10, 20], 'the stored definition agrees with the row');
});

test('a later move permutes the existing positions instead of rewriting them', () => {
  const rows = ownedRows(['alpha', 'beta', 'gamma']).map((row, index) => ({ ...row, config: { ...row.config, order: (index + 1) * 10 } }));
  const next = mutate(rows, withRevision(rows, { action: 'move', id: 'gamma', direction: 'up' }));
  assert.deepEqual(definitionsFrom(next).map(definition => definition.id), ['alpha', 'gamma', 'beta']);
  assert.deepEqual(next.map(row => row.config.order), [10, 20, 30], 'the set of positions is preserved, only which row holds one changes');
});

test('a move at the edge is a no-op and an invalid move is refused', () => {
  const rows = ownedRows(['alpha', 'beta']);
  assert.equal(mutate(rows, withRevision(rows, { action: 'move', id: 'alpha', direction: 'up' })), rows, 'already first');
  assert.equal(mutate(rows, withRevision(rows, { action: 'move', id: 'beta', direction: 'down' })), rows, 'already last');
  assert.throws(() => mutate(rows, withRevision(rows, { action: 'move', id: 'ghost', direction: 'up' })), /not owned by this plugin/);
  assert.throws(() => mutate(rows, withRevision(rows, { action: 'move', id: 'alpha', direction: 'sideways' })), /Invalid move direction/);
});

test('a row without a position sorts last, exactly as the native registry does', () => {
  // The registry sorts `(a.order ?? Infinity) - (b.order ?? Infinity) || a.id.localeCompare(b.id)`,
  // so a row written before the field existed must not be reported at 20.
  const rows = ownedRows(['alpha', 'beta']);
  const legacy = { ...rows[1], config: { ...rows[1].config } };
  delete legacy.config.order;
  const mixed = [rows[0], legacy];
  assert.equal(orderOf(mixed[0]), 20);
  assert.equal(orderOf(mixed[1]), Infinity, 'a missing position sorts last');
  assert.equal(definitionsFrom(mixed)[1].order, undefined, 'and must not be reported as 20 to the page');

  // Editing it gives it a concrete position at the end instead of leaving it unpositioned.
  const updated = mutate(mixed, withRevision(mixed, { action: 'update', id: 'beta', definition: definitionWith({ id: 'beta' }) }));
  assert.equal(updated[1].config.order, 30, 'the highest concrete position (20) plus 10');

  // Moving spreads legacy positions once, keeping the order the user currently sees.
  const moved = mutate(mixed, withRevision(mixed, { action: 'move', id: 'beta', direction: 'up' }));
  assert.deepEqual(definitionsFrom(moved).map(definition => definition.id), ['beta', 'alpha']);
  assert.deepEqual(moved.map(row => row.config.order), [10, 20]);
});

test('editing or deleting a preset leaves the other roster positions alone', () => {
  const rows = ownedRows(['alpha', 'beta']);
  const updated = mutate(rows, withRevision(rows, { action: 'update', id: 'alpha', definition: definitionWith({ id: 'alpha' }) }));
  assert.deepEqual(updated.map(row => row.config.order), [20, 20], 'an edit must not move anything');
  const deleted = mutate(rows, withRevision(rows, { action: 'delete', id: 'alpha' }));
  assert.equal(deleted.length, 1);
  assert.equal(deleted[0].config.order, 20, 'a delete must not renumber the survivors');
});
