/**
 * hermes-turns.test.ts — the turn-lease harvester (owner ask 2026-10-21):
 * "is a Hermes session running a tool RIGHT NOW?" — the durable
 * session_turn_leases read, fail-quiet on every plane.
 *
 * Suites:
 *   1. pure pieces: holder-string reduction, the held-map law (TTL, dead
 *      holder pid, malformed rows drop individually, dedupe by later
 *      expiry, cap), the DB-discovery scan;
 *   2. the harvester against an INJECTED read seam: the tri-state
 *      factFor (undefined before any successful read / null for a read
 *      that named no live row / object when held), the fail-quiet map
 *      stand, the stale-horizon self-retirement, the poll throttle;
 *   3. the REAL sqlite path: temp state.db files (shared + a profile)
 *      written with node:sqlite carry a live lease through poll() —
 *      read-only by construction, and a removed row flips to the CLEAR.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HermesTurns,
  heldTurnFacts,
  parseHermesHolder,
  hermesLeaseDbs,
  type HermesLeaseRow,
} from '../src/hermes-turns.js';

const cleanup: Array<() => void> = [];
process.on('exit', () => {
  for (const fn of cleanup) {
    try {
      fn();
    } catch {
      /* best effort */
    }
  }
});

function tmpHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'idlefill-turns-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// ---------------------------------------------------------------------------
// 1. pure pieces
// ---------------------------------------------------------------------------

test('holder reduction: the two named members, exact; everything else absent', () => {
  assert.deepEqual(
    parseHermesHolder('pid=33339:turn=20261020_093401_a9da60:20261020_093401_a9da60:29598cb9:platform=tui'),
    { pid: 33339, platform: 'tui' },
  );
  assert.deepEqual(parseHermesHolder('pid=7:whatever'), { pid: 7 });
  assert.deepEqual(parseHermesHolder('platform=desktop'), { platform: 'desktop' });
  assert.deepEqual(parseHermesHolder(''), {}, 'an unparseable holder says nothing, never a guess');
  // Bounds: out-of-range pid drops the member only; oversized platform too.
  assert.deepEqual(parseHermesHolder('pid=99999999999:x'), {});
  assert.deepEqual(parseHermesHolder('platform=' + 'z'.repeat(33)), {});
});

test('held map: TTL, dead holder, malformed rows drop individually; dedupe by later expiry', () => {
  const nowMs = 1_760_000_000_000;
  const nowSec = nowMs / 1000;
  const rows: HermesLeaseRow[] = [
    { conversation_id: 'good', holder: 'pid=100:platform=tui', expires_at: nowSec + 200 }, // held (pid alive)
    { conversation_id: 'expired', holder: 'pid=100', expires_at: nowSec - 1 }, // TTL passed
    { conversation_id: 'dead', holder: 'pid=660:platform=desktop', expires_at: nowSec + 200 }, // holder dead
    { conversation_id: 'x'.repeat(200), holder: 'pid=100', expires_at: nowSec + 200 }, // oversized id
    { conversation_id: 'bad exp', holder: 'pid=100', expires_at: 'soon' }, // non-number
    { conversation_id: 'dup', holder: 'pid=100', expires_at: nowSec + 50 },
    { conversation_id: 'dup', holder: 'pid=100:platform=cron', expires_at: nowSec + 300 }, // wins
    { conversation_id: 'no-pid', holder: 'token=abc', expires_at: nowSec + 200 }, // TTL-only hold
  ];
  const pidAlive = (pid: number) => pid === 100;
  const m = heldTurnFacts(rows, nowMs, pidAlive);
  assert.deepEqual([...m.keys()].sort(), ['dup', 'good', 'no-pid']);
  assert.deepEqual(m.get('good'), { at: nowMs, platform: 'tui', pid: 100 });
  assert.equal(m.get('dup')?.platform, 'cron', 'the later-expiring row wins');
  assert.equal(m.get('no-pid')?.pid, undefined, 'a holder with no pid rides on TTL alone');
  assert.equal(m.get('expired'), undefined);
  assert.equal(m.get('dead'), undefined, 'a dead holder pid is NOT held — the TTL row is residue');
  // Cap: a pathological table bounds the publish.
  const many = Array.from({ length: 600 }, (_, i) => ({
    conversation_id: `id-${i}`,
    holder: 'pid=100',
    expires_at: nowSec + 200,
  }));
  assert.equal(heldTurnFacts(many, nowMs, pidAlive).size, 512);
});

