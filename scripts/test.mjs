// Run every test file in ONE process.
//
// `node --test test/*.test.js` spawns a child per file with piped stdio, which the
// Windows sandbox in this workspace denies (spawn EPERM). Importing the files keeps
// the real node:test runner — and its exit code — while creating no child process,
// so the gate stays runnable wherever the plugin is developed.
import { readdirSync } from 'node:fs';

const dir = new URL('../test/', import.meta.url);
const files = readdirSync(dir).filter(name => name.endsWith('.test.js')).sort();
if (!files.length) { console.error('test: no test files found'); process.exit(1); }
for (const name of files) await import(new URL(name, dir).href);
