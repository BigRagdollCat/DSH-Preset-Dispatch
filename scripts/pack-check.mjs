// Verify the ACTUAL published tarball, not just the manifest that claims what it holds.
//
// npm runs with its cache and scratch space inside the workspace, because this sandbox
// denies writes outside it, and with `--dry-run` so nothing is published and no tarball is
// left behind. The captured file list is what a consumer would really receive.
//
// stdio uses an open file descriptor rather than a pipe: this environment denies a child's
// piped stdio, and npm's JSON report is exactly what needs capturing.
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const scratch = join(root, '.tmp', 'pack');
const report = join(scratch, 'report.json');
const cache = join(scratch, 'cache');

const cli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
const command = existsSync(cli) ? process.execPath : 'npm';
const args = existsSync(cli) ? [cli, 'pack', '--dry-run', '--json', '--ignore-scripts', '--cache', cache] : ['pack', '--dry-run', '--json', '--ignore-scripts', '--cache', cache];

rmSync(scratch, { recursive: true, force: true });
mkdirSync(scratch, { recursive: true });
const fd = openSync(report, 'w');
const result = spawnSync(command, args, { cwd: root, stdio: ['ignore', fd, 'inherit'] });
closeSync(fd);

const failures = [];
if (result.status !== 0) failures.push(`npm pack --dry-run exited ${result.status}`);
let parsed = null;
try { parsed = JSON.parse(readFileSync(report, 'utf8')); } catch (error) { failures.push('npm pack did not produce parseable JSON: ' + String(error?.message ?? error)); }
const entry = Array.isArray(parsed) ? parsed[0] : parsed;
const files = (entry?.files ?? []).map(file => String(file.path).replace(/\\/g, '/'));
if (!files.length && !failures.length) failures.push('npm pack reported no files');

// What a consumer must receive: the bundle entry, the Host modules a published copy needs,
// the client half, the patch that declares the rows, and the gate scripts themselves.
const REQUIRED = ['entry.js', 'client.js', 'host.js', 'core.js', 'settings-api.js', 'save-protocol.js', 'history-store.js', 'catalog-cache.js', 'cordis.patch.yml', 'package.json', 'README.md', 'scripts/check.mjs', 'scripts/test.mjs', 'scripts/pack-check.mjs', 'scripts/live-probe.mjs', 'scripts/storage-contract-check.mjs'];
// What must never be published: machine-local bootstrap data, scratch space, dependencies.
const FORBIDDEN = ['generate-roles.mjs', 'migration-snapshot.json', 'migration-role-snapshot.json'];
for (const name of REQUIRED) if (!files.includes(name)) failures.push(`published tarball is missing ${name}`);
for (const name of FORBIDDEN) if (files.includes(name)) failures.push(`published tarball must not contain ${name}`);
for (const path of files) {
  if (path.startsWith('.tmp/') || path.startsWith('node_modules/') || path.startsWith('.')) failures.push(`published tarball must not contain ${path}`);
}
if (Number.isSafeInteger(entry?.entryCount) && entry.entryCount !== files.length) failures.push(`entryCount ${entry.entryCount} disagrees with the ${files.length} listed files`);

// A dry run must not leave a tarball behind in the source tree.
const strays = readdirSync(root).filter(name => name.endsWith('.tgz'));
if (strays.length) failures.push(`a dry run left a tarball behind: ${strays.join(', ')}`);

try { unlinkSync(report); } catch { /* scratch is removed below anyway */ }
rmSync(scratch, { recursive: true, force: true });

console.log(`\npack: ${files.length} files would be published (${entry?.unpackedSize ?? '?'} bytes unpacked)`);
if (failures.length) { console.error(`\nFAILED (${failures.length}):\n  ${failures.join('\n  ')}`); process.exit(1); }
console.log('pack: OK');
