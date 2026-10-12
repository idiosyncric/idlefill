/**
 * Pure-helper tests for `idlefill mesh` (cli.md D5, issue #91 S4): the
 * argv table, the probe-then-write decision table (unreachable / refused
 * token / wrong shape — every refusal names its reason and mutates
 * NOTHING), the mesh_peers upsert (add / dedupe / rename / remove), THE
 * NAMING TRAP (mesh_peers vs server_peers — the upsert never touches
 * server_peers or any other key), the timestamped-backup + atomic-rename
 * write posture on a real temp file, and the offline-row wording (the
 * dashboard's fetch-honesty axis, never fake progress).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  backupPathFor,
  explainPairError,
  normalizePeerUrl,
  parseMeshArgs,
  parseServerConfig,
  peerStatusLine,
  probeOutcome,
  probeRefusalText,
  PEER_STALE_S,
  removeMeshPeer,
  renderPeerRows,
  upsertMeshPeer,
  writeConfigAtomicWithBackup,
  type PeerViewRow,
} from '../src/mesh.js';

// ---------------------------------------------------------------------------
// argv
// ---------------------------------------------------------------------------

const ok = (argv: string[]) => {
  const p = parseMeshArgs(argv);
  assert.ok(p.ok, p.ok ? '' : p.error);
  return p as Extract<typeof p, { ok: true }>;
};

test('bare group token means status', () => {
  const p = ok([]);
  assert.equal(p.cmd, 'status');
});

test('the four subcommands parse; join carries --name', () => {
  assert.equal(ok(['status']).cmd, 'status');
  assert.equal(ok(['pair']).cmd, 'pair');
  assert.equal(ok(['pair', '9f3a…']).cmd, 'pair');
  const j = ok(['join', 'http://100.105.225.1:8787', '--name', 'urza']);
  assert.equal(j.cmd, 'join');
  assert.deepEqual(j.positional, ['http://100.105.225.1:8787']);
  assert.equal(j.flags.name, 'urza');
  const l = ok(['leave', 'urza']);
  assert.deepEqual(l.positional, ['urza']);
});

test('every usage mistake is named with the usage line', () => {
  assert.ok(!parseMeshArgs(['frobnicate']).ok);
  assert.ok(!parseMeshArgs(['status', 'extra']).ok);
  assert.ok(!parseMeshArgs(['join']).ok);
  assert.ok(!parseMeshArgs(['leave', 'a', 'b']).ok);
  assert.ok(!parseMeshArgs(['pair', 'c1', 'c2']).ok);
  assert.ok(!parseMeshArgs(['join', 'http://x:1', '--name']).ok);
  assert.ok(!parseMeshArgs(['join', 'http://x:1', '--bogus']).ok);
  assert.ok(!parseMeshArgs(['leave', 'urza', '--name', 'x']).ok, '--name is join-only');
});

// ---------------------------------------------------------------------------
// URL normalization
// ---------------------------------------------------------------------------

test('peer urls: trimmed, trailing slashes stripped; self/garbage/non-http refused', () => {
  assert.equal(normalizePeerUrl('http://100.1.2.3:8787///'), 'http://100.1.2.3:8787');
  assert.equal(normalizePeerUrl('  https://box.tailnet.ts.net  '), 'https://box.tailnet.ts.net');
  assert.equal(normalizePeerUrl('self'), null);
  assert.equal(normalizePeerUrl('ftp://nope'), null);
  assert.equal(normalizePeerUrl('not a url'), null);
  assert.equal(normalizePeerUrl(''), null);
});

// ---------------------------------------------------------------------------
// mesh_peers upsert — and THE NAMING TRAP
// ---------------------------------------------------------------------------

const cfgWith = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  listen: 8787,
  api_tokens: ['t'],
  server_peers: ['peer:llama-a', 'peer:llama-b'], // llama-swap backends — NOT federation
  mesh_peers: [{ url: 'http://existing:8787', name: 'existing' }],
  ...over,
});

test('upsert adds a row and never touches server_peers or any other key', () => {
  const base = cfgWith();
  const r = upsertMeshPeer(base, 'http://new-box:8787/', 'box-two');
  assert.equal(r.action, 'added');
  assert.ok(r.action !== 'reject');
  assert.deepEqual(r.action !== 'reject' && r.config.mesh_peers, [
    { url: 'http://existing:8787', name: 'existing' },
    { url: 'http://new-box:8787', name: 'box-two' },
  ]);
  // The naming trap: server_peers survives byte-for-byte, every other key rides through.
  assert.deepEqual(r.action !== 'reject' && r.config.server_peers, ['peer:llama-a', 'peer:llama-b']);
  assert.equal(r.action !== 'reject' && r.config.listen, 8787);
  assert.deepEqual(r.action !== 'reject' && r.config.api_tokens, ['t']);
  // The input object is not mutated.
  assert.equal((base.mesh_peers as unknown[]).length, 1);
});

test('upsert dedupes on the normalized url — trailing slashes and whitespace are the same peer', () => {
  const r1 = upsertMeshPeer(cfgWith({ mesh_peers: [] }), 'http://same:8787');
  assert.equal(r1.action, 'added');
  const r2 = upsertMeshPeer(r1.config, 'http://same:8787//');
  assert.equal(r2.action, 'unchanged');
  assert.equal((r2.config.mesh_peers as unknown[]).length, 1);
});

test('upsert renames an existing row only when a new name is given', () => {
  const r = upsertMeshPeer(cfgWith(), 'http://existing:8787', 'renamed');
  assert.equal(r.action, 'renamed');
  assert.deepEqual((r.config.mesh_peers as Record<string, unknown>[])[0], { url: 'http://existing:8787', name: 'renamed' });
  const same = upsertMeshPeer(cfgWith(), 'http://existing:8787');
  assert.equal(same.action, 'unchanged');
});

test('upsert rejects a non-http url without touching the config', () => {
  const r = upsertMeshPeer(cfgWith(), 'httpx://nope');
  assert.equal(r.action, 'reject');
});

test('upsert over a garbage mesh_peers value replaces the junk (applyDefaults would drop it at boot anyway)', () => {
  const r = upsertMeshPeer(cfgWith({ mesh_peers: 'oops' }), 'http://real:8787');
  assert.equal(r.action, 'added');
  assert.deepEqual(r.action !== 'reject' && r.config.mesh_peers, [{ url: 'http://real:8787' }]);
});

test('remove by url and by name; trailing slashes match; server_peers untouched', () => {
  const byUrl = removeMeshPeer(cfgWith(), 'http://existing:8787/');
  assert.equal(byUrl.action, 'removed');
  assert.deepEqual(byUrl.action === 'removed' && byUrl.config.mesh_peers, []);
  assert.deepEqual(byUrl.action === 'removed' && byUrl.config.server_peers, ['peer:llama-a', 'peer:llama-b']);

  const byName = removeMeshPeer(cfgWith(), 'existing');
  assert.equal(byName.action, 'removed');
  assert.equal(byName.action === 'removed' && byName.url, 'http://existing:8787');
});

test('remove names the known peers when nothing matches, and refuses an ambiguous name', () => {
  const miss = removeMeshPeer(cfgWith(), 'ghost');
  assert.equal(miss.action, 'not-found');
  assert.deepEqual(miss.action === 'not-found' && miss.known, ['existing']);

  const two = cfgWith({ mesh_peers: [{ url: 'http://a:1', name: 'dup' }, { url: 'http://b:2', name: 'dup' }] });
  const amb = removeMeshPeer(two, 'dup');
  assert.equal(amb.action, 'ambiguous');
  assert.deepEqual(amb.action === 'ambiguous' && amb.matches, ['http://a:1', 'http://b:2']);
});

// ---------------------------------------------------------------------------
// backup + atomic write (real temp file)
// ---------------------------------------------------------------------------

test('the write is atomic (tmp+rename) and backs the existing file up with a timestamp — never clobbering silently', () => {
  const dir = mkdtempSync(join(tmpdir(), 'idlefill-mesh-cli-'));
  try {
    const file = join(dir, 'config.json');
    writeFileSync(file, JSON.stringify(cfgWith(), null, 2));

    const now = new Date('2026-10-12T15:30:00.123Z');
    const backup = writeConfigAtomicWithBackup(cfgWith({ mesh_peers: [] }), now, file);
    assert.equal(backup, join(dir, 'config.json.bak-20261012T153000Z'));
    assert.deepEqual(JSON.parse(readFileSync(backup, 'utf-8')).mesh_peers.length, 1); // the OLD bytes
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf-8')).mesh_peers, []); // the NEW bytes
    assert.ok(readFileSync(file, 'utf-8').endsWith('\n'));

    // Fresh file: no backup of a file that never existed.
    const fresh = join(dir, 'fresh.json');
    assert.equal(writeConfigAtomicWithBackup({ mesh_peers: [] }, now, fresh), null);
    assert.equal(backupPathFor(file, new Date('2026-10-12T15:30:00Z')), join(dir, 'config.json.bak-20261012T153000Z'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a corrupt config is a named refusal, never a silent rewrite', () => {
  assert.match(parseServerConfig('{oops').error ?? '', /not valid JSON/);
  assert.match(parseServerConfig('[]').error ?? '', /not a JSON object/);
  assert.ok(parseServerConfig('{"listen":1}').ok);
});

// ---------------------------------------------------------------------------
// probe decision table — zero mutation on every non-ok outcome
// ---------------------------------------------------------------------------

const snap = { instance_id: 'm-abc123', name: 'urza', ts: 1, servers: [], queue_depth: 0, sessions: 0, active_leases: 0 };

test('probe: only a 200 carrying a snapshot identity passes', () => {
  assert.deepEqual(probeOutcome(200, null, snap), { kind: 'ok', instance_id: 'm-abc123', name: 'urza' });
  assert.equal(probeOutcome(200, null, { hello: 'world' }).kind, 'bad-shape');
  assert.equal(probeOutcome(200, null, null).kind, 'bad-shape');
  assert.equal(probeOutcome(200, null, []).kind, 'bad-shape');
  assert.equal(probeOutcome(null, 'connect ECONNREFUSED', null).kind, 'unreachable');
  assert.equal(probeOutcome(401, null, null).kind, 'refused-token');
  assert.equal(probeOutcome(403, null, null).kind, 'refused-token');
  assert.equal(probeOutcome(500, null, null).kind, 'http');
});

test('every probe refusal names its reason AND writes nothing', () => {
  for (const o of [
    probeOutcome(null, 'ECONNREFUSED', null),
    probeOutcome(401, null, null),
    probeOutcome(404, null, null),
    probeOutcome(200, null, {}),
  ]) {
    const text = probeRefusalText('http://candidate:8787', o);
    assert.match(text, /^idlefill mesh: join refused — /);
    assert.match(text, /Nothing was written to server\/config\.json\./);
  }
  assert.match(probeRefusalText('http://c:1', probeOutcome(401, null, null)), /peer_token/);
  assert.match(probeRefusalText('http://c:1', probeOutcome(200, null, {})), /not an idlefill arbiter/);
});

// ---------------------------------------------------------------------------
// status wording — the fetch-honesty axis (never fake progress)
// ---------------------------------------------------------------------------

const row = (over: Partial<PeerViewRow>): PeerViewRow => ({
  url: 'http://100.105.225.1:8787',
  name: 'urza',
  instance_id: 'm-abc123',
  online: true,
  fetch_age_s: 12,
  snapshot: {
    name: 'urza',
    servers: [{ name: 'llama-swap', idle: true, idle_for_s: 900, degraded: false }],
    queue_depth: 3,
    sessions: 1,
    active_leases: 0,
  },
  ...over,
});

test('an online row shows the snapshot with its growing age', () => {
  const line = peerStatusLine(row({}));
  assert.match(line, /online — snapshot fetched 12s ago/);
  assert.match(line, /llama-swap idle 900s/);
  assert.match(line, /queue 3 · 1 session\(s\) · 0 lease\(s\)/);
});

test('a stale row NAMES itself offline past the window — the last snapshot is not shown as current', () => {
  const line = peerStatusLine(row({ online: false, fetch_age_s: 500, error: 'mesh fetch HTTP 502' }));
  assert.match(line, new RegExp(`offline — last successful fetch 500s ago, older than the ${PEER_STALE_S}s window`));
  assert.match(line, /mesh fetch HTTP 502/);
  assert.ok(!line.includes('queue 3'), 'no stale snapshot rides an offline row as current');
});

test('a never-fetched row is honest about never having fetched', () => {
  const line = peerStatusLine(row({ online: false, fetch_age_s: null, error: 'mesh fetch HTTP 401', snapshot: null }));
  assert.match(line, /offline — never fetched successfully \(mesh fetch HTTP 401\)/);
});

test('an online row whose LAST fetch failed shows the exception without pretending freshness', () => {
  const line = peerStatusLine(row({ error: 'malformed snapshot' }));
  assert.match(line, /online — snapshot fetched 12s ago/);
  assert.match(line, /last fetch failed: malformed snapshot/);
});

test('renderPeerRows puts the name, url, and observed instance id on the header line', () => {
  const out = renderPeerRows([row({}), row({ url: 'http://x:1', name: 'x', instance_id: null, snapshot: null })]);
  assert.match(out[0], /^urza {2}http:\/\/100\.105\.225\.1:8787 {2}\[m-abc123\]$/);
  assert.ok(out.some((l) => l.includes('http://x:1') && !l.includes('[null]')));
});

// ---------------------------------------------------------------------------
// pairing error voice — the #39/#55 ceremony named, not stack-traced
// ---------------------------------------------------------------------------

test('pairing failures land as named plain outcomes', () => {
  assert.match(explainPairError(400, 'fleet_not_configured') ?? '', /fleet plane/);
  assert.match(explainPairError(400, 'code_used') ?? '', /already used/);
  assert.match(explainPairError(400, 'code_expired') ?? '', /expired/);
  assert.match(explainPairError(400, 'self_pair') ?? '', /own code/);
  assert.match(explainPairError(502, 'pairing_code_failed') ?? '', /fleet service refused/);
  assert.equal(explainPairError(400, 'something else'), null);
});
