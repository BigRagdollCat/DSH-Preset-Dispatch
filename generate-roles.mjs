// Regenerates cordis.patch.yml from the migration snapshot.
//
// This is a BOOTSTRAP tool, not a maintenance tool: it rewrites the whole patch
// from migration-snapshot.json, so it discards every edit the user has made to
// presets and policies. Requiring --force makes that impossible to trigger by
// accident, and the entry name must stay in step with the bundle's Host row.
import { writeFile, readFile } from 'node:fs/promises';
import { initialDefinitions, definitionRow, GROUP_ID } from './managed-presets.js';

if (!process.argv.includes('--force')) {
  console.error([
    'generate-roles.mjs 会用 migration-snapshot.json 覆盖 cordis.patch.yml，',
    '从而丢弃用户对预设与派遣策略的所有修改。',
    '这是引导工具，不是维护工具。确实要重置请显式运行：',
    '  node generate-roles.mjs --force',
  ].join('\n'));
  process.exit(1);
}

const definitions = initialDefinitions();
const snapshot = JSON.parse(await readFile(new URL('./migration-snapshot.json', import.meta.url), 'utf8'));
const rows = [
  { id: GROUP_ID, name: 'cordis:group', group: true, config: definitions.map(d => definitionRow(d, new URL('./role-managed.js', import.meta.url).href)) },
  { id: 'local-preset-dispatch', name: './entry.js', config: { allowedPresets: [], maxDepth: snapshot.config.maxDepth, allowModelSelection: true, presetPolicies: snapshot.config.presetPolicies } },
];
await writeFile(new URL('./cordis.patch.yml', import.meta.url), JSON.stringify([{ insert: rows }], null, 2) + '\n');
console.error('cordis.patch.yml 已按迁移快照重置；Host 改动需要重启 DSH 才会生效。');
