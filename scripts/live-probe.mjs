// Post-restart probe: decide whether the NEW Host code is actually live.
//
// Restarting is the only way to reload Host modules, and afterwards "did it work?" is easy to
// answer by eye and easy to answer wrongly. These route probes answer it mechanically: a route
// that exists rejects an unauthenticated call with a specific 400, while an unknown path is
// answered 401 by the host router. Routes added in 0.6.0 therefore tell the two apart.
//
// Run before the restart to see the "not loaded" verdict, and after it to see "loaded".
const BASE = process.env.DSH_GUI ?? 'http://127.0.0.1:3080';
const GATE = 'Authenticated operator request required';
const ROUTES = [
  ['/api/preset-dispatch/history/query', 'added in 0.6.0 (history query)', true],
  ['/api/preset-dispatch/catalog/refresh', 'added in 0.6.0 (catalog refresh)', true],
  ['/api/preset-dispatch/agent-save', 'unified save endpoint', false],
  ['/api/preset-dispatch/presets/save', 'retired legacy endpoint', false],
];

let decisive = null;
for (const [route, what, isNew] of ROUTES) {
  let status = 0, body = '';
  try {
    const res = await fetch(BASE + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    status = res.status;
    body = (await res.text()).slice(0, 160).replace(/\s+/g, ' ');
  } catch (error) {
    console.log(`  unreachable   ${route}  (${error?.message ?? error})`);
    continue;
  }
  const registered = status === 400 && body.includes(GATE);
  console.log(`  ${registered ? 'registered  ' : 'NOT registered'} ${String(status).padEnd(4)} ${route}  (${what})`);
  if (isNew) decisive = decisive === null ? registered : decisive && registered;
}

console.log('');
if (decisive === true) console.log('verdict: the 0.6.0 Host code IS live (a route that only exists in 0.6.0 answered).');
else if (decisive === false) console.log('verdict: the 0.6.0 Host code is NOT live yet — restart DSH, then run this again.');
else console.log('verdict: inconclusive — the GUI was unreachable at ' + BASE + '.');
console.log('note: 400 with "' + GATE + '" means the route exists; 401 means the path is unknown.');