test('DB discovery: shared + profile state.dbs only, existing files only', () => {
  const home = tmpHome();
  assert.deepEqual(hermesLeaseDbs(home), [], 'no DBs → no reads → nothing to report');
  mkdirSync(join(home, 'profiles', 'p1'), { recursive: true });
  mkdirSync(join(home, 'profiles', 'p2'), { recursive: true });
  mkdirSync(join(home, 'profiles', 'notdb'), { recursive: true });
  writeLeaseDb(join(home, 'state.db'), []);
  writeLeaseDb(join(home, 'profiles', 'p1', 'state.db'), []);
  const dbs = hermesLeaseDbs(home);
  assert.deepEqual(dbs, [join(home, 'state.db'), join(home, 'profiles', 'p1', 'state.db')]);
});

// ---------------------------------------------------------------------------
// 2. the harvester against an injected read seam
// ---------------------------------------------------------------------------

function fakeRead(rows: () => HermesLeaseRow[] | undefined) {
  const calls: string[] = [];
  return {
    calls,
    read: (dbPath: string) => {
      calls.push(dbPath);
      return rows();
    },
  };
}

function withHome(fn: (home: string) => void): void {
  const home = tmpHome();
  mkdirSync(join(home, 'profiles', 'p1'), { recursive: true });
  writeLeaseDb(join(home, 'state.db'), []); // real file so discovery names it
  fn(home);
}

test('tri-state: no read ever ⇒ key stays absent; a read ⇒ held fact or the explicit CLEAR', async () => {
  const clock = { t: 1_000_000 };
  const rows: { v: HermesLeaseRow[] | undefined } = { v: undefined };
  const fr = fakeRead(() => rows.v);
  withHome((home) => {
    const h = new HermesTurns(home, {
      now: () => clock.t,
      pidAlive: () => true,
      readLeases: fr.read,
      pollMs: 100,
    });
    // Before any successful read the harvester CANNOT speak (ADD-key posture).
    assert.equal(h.available(), false);
    assert.equal(h.factFor('s1'), undefined, 'no read ever ⇒ the register body omits the key');
    assert.equal(h.isHeld('s1'), false);

    rows.v = [{ conversation_id: 's1', holder: 'pid=100:platform=tui', expires_at: clock.t / 1000 + 200 }];
    void h.poll();
    assert.equal(h.available(), true);
    assert.deepEqual(h.factFor('s1'), { at: clock.t, platform: 'tui', pid: 100 });
    assert.equal(h.factFor('other'), null, 'a successful read that named NO row ⇒ the explicit CLEAR');
    assert.equal(h.factFor(undefined), undefined, 'a session with no captured id joins on nothing');
    assert.equal(h.isHeld('s1'), true);
  });
});

test('fail-quiet: a failed round keeps the last map standing; stalled facts self-retire', async () => {
  const clock = { t: 1_000_000 };
  const rows: { v: HermesLeaseRow[] | undefined } = {
    v: [{ conversation_id: 's1', holder: 'pid=100', expires_at: 1e12 }],
  };
  const fr = fakeRead(() => rows.v);
  withHome((home) => {
    const h = new HermesTurns(home, { now: () => clock.t, pidAlive: () => true, readLeases: fr.read, pollMs: 100, staleAfterMs: 90_000 });
    void h.poll();
    assert.equal(h.isHeld('s1'), true);

    // Every read fails: the last map stands (fail-quiet), until the facts
    // age past the stale horizon — then they CLEAR (a live-state surface
    // never keeps claiming "working" on a dead observation).
    rows.v = undefined;
    clock.t += 10_000;
    void h.poll();
    assert.equal(h.isHeld('s1'), true, 'a failed round keeps the last-known held fact');
    clock.t += 200_000;
    assert.equal(h.isHeld('s1'), false, 'a fact past the stale horizon is a dead observation ⇒ null');
    assert.equal(h.factFor('s1'), null, 'stale ⇒ the CLEAR rides, not the omission');
  });
});

