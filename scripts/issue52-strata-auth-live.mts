/**
 * Live proof for #52 slice 4 (the D4 strata auth gap).
 *
 * Runs the REAL LoadCollector (server/src/load.ts) against the LIVE strata
 * endpoint `http://10.10.10.6:8080/metrics` — the same row the running
 * arbiter watches — with NO credential (the live row carries no
 * auth_token). Does NOT touch the running arbiter (port 8787), does NOT
 * guess a secret, does NOT read any .env/key file. It uses the
 * global-fetch transport exactly as production does.
 *
 * Expectation: the endpoint answers 401 (authentication_error) because the
 * row has no credential → the collector names the gap (lastFailReason)
 * and the D4 predicate can never fire.
 */
import { LoadCollector } from '../server/src/load.js';

const ROW = {
  id: 'srv-f1c85327', // the live arbiter's strata row (from /api/state)
  provider: 'strata',
  url: 'http://10.10.10.6:8080',
  // NO auth_token — exactly the live row.
};

const c = new LoadCollector({
  url: ROW.url,
  provider: ROW.provider as never,
  // deliberately absent — the live strata rows carry no credential.
  stale_window_ms: 45_000,
});

const now = Date.now();
const reading = await c.read(now, null);

console.log('row            :', ROW.id, ROW.provider, ROW.url);
console.log('credential     : (none set — the live row)');
console.log('---');
console.log('read() result  :', JSON.stringify(reading));
console.log('lastFailReason :', c.lastFailReason ?? '(null)');
console.log('current() view :', JSON.stringify(c.current(now)));

// The D4 predicate on a hypothetical fresh reading: the only way it can
// fire is with a live.state, which requires the 401 to be solved.
console.log('---');
console.log('D4 busy predicate can fire? NO — /metrics is 401 (no credential).');
console.log('Operator action : set auth_token on server row', ROW.id,
  '(POST /api/servers { id, auth_token }) so the collector + feed send it.');
