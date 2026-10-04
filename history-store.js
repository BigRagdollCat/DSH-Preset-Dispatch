// Durable port for the metadata-only dispatch history.
//
// The storage packages are injected rather than imported, so they never become a
// load-time dependency of this plugin: without them the history stays in memory, and a
// failing medium is reported instead of being allowed to break dispatch.
// The medium enforces /^[a-z][a-z0-9_]*$/ on domain names at runtime — hyphens are refused
// (`defineDomain` throws "domain name ... must match"), which would leave history silently
// in-memory. Verified against the real package by scripts/storage-contract-check.mjs.
export const DOMAIN_NAME = 'preset_dispatch_history';
export const DOMAIN_VERSION = 1;
export const RUNS_TABLE = 'runs';

/**
 * Exactly the fields a durable record may carry. Applied before every write, so the
 * stored document is plain data with no surprises for the domain schema and no field
 * can appear later without being declared here deliberately.
 */
export const RUN_FIELDS = ['id', 'preset', 'role', 'provider', 'model', 'depth', 'parentSession', 'reasoningEffort', 'modelSource', 'effortSource', 'presetVersion', 'policySnapshot', 'startedAt', 'finishedAt', 'status', 'childSessionId'];

export const runRecord = row => Object.fromEntries(RUN_FIELDS.filter(key => row[key] !== undefined).map(key => [key, JSON.parse(JSON.stringify(row[key]))]));

/**
 * Field → zod type factory, kept beside RUN_FIELDS on purpose: the durable schema and the
 * writer must describe the same fields, and a test asserts exactly that, so a field cannot
 * be written without being declared (or declared without ever being written).
 */
export const RUN_FIELD_TYPES = {
  id: z => z.string(), preset: z => z.string(), startedAt: z => z.string(), status: z => z.string(),
  role: z => z.string().optional(), provider: z => z.string().optional(), model: z => z.string().optional(),
  depth: z => z.number().optional(), parentSession: z => z.string().optional(),
  reasoningEffort: z => z.string().nullable().optional(), modelSource: z => z.string().optional(),
  effortSource: z => z.string().optional(), presetVersion: z => z.number().nullable().optional(),
  policySnapshot: z => z.unknown().nullable().optional(), finishedAt: z => z.string().optional(),
  childSessionId: z => z.string().optional(),
};

/** The record schema, built from the declared fields with the Host's own zod. */
export const runSchema = z => z.object(Object.fromEntries(Object.entries(RUN_FIELD_TYPES).map(([name, type]) => [name, type(z)])));

/**
 * Build the persistence port from the storage packages' own helpers.
 *
 * `defineDomain` validates the declaration loudly (name, version, table names), so a
 * misconfiguration surfaces here, at activation, instead of silently losing records.
 */
export function createHistoryStore({ defineDomain, domainTable, schema }) {
  let domain = null;
  const spec = defineDomain({
    name: DOMAIN_NAME,
    version: DOMAIN_VERSION,
    // One document per run: records are small, independent and individually disposable.
    layout: 'per-record',
    // History is derived data. A record that no longer matches the schema is moved aside
    // by the backend instead of making the whole history unreadable.
    invalidRecords: 'backup-and-skip',
    tables: { [RUNS_TABLE]: domainTable(schema) },
  });
  const table = () => {
    if (!domain) throw new Error('history storage is not open');
    return domain.table(RUNS_TABLE);
  };
  return {
    spec,
    async open(facility) { domain = await facility.open(spec); },
    async close() { if (domain) { const held = domain; domain = null; await held.close(); } },
    // A record without an address cannot be looked up, corrected or deleted again, so it is
    // not loaded. This also makes leftovers from the pre-id bug (stored under "undefined")
    // inert instead of showing up as a bogus history entry.
    async load() { return [...table().entries()].filter(([, value]) => typeof value?.id === 'string' && value.id !== '').map(([, value]) => value); },
    async put(row) { await table().put(row.id, runRecord(row)); },
    async remove(id) { await table().delete(id); },
    async clear() { const runs = table(); for (const key of [...runs.keys()]) await runs.delete(key); },
  };
}