test('poll throttle: rounds inside pollMs are no-ops', async () => {
  const clock = { t: 1_000_000 };
  const fr = fakeRead(() => []);
  withHome((home) => {
    const h = new HermesTurns(home, { now: () => clock.t, readLeases: fr.read, pollMs: 5_000 });
    void h.poll();
    const n = fr.calls.length;
    clock.t += 1_000;
    void h.poll();
    assert.equal(fr.calls.length, n, 'a second round inside the throttle window does not re-read');
    clock.t += 5_000;
    void h.poll();
    assert.ok(fr.calls.length > n, 'past the throttle window the round runs again');
  });
});

// ---------------------------------------------------------------------------
// 3. the REAL sqlite path (node:sqlite, read-only)
// ---------------------------------------------------------------------------

function writeLeaseDb(dbPath: string, rows: Array<{ conversation_id: string; holder: string; expires_at: number }>): void {
  const req = createRequire(import.meta.url);
  const { DatabaseSync } = req('node:sqlite') as typeof import('node:sqlite');
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec(
      `CREATE TABLE IF NOT EXISTS session_turn_leases (
         conversation_id TEXT PRIMARY KEY,
         holder TEXT NOT NULL,
         acquired_at REAL NOT NULL,
         expires_at REAL NOT NULL
       )`,
    );
    db.exec('DELETE FROM session_turn_leases');
    const ins = db.prepare('INSERT INTO session_turn_leases (conversation_id, holder, acquired_at, expires_at) VALUES (?, ?, ?, ?)');
    for (const r of rows) ins.run(r.conversation_id, r.holder, Date.now() / 1000, r.expires_at);
  } finally {
    db.close();
  }
}

test('real sqlite: a shared-DB and a profile-DB lease both harvest; removal flips to the CLEAR; the store is never written', async () => {
  const home = tmpHome();
  mkdirSync(join(home, 'profiles', 'web-dev'), { recursive: true });
  const exp = Date.now() / 1000 + 240;
  writeLeaseDb(join(home, 'state.db'), [
    { conversation_id: '20261020_tui', holder: `pid=${process.pid}:turn=x:y:z:platform=tui`, expires_at: exp },
  ]);
  writeLeaseDb(join(home, 'profiles', 'web-dev', 'state.db'), [
    { conversation_id: '20261020_webdev', holder: `pid=${process.pid}:platform=desktop`, expires_at: exp },
  ]);

  const h = new HermesTurns(home, { pollMs: 50 });
  await h.poll();
  assert.equal(h.available(), true);
  assert.equal(h.factFor('20261020_tui')?.platform, 'tui');
  assert.equal(h.factFor('20261020_webdev')?.platform, 'desktop', 'the profile DB contributes its own rows');
  assert.equal(h.factFor('absent'), null);
  assert.equal(h.isHeld('20261020_tui'), true);

  // TTL expiry is read honestly: an expired row is simply not held.
  writeLeaseDb(join(home, 'state.db'), [{ conversation_id: '20261020_tui', holder: 'pid=1', expires_at: Date.now() / 1000 - 1 }]);
  await new Promise((r) => setTimeout(r, 60)); // past the poll throttle
  await h.poll();
  assert.equal(h.factFor('20261020_tui'), null, 'a released/expired lease rides the CLEAR');
  assert.equal(h.factFor('20261020_webdev')?.platform, 'desktop', 'the other DB still speaks');

  // Read-only by construction: the harvester opened these stores and the
  // lease table still holds exactly what was written.
  const req = createRequire(import.meta.url);
  const { DatabaseSync } = req('node:sqlite') as typeof import('node:sqlite');
  const check = new DatabaseSync(join(home, 'profiles', 'web-dev', 'state.db'));
  try {
    const left = check.prepare('SELECT count(*) AS n FROM session_turn_leases').get() as { n: number };
    assert.equal(left.n, 1);
  } finally {
    check.close();
  }
});
