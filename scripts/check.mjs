// Zero-dependency pre-flight for this package.
//
//   node scripts/check.mjs           verify everything, exit non-zero on any problem
//   node scripts/check.mjs --write   also rewrite the MAINTENANCE.md freeze table in place
//
// Three failure modes this exists to prevent, all hit for real during development:
//   1. a file that is not syntax-checked rots (historical modules were never covered)
//   2. the MAINTENANCE.md hash table drifts from the files it claims to identify
//   3. the table silently stops covering new files, because a curated list cannot notice
//      what nobody added to it
// spawnSync uses stdio 'inherit' on purpose: this environment denies a child's piped
// stdio, and `node --check` output is only useful printed straight through.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const pathOf = name => fileURLToPath(new URL(name, root));
const failures = [];
const write = process.argv.includes('--write');

const checkFile = file => {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.status !== 0) failures.push(`syntax: ${file}`);
  return result.status === 0;
};

// Every module in the package, including historical ones, so none can silently rot.
function listModules(directory = '') {
  return readdirSync(new URL(directory || './', root), { withFileTypes: true })
    .filter(entry => !entry.name.startsWith('.') && entry.name !== 'node_modules')
    .flatMap(entry => {
      const name = directory + entry.name;
      return entry.isDirectory() ? listModules(name + '/') : /\.(?:js|mjs|cjs)$/.test(name) ? [name] : [];
    }).sort();
}
let checked = 0;
for (const name of listModules()) if (checkFile(pathOf(name))) checked++;

// The freeze table must identify the current bytes AND cover everything shipped.
// The freeze table lives with the maintenance notes; README.md is the public document.
const readme = pathOf('MAINTENANCE.md');
const table = /^\|\s*((?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9._-]+)\s*\|\s*`([0-9a-f]{16})`\s*\|$/;
const hashOf = name => createHash('sha256').update(readFileSync(pathOf(name))).digest('hex').slice(0, 16);
const lines = readFileSync(readme, 'utf8').split('\n');
const listed = new Set();
let rows = 0;
const drifted = [];
const next = lines.map(line => {
  const match = table.exec(line.trim());
  if (!match) return line;
  const [, name, claimed] = match;
  listed.add(name);
  let actual;
  try { statSync(pathOf(name)); actual = hashOf(name); } catch { failures.push(`freeze table names a missing file: ${name}`); return line; }
  rows++;
  if (actual !== claimed) drifted.push({ name, claimed, actual });
  return write ? line.replace(claimed, actual) : line;
});
if (!rows) failures.push('freeze table not found in MAINTENANCE.md');

// A curated table cannot notice a file nobody added to it, so completeness is enforced
// here: every module in the package and every test file must be frozen.
const EXEMPT = new Set(['package-lock.json']);
const required = [
  ...readdirSync(root).filter(name => !name.startsWith('.') && /\.(js|mjs|cjs|yml|json)$/.test(name) && !EXEMPT.has(name)),
  ...readdirSync(new URL('test/', root)).filter(name => name.endsWith('.test.js')).map(name => 'test/' + name),
  ...readdirSync(new URL('scripts/', root)).filter(name => /\.(js|mjs|cjs)$/.test(name)).map(name => 'scripts/' + name),
].sort();
const missing = required.filter(name => !listed.has(name));

// A hand-written test count drifts silently, so any count the README states next to a test
// file must match that file. (This drifted three times during development.)
const countMentions = [...readFileSync(readme, 'utf8').matchAll(/`test\/([A-Za-z0-9._-]+\.test\.js)`（(\d+) 项）/g)];
for (const [, file, claimed] of countMentions) {
  const actual = (readFileSync(pathOf(`test/${file}`), 'utf8').match(/^test\(/gm) ?? []).length;
  if (Number(claimed) !== actual) failures.push(`MAINTENANCE.md says test/${file} has ${claimed} tests, it has ${actual}`);
}

if (write) {
  const additions = missing.map(name => `| ${name} | \`${hashOf(name)}\` |`);
  const lastRow = next.reduce((at, line, index) => (table.test(line.trim()) ? index : at), -1);
  if (additions.length) next.splice(lastRow + 1, 0, ...additions);
  if (additions.length || drifted.length) writeFileSync(readme, next.join('\n'));
  if (drifted.length) console.log(`freeze hashes updated:\n  ${drifted.map(item => `${item.name}: ${item.claimed} -> ${item.actual}`).join('\n  ')}`);
  if (additions.length) console.log(`freeze rows added:\n  ${missing.join('\n  ')}`);
} else {
  for (const item of drifted) failures.push(`freeze hash drift — ${item.name}: ${item.claimed} -> ${item.actual}`);
  if (missing.length) failures.push(`freeze table is missing ${missing.length} file(s): ${missing.join(', ')}`);
}

console.log(`\ncheck: ${checked} modules syntax-checked, ${rows} freeze rows ${write ? 'synced' : 'verified'}, ${required.length} files required to be frozen`);
if (failures.length) { console.error(`\nFAILED (${failures.length}):\n  ${failures.join('\n  ')}`); process.exit(1); }
console.log('check: OK');
