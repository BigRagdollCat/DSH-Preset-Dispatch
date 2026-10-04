// Runtime verification of the storage contract, against the packages the Host really provides.
//
// The type declarations say `tables` is a Record keyed by table name and that `defineDomain`
// validates the declaration. Reading types is not the same as the runtime accepting it, so this
// loads the real modules and checks both directions: the declaration this plugin builds is
// accepted, and an invalid one is refused (proving validation is live rather than a no-op).
//
// The packages live in the Host installation, not in this package, so they are located by
// search; when they cannot be found this reports SKIPPED and exits 0 rather than pretending.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DOMAIN_NAME, DOMAIN_VERSION, RUNS_TABLE, runRecord, runSchema } from '../history-store.js';

const ROOTS = [
  process.env.DSH_PACKAGES_ROOT,
  'G:/nodes/node_glabal/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai',
  'G:/nodes/node_glabal/node_modules/@deepseek-ai/dsh/node_modules',
  'G:/nodes/node_glabal/node_modules/@deepseek-ai',
].filter(Boolean);
const locate = (name, rels) => {
  for (const root of ROOTS) for (const rel of rels) { const file = join(root, name, rel); if (existsSync(file)) return file; }
  return null;
};
const domainFile = locate('dsh-storage-domain', ['lib/index.js']);
const zodFile = locate('zod', ['index.js', 'lib/index.js', 'v4/index.js']);
if (!domainFile || !zodFile) {
  console.log(`storage-contract: SKIPPED — Host packages not found (domain=${domainFile ?? 'missing'}, zod=${zodFile ?? 'missing'}); set DSH_PACKAGES_ROOT to enable`);
  process.exit(0);
}
const { defineDomain, domainTable } = await import(pathToFileURL(domainFile).href);
const zodModule = await import(pathToFileURL(zodFile).href);
const z = zodModule.z ?? zodModule.default?.z ?? zodModule.default;

const failures = [];
let spec = null;
try {
  spec = defineDomain({ name: DOMAIN_NAME, version: DOMAIN_VERSION, layout: 'per-record', invalidRecords: 'backup-and-skip', tables: { [RUNS_TABLE]: domainTable(runSchema(z)) } });
} catch (error) {
  failures.push(`the real defineDomain rejected the plugin declaration: ${String(error?.message ?? error)}`);
}
if (spec !== null && (typeof spec !== 'object' || spec.tables === undefined || !(RUNS_TABLE in spec.tables))) {
  failures.push('the accepted spec does not expose the runs table by name (tables must be a Record, not an array)');
}
// Validation must actually reject something, or the acceptance above proves nothing.
let refused = false;
try { defineDomain({ name: 'Bad Name', version: 1, tables: {} }); } catch { refused = true; }
if (!refused) failures.push('defineDomain accepted an invalid domain name, so its validation is not live');

const written = runRecord({ id: 'r', preset: 'p', startedAt: 's', status: 'running', reasoningEffort: null, policySnapshot: { preset: 'p' }, undeclared: 'dropped' });
const accepted = runSchema(z).safeParse(written);
if (!accepted.success) failures.push(`the durable schema rejects what runRecord writes: ${JSON.stringify(accepted.error?.issues?.[0] ?? accepted.error)}`);
const wrongType = runSchema(z).safeParse({ ...written, depth: 'not a number' });
if (wrongType.success) failures.push('the durable schema accepted a wrong field type, so it would store unusable records');

console.log(`\nstorage-contract: domain ${DOMAIN_NAME} v${DOMAIN_VERSION}, table ${RUNS_TABLE}, ${Object.keys(written).length} stored fields, real packages loaded`);
if (failures.length) { console.error(`\nFAILED (${failures.length}):\n  ${failures.join('\n  ')}`); process.exit(1); }
console.log('storage-contract: OK');
