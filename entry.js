// Stable Host entry.
//
// The query string is a CONSTANT, not a version: Node caches ES modules by full
// specifier, and the bare `./host.js` URL was polluted by an early revision in
// long-running processes. A constant, never-before-used specifier loads the
// current file from disk exactly once per process.
//
// Consequence, by design: editing ANY Host module requires a DSH restart to take
// effect. Re-activating the bundle (disable/enable) only re-imports the Client
// half. Do not reintroduce per-change filenames or version query strings.
export { name, inject, Config, apply } from './host.js?stable';
