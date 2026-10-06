import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));

// package.json is implicit. Lockfiles/dependencies and local bootstrap artifacts
// are deliberately not published; new runtime modules must be declared explicitly.
const LOCAL_ONLY = ['generate-roles.mjs', 'migration-snapshot.json', 'migration-role-snapshot.json'];
const EXEMPT = new Set(['package.json', 'package-lock.json', 'node_modules', ...LOCAL_ONLY]);

test('every package root file is declared in package.json files', () => {
  const declared = new Set(manifest.files);
  const entries = readdirSync(root, { withFileTypes: true })
    .filter(entry => !entry.name.startsWith('.') && !EXEMPT.has(entry.name))
    .map(entry => entry.name)
    .sort();
  const missing = entries.filter(name => !declared.has(name));
  assert.deepEqual(missing, [], 'undeclared package root entries: ' + missing.join(', '));
});

test('every path declared in files actually exists', () => {
  const absent = manifest.files.filter(name => !existsSync(fileURLToPath(new URL(name, root))));
  assert.deepEqual(absent, [], 'files entries that do not exist: ' + absent.join(', '));
});

test('the bundle patch points at the stable Host entry that exists', () => {
  const patch = readFileSync(new URL('cordis.patch.yml', root), 'utf8');
  assert.doesNotMatch(patch, /manager-entry-v\d+\.js/, 'per-change entry filenames must not come back');
  const host = JSON.parse(patch)[0].insert.find(row => row.id === 'local-preset-dispatch');
  assert.equal(host.name, './entry.js', 'the bundle must load the stable entry');
  assert.ok(existsSync(fileURLToPath(new URL('entry.js', root))), './entry.js must exist');
  const managedRole = '@local/dsh-preset-dispatch/managed-role';
  const roles = JSON.parse(patch)[0].insert.find(row => row.id === 'agent-managed-presets').config;
  assert.equal(roles.length, 7);
  for (const row of roles) {
    assert.equal(row.config.plugins.find(plugin => plugin.id === 'role-policy')?.name, managedRole,
      `${row.config.id} must use the package-exported role module`);
  }
  assert.equal(manifest.exports['./managed-role'], './role-managed.js');
  assert.ok(existsSync(fileURLToPath(new URL(manifest.exports['./managed-role'], root))));
  assert.match(readFileSync(new URL('management-api.js', root), 'utf8'), /const roleEntry = '@local\/dsh-preset-dispatch\/managed-role'/);
});

test('the Host module graph uses one constant cache-busting query', () => {
  for (const name of ['entry.js', 'host.js', 'core.js', 'management-api.js', 'settings-api.js']) {
    const source = readFileSync(new URL(name, root), 'utf8');
    assert.doesNotMatch(source, /manager-v\d+/, `${name} must not carry a version query`);
    for (const specifier of source.match(/from\s+'\.\/[^']+'/g) ?? []) {
      if (/\.js'/.test(specifier) && !specifier.includes('?stable')) {
        assert.fail(`${name} imports ${specifier} without the constant ?stable query`);
      }
    }
  }
});

test('local bootstrap artifacts are excluded from the package', () => {
  for (const name of LOCAL_ONLY) assert.ok(!manifest.files.includes(name), `${name} must remain local`);
});

test('public package entry shares the stable bundle entry', () => {
  assert.equal(manifest.exports['.'], './index.js');
  assert.equal(manifest.exports['./host'], './index.js');
  assert.match(readFileSync(new URL('index.js', root), 'utf8'), /from '\.\/entry\.js'/);
});

test('retired compatibility shims are really unreferenced', () => {
  // Documented in the README as retired: nothing may import them again, or the lifecycle
  // note would be a lie. `role-plugin.js` is deliberately absent from this list — it is a
  // public export target and must stay referenced.
  const RETIRED = ['settings-final.js', 'roles-active.js', 'roles-configured.js', 'roles-final.js', 'roles-live.js', 'roles-entry.js'];
  const sources = readdirSync(root).filter(name => name.endsWith('.js') && !RETIRED.includes(name)).map(name => [name, readFileSync(new URL(name, root), 'utf8')]);
  for (const shim of RETIRED) {
    const importers = sources.filter(([, source]) => source.includes(`'./${shim}'`) || source.includes(`"./${shim}"`)).map(([name]) => name);
    assert.deepEqual(importers, [], `${shim} is retired but still imported by ${importers.join(', ')}`);
  }
  // The public export targets must stay referenced, so retiring them would break consumers.
  assert.equal(manifest.exports['./role'], './role-plugin.js');
  assert.ok(existsSync(fileURLToPath(new URL('role-plugin.js', root))));
});

test('the bootstrap generator refuses to run without --force', () => {
  const source = readFileSync(new URL('generate-roles.mjs', root), 'utf8');
  assert.match(source, /--force/, 'the generator must require an explicit opt-in');
  assert.match(source, /name: '\.\/entry\.js'/, 'the generator must emit the stable entry name');
  assert.match(source, /definitionRow\(d, '@local\/dsh-preset-dispatch\/managed-role'\)/,
    'the generator must retain the resolvable managed-role module');
});
