/**
 * The `idlefill mesh` group (cli.md D5, issue #91 S4) — status / join /
 * leave / pair. Join is the flow that did not exist: today it meant
 * hand-editing a gitignored config and RESTARTING the arbiter (loadConfig
 * runs once, server/src/index.ts). This slice rides the wave's ONE new
 * server surface — POST /api/mesh/peers/reload, the scoped re-read of
 * `mesh_peers` + `peer_token` only (no restart, in-flight peer state
 * preserved, the next poll tick picks the row up).
 *
 * `join <url>` is probe-then-write: the candidate must answer
 * GET /api/mesh with the configured `peer_token` (the mesh.md D2 read
 * plane) BEFORE anything is written — unreachable / wrong shape / refused
 * token = named refusal, ZERO mutation. Then an atomic upsert of the
 * `mesh_peers` row into server/config.json with a timestamped backup, and
 * THE NAMING TRAP IS ENFORCED: `mesh_peers` is the federation registry;
 * `server_peers` (llama-swap `peer:` backends, mesh.md D1) is never read,
 * never written, never confused.
 *
 * `pair [code]` rides the LOCKED #39/#55 ceremony (`/api/mesh/pair/code`
 * + `/api/mesh/pair`, docs/architecture/pairing.md) — no new handshake,
 * no new credential plane. `join` creates the READ row only; control
 * edges stay the pairing's.
 *
 * Voice (D3): plain words, named outcomes, the dashboard's fetch-honesty
 * axis on `status` (fetch age grows; past the threshold the row names
 * itself offline; never fake progress). `--json` on reads. The token is
 * read AT RUNTIME from the gitignored config, never argv, never printed.
 * Exit codes: 0 ok · 1 action failed · 2 usage.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { EngineFail, repoRoot, resolveAuth } from './engine.js';
import { jsonPayload } from './json.js';

export const MESH_USAGE =
  'usage: idlefill mesh status | join <url> [--name N] | leave <name|url> | pair [code]';

/** The federation registry file the local arbiter reads at boot (gitignored). */
export const SERVER_CONFIG_PATH = join(repoRoot, 'server', 'config.json');

/** Mirrors the arbiter's PEER_STALE_MS (server/src/mesh.ts) — the offline threshold. */
export const PEER_STALE_S = 90;

// ---------------------------------------------------------------------------
// argv (pure)
// ---------------------------------------------------------------------------

export interface MeshFlags {
  name?: string;
}

export type MeshCmd = 'status' | 'join' | 'leave' | 'pair';

const MESH_CMDS: MeshCmd[] = ['status', 'join', 'leave', 'pair'];

export type MeshParse =
  | { ok: true; cmd: MeshCmd; positional: string[]; flags: MeshFlags }
  | { ok: false; error: string };

export function parseMeshArgs(argv: string[]): MeshParse {
  const [cmd, ...rest] = argv;
  if (!cmd) return { ok: true, cmd: 'status', positional: [], flags: {} };
  if (!(MESH_CMDS as string[]).includes(cmd)) {
    return { ok: false, error: `unknown mesh command "${cmd}" — ${MESH_USAGE}` };
  }
  const sub = cmd as MeshCmd;
  const positional: string[] = [];
  const flags: MeshFlags = {};
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i] as string;
    if (tok === '--name') {
      const val = rest[i + 1];
      if (val === undefined || val.startsWith('--')) return { ok: false, error: '--name needs a value' };
      i++;
      flags.name = val;
      continue;
    }
    if (tok.startsWith('-')) return { ok: false, error: `unknown flag "${tok}" — ${MESH_USAGE}` };
    positional.push(tok);
  }
  if (sub === 'status' && positional.length) return { ok: false, error: `status takes no arguments — ${MESH_USAGE}` };
  if (sub === 'join' && (positional.length < 1 || positional.length > 2)) {
    return { ok: false, error: `join needs <url> and at most --name — ${MESH_USAGE}` };
  }
  if (sub === 'leave' && positional.length !== 1) {
    return { ok: false, error: `leave needs exactly <name|url> — ${MESH_USAGE}` };
  }
  if (sub === 'pair' && positional.length > 1) {
    return { ok: false, error: `pair takes at most one [code] — ${MESH_USAGE}` };
  }
  if (sub !== 'join' && flags.name) {
    return { ok: false, error: `--name only applies to join — ${MESH_USAGE}` };
  }
  return { ok: true, cmd: sub, positional, flags };
}

// ---------------------------------------------------------------------------
// URL normalization (pure) — the same rule the arbiter's registry uses
// ---------------------------------------------------------------------------

export function normalizePeerUrl(url: string): string | null {
  const trimmed = String(url ?? '').trim().replace(/\/+$/, '');
  if (trimmed === '' || trimmed === 'self') return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (parsed.hostname === '') return null;
  return trimmed;
}

// ---------------------------------------------------------------------------
// server/config.json upsert (pure over the parsed object)
//
// THE NAMING TRAP (mesh.md D1): this touches `mesh_peers` — the federation
// registry — and NOTHING else. `server_peers` (llama-swap backends) and
// every other key ride through byte-for-byte.
// ---------------------------------------------------------------------------

export type UpsertResult =
  | { action: 'added' | 'renamed' | 'unchanged'; config: Record<string, unknown>; url: string }
  | { action: 'reject'; reason: string };

export function upsertMeshPeer(
  config: Record<string, unknown>,
  url: string,
  name?: string,
): UpsertResult {
  const norm = normalizePeerUrl(url);
  if (!norm) return { action: 'reject', reason: `"${url}" is not an http(s) arbiter URL` };
  const rows = Array.isArray(config.mesh_peers) ? (config.mesh_peers as Record<string, unknown>[]) : [];
  const idx = rows.findIndex((p) => normalizePeerUrl(String(p?.url ?? '')) === norm);
  if (idx < 0) {
    const row: Record<string, unknown> = { url: norm };
    if (name && name.trim()) row.name = name.trim();
    return { action: 'added', config: { ...config, mesh_peers: [...rows, row] }, url: norm };
  }
  const prior = { ...(rows[idx] as Record<string, unknown>) };
  prior.url = norm;
  const wantName = name?.trim();
  if (wantName && prior.name !== wantName) {
    prior.name = wantName;
    const next = [...rows];
    next[idx] = prior;
    return { action: 'renamed', config: { ...config, mesh_peers: next }, url: norm };
  }
  return { action: 'unchanged', config: { ...config, mesh_peers: rows.map((p, i) => (i === idx ? prior : p)) }, url: norm };
}

export type RemoveResult =
  | { action: 'removed'; config: Record<string, unknown>; url: string; name?: string }
  | { action: 'not-found'; known: string[] }
  | { action: 'ambiguous'; matches: string[] };

/** `leave <name|url>`: an exact url match first, then a name match. */
export function removeMeshPeer(config: Record<string, unknown>, nameOrUrl: string): RemoveResult {
  const rows = Array.isArray(config.mesh_peers) ? (config.mesh_peers as Record<string, unknown>[]) : [];
  const target = String(nameOrUrl ?? '').trim();
  const norm = normalizePeerUrl(target);
  let matches = rows.filter((p) => norm !== null && normalizePeerUrl(String(p?.url ?? '')) === norm);
  if (matches.length === 0) {
    matches = rows.filter((p) => typeof p?.name === 'string' && (p.name as string).trim() === target);
  }
  if (matches.length === 0) {
    return { action: 'not-found', known: rows.map((p) => String(p?.name ?? p?.url ?? '')) };
  }
  if (matches.length > 1) {
    return { action: 'ambiguous', matches: matches.map((p) => String(p?.url ?? '')) };
  }
  const victim = matches[0] as Record<string, unknown>;
  const victimUrl = normalizePeerUrl(String(victim?.url ?? '')) ?? String(victim?.url ?? '');
  const kept = rows.filter((p) => p !== victim);
  const name = typeof victim.name === 'string' && (victim.name as string).trim() !== '' ? (victim.name as string).trim() : undefined;
  return { action: 'removed', config: { ...config, mesh_peers: kept }, url: victimUrl, name };
}

/** Timestamped backup name: config.json → config.json.bak-20261012T153000Z */
export function backupPathFor(path: string, now: Date): string {
  return `${path}.bak-${now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}`;
}

/** Parse the config text into an object (pure) — anything else is a named refusal. */
export function parseServerConfig(text: string): { ok: true; config: Record<string, unknown> } | { ok: false; error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: `server/config.json is not valid JSON (${err instanceof Error ? err.message : err}) — fix it before joining` };
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'server/config.json is not a JSON object — refusing to touch it' };
  }
  return { ok: true, config: raw as Record<string, unknown> };
}

// ---------------------------------------------------------------------------
// The probe (pure decision + wording) — join proves the read plane FIRST
// ---------------------------------------------------------------------------

export type ProbeOutcome =
  | { kind: 'ok'; instance_id: string; name: string }
  | { kind: 'unreachable'; error: string }
  | { kind: 'refused-token'; status: number }
  | { kind: 'http'; status: number }
  | { kind: 'bad-shape' };

/** The minimal read-plane shape check (mirrors sanitizeSnapshot's identity rule). */
export function probeOutcome(status: number | null, err: string | null, body: unknown): ProbeOutcome {
  if (status === null) return { kind: 'unreachable', error: err ?? 'unknown error' };
  if (status === 401 || status === 403) return { kind: 'refused-token', status };
  if (status < 200 || status >= 300) return { kind: 'http', status };
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    typeof (body as Record<string, unknown>).instance_id !== 'string' ||
    !String((body as Record<string, unknown>).instance_id).trim()
  ) {
    return { kind: 'bad-shape' };
  }
  const b = body as Record<string, unknown>;
  return {
    kind: 'ok',
    instance_id: String(b.instance_id),
    name: typeof b.name === 'string' ? b.name : '',
  };
}

export function probeRefusalText(url: string, o: ProbeOutcome): string {
  const why =
    o.kind === 'unreachable'
      ? `cannot reach ${url}/api/mesh (${o.error})`
      : o.kind === 'refused-token'
        ? `the candidate answered HTTP ${o.status} on GET /api/mesh — it does not accept the configured peer_token (the fleet read token must match on BOTH arbiters, mesh.md D2)`
        : o.kind === 'http'
          ? `the candidate answered HTTP ${o.status} on GET /api/mesh — that is not an idlefill arbiter's read plane`
          : o.kind === 'bad-shape'
            ? 'the candidate answered, but NOT with a /api/mesh snapshot (no instance_id) — that URL is not an idlefill arbiter'
            : 'unexpected';
  return `idlefill mesh: join refused — ${why}. Nothing was written to server/config.json.`;
}

// ---------------------------------------------------------------------------
// Peer view rendering (pure) — the dashboard's fetch-honesty axis
// ---------------------------------------------------------------------------

export interface PeerViewRow {
  url: string;
  name: string;
  instance_id: string | null;
  online: boolean;
  fetch_age_s: number | null;
  error?: string;
  snapshot?: {
    name?: string;
    servers?: { name: string; idle: boolean; idle_for_s: number | null; degraded: boolean }[];
    queue_depth?: number;
    sessions?: number;
    active_leases?: number;
  } | null;
}

/** The honesty line for one row — age grows, past the threshold the row NAMES itself offline. */
export function peerStatusLine(p: PeerViewRow): string {
  if (p.online) {
    const snap = p.snapshot;
    const line = `online — ${typeof p.fetch_age_s === 'number' ? `snapshot fetched ${p.fetch_age_s}s ago` : 'no successful fetch yet'}`;
    const parts = [line];
    if (snap) {
      const engines = (snap.servers ?? []).map((e) => `${e.name} ${e.degraded ? 'degraded' : e.idle ? `idle${typeof e.idle_for_s === 'number' ? ` ${e.idle_for_s}s` : ''}` : 'busy'}`);
      parts.push(`  engines: ${engines.length ? engines.join(', ') : '(no local engines)'}`);
      parts.push(`  queue ${snap.queue_depth ?? 0} · ${snap.sessions ?? 0} session(s) · ${snap.active_leases ?? 0} lease(s)`);
    }
    if (p.error) parts.push(`  (the last fetch failed: ${p.error} — the row shows its previous snapshot)`);
    return parts.join('\n');
  }
  const never = p.fetch_age_s === null;
  const base = never
    ? `offline — never fetched successfully${p.error ? ` (${p.error})` : ''}`
    : `offline — last successful fetch ${p.fetch_age_s}s ago, older than the ${PEER_STALE_S}s window${p.error ? ` (${p.error})` : ''}`;
  return `${base} — the last snapshot is not shown as current`;
}

export function renderPeerRows(peers: PeerViewRow[]): string[] {
  const out: string[] = [];
  for (const p of peers) {
    const id = p.instance_id ? `  [${p.instance_id}]` : '';
    out.push(`${p.name}  ${p.url}${id}`);
    for (const line of peerStatusLine(p).split('\n')) out.push(`  ${line}`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pairing error voice (pure) — the #39/#55 ceremony, named outcomes
// ---------------------------------------------------------------------------

export function explainPairError(status: number, detail: string): string | null {
  if (detail.includes('fleet_not_configured')) {
    return 'pairing needs the fleet plane (fleet_url + fleet_enrollment_token in the arbiter config) — see docs/architecture/fleet-service.md D2';
  }
  if (detail.includes('code_used')) return 'that pairing code was already used — mint a fresh one on the peer (`idlefill mesh pair`)';
  if (detail.includes('code_expired')) return 'that pairing code expired — mint a fresh one on the peer';
  if (detail.includes('self_pair')) return 'that is this machine\'s own code — pair the OTHER machine to it';
  if (detail.includes('pairing_code_failed')) return 'the fleet service refused the code mint (unreachable, or this machine\'s enrollment credential is stale)';
  if (status === 401) return 'the fleet service refused the redeem — check this machine\'s enrollment (identity.json / fleet_enrollment.json)';
  return null;
}

// ---------------------------------------------------------------------------
// The live group
// ---------------------------------------------------------------------------

class MeshFail extends Error {}
class MeshUsage extends Error {}

interface ArbiterAnswer {
  [k: string]: unknown;
}

async function apiCall(
  serverUrl: string,
  token: string,
  method: string,
  path: string,
  body?: unknown,
  timeoutMs = 10_000,
): Promise<{ status: number; payload: ArbiterAnswer | null; text: string }> {
  // A JSON body rides the content-type; a body-less POST sends NO content-type
  // (Fastify 400s an application/json request with an empty body — the
  // reload/pair/code calls are body-less POSTs).
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(serverUrl + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  }).catch((err: Error) => {
    throw new MeshFail(`cannot reach the arbiter at ${serverUrl} (${err.message})`);
  });
  const text = await res.text();
  let payload: ArbiterAnswer | null = null;
  try {
    payload = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { status: res.status, payload, text };
}

function readLocalServerConfig(): { config: Record<string, unknown> | null; exists: boolean } {
  if (!existsSync(SERVER_CONFIG_PATH)) return { config: null, exists: false };
  const parsed = parseServerConfig(readFileSync(SERVER_CONFIG_PATH, 'utf-8'));
  if (!parsed.ok) throw new MeshFail(parsed.error);
  return { config: parsed.config, exists: true };
}

/** Backup (existing file only), then atomic tmp+rename — the state-file posture. */
export function writeConfigAtomicWithBackup(
  config: Record<string, unknown>,
  now: Date,
  path: string = SERVER_CONFIG_PATH,
): string | null {
  const existed = existsSync(path);
  let backup: string | null = null;
  if (existed) {
    backup = backupPathFor(path, now);
    writeFileSync(backup, readFileSync(path));
  }
  const tmp = `${path}.tmp-${process.pid}-${now.getTime()}`;
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`);
  renameSync(tmp, path);
  return backup;
}

export async function runMesh(argv: string[], json: boolean): Promise<number> {
  try {
    return await runMeshInner(argv, json);
  } catch (err) {
    if (err instanceof MeshUsage) {
      console.error(`idlefill mesh: ${err.message}`);
      return 2;
    }
    if (err instanceof MeshFail) {
      console.error(`idlefill mesh: ${err.message}`);
      return 1;
    }
    if (err instanceof EngineFail) {
      console.error(`idlefill mesh: ${err.message}`);
      return 1;
    }
    throw err;
  }
}

async function runMeshInner(argv: string[], json: boolean): Promise<number> {
  const parsed = parseMeshArgs(argv);
  if (!parsed.ok) throw new MeshUsage(parsed.error);
  const { cmd, positional, flags } = parsed;

  const { token, serverUrl } = resolveAuth();

  // -------------------------------------------------------------------------
  // status — the merged peer view, fetch-honest
  // -------------------------------------------------------------------------

  if (cmd === 'status') {
    const r = await apiCall(serverUrl, token, 'GET', '/api/state');
    if (r.status !== 200) {
      const detail = String(r.payload?.error ?? r.text) || 'no detail';
      throw new MeshFail(`GET /api/state → HTTP ${r.status}: ${detail}`);
    }
    const meshBlock = (r.payload as Record<string, unknown>)?.mesh;
    const peers = (meshBlock && typeof meshBlock === 'object' ? (meshBlock as Record<string, unknown>).peers : undefined) as PeerViewRow[] | undefined;
    if (json) {
      console.log(jsonPayload(peers ?? []));
      return 0;
    }
    if (meshBlock === undefined) {
      console.log('this arbiter publishes no mesh view — it predates the read plane or federation is unwired');
      return 0;
    }
    if (!peers?.length) {
      console.log('no mesh peers configured — `idlefill mesh join <url>` adds one');
      return 0;
    }
    console.log(renderPeerRows(peers).join('\n'));
    return 0;
  }

  // -------------------------------------------------------------------------
  // join — probe-then-write, then the scoped re-read
  // -------------------------------------------------------------------------

  if (cmd === 'join') {
    const url = normalizePeerUrl(positional[0] as string);
    if (!url) {
      throw new MeshUsage(`join needs an http(s) arbiter URL — the candidate's address, e.g. http://100.105.225.1:8787 — ${MESH_USAGE}`);
    }
    const local = normalizePeerUrl(serverUrl);
    if (local && local === url) {
      throw new MeshFail(`join refused — ${url} is this arbiter itself; a machine is not its own peer. Nothing was written.`);
    }
    if (process.env.IDLEFILL_CONFIG && process.env.IDLEFILL_CONFIG.trim()) {
      throw new MeshFail(
        'join refused — IDLEFILL_CONFIG is set in this shell, so the local arbiter reads its config from the environment, and this command writes server/config.json (which that arbiter never reads). Unset IDLEFILL_CONFIG, or add the mesh_peers row to the config source the arbiter actually uses. Nothing was written.',
      );
    }

    // 1. probe FIRST with the configured peer_token (mesh.md D2 read plane).
    const { config } = readLocalServerConfig();
    const peerToken = typeof config?.peer_token === 'string' ? config.peer_token.trim() : '';
    if (peerToken === '') {
      throw new MeshFail(
        `join refused — server/config.json carries no peer_token, and the fleet read plane needs one on BOTH arbiters (mesh.md D2). Set the same peer_token here and on ${url}. Nothing was written.`,
      );
    }
    let outcome: ProbeOutcome;
    try {
      const res = await fetch(`${url}/api/mesh`, {
        headers: { authorization: `Bearer ${peerToken}` },
        signal: AbortSignal.timeout(10_000),
      });
      const body = await res.json().catch(() => null);
      outcome = probeOutcome(res.status, null, body);
    } catch (err) {
      outcome = probeOutcome(null, (err as Error).message, null);
    }
    if (outcome.kind !== 'ok') {
      console.error(probeRefusalText(url, outcome));
      return 1;
    }

    // 2. upsert the mesh_peers row — atomic, timestamped backup, server_peers untouched.
    const base = config ?? {};
    const up = upsertMeshPeer(base, url, flags.name);
    if (up.action === 'reject') throw new MeshFail(`join refused — ${up.reason}. Nothing was written.`);
    const backup = writeConfigAtomicWithBackup(up.config, new Date());

    // 3. the scoped re-read on the local arbiter — the wave's ONE new surface.
    const rr = await apiCall(serverUrl, token, 'POST', '/api/mesh/peers/reload').catch((err: MeshFail) => {
      console.error(`idlefill mesh: ${err.message}`);
      console.error(
        `  the ${up.action === 'unchanged' ? 'row is already in' : 'row was written into'} server/config.json${backup ? ` (backup: ${backup})` : ''} — it applies at the arbiter's NEXT BOOT. Start the arbiter (or fix the URL in the config) and re-run to make it live now.`,
      );
      return null;
    });
    if (rr === null) return 1;
    if (rr.status !== 200) {
      const detail = String(rr.payload?.error ?? rr.payload?.reason ?? rr.text) || 'no detail';
      console.error(`idlefill mesh: the arbiter refused the re-read — HTTP ${rr.status}: ${detail}`);
      console.error(`  the row is written in server/config.json${backup ? ` (backup: ${backup})` : ''} and applies at the arbiter's next boot.`);
      return 1;
    }
    const applied = ((rr.payload?.peers ?? []) as { url: string }[]).map((p) => p.url);
    if (!applied.includes(url)) {
      console.error(
        `idlefill mesh: the arbiter re-read its config but ${url} is NOT in its live peer set — its config source is not this checkout's server/config.json (IDLEFILL_CONFIG elsewhere?). The row is written${backup ? ` (backup: ${backup})` : ''}.`,
      );
      return 1;
    }

    // 4. report the FIRST real fetch: poll the merged view until the tick fetches (bounded).
    const pollMs = typeof rr.payload?.poll_ms === 'number' ? (rr.payload.poll_ms as number) : 15_000;
    const deadline = Date.now() + Math.min(30_000, pollMs + 5_000);
    let row: PeerViewRow | null = null;
    while (Date.now() < deadline) {
      const st = await apiCall(serverUrl, token, 'GET', '/api/state').catch(() => null);
      const rows = ((st?.payload as Record<string, Record<string, unknown>> | null)?.mesh?.peers ?? []) as PeerViewRow[];
      const found = rows.find((p) => normalizePeerUrl(p.url) === url) ?? null;
      if (found && (found.fetch_age_s !== null || found.error !== undefined)) {
        row = found;
        break;
      }
      if (found) row = found;
      await new Promise((res) => setTimeout(res, 1_000));
    }
    const label = flags.name?.trim() || outcome.name || new URL(url).host;
    if (json) {
      console.log(jsonPayload({ joined: url, name: label, probe: outcome, backup, applied, peer: row }));
      return 0;
    }
    console.log(
      `ok: joined "${label}" at ${url} — mesh_peers row ${up.action} in server/config.json${backup ? ` (backup: ${backup})` : ' (new file)'}; server_peers (llama-swap backends) untouched`,
    );
    console.log(`  probe: the candidate answered /api/mesh as instance ${outcome.instance_id}${outcome.name ? ` ("${outcome.name}")` : ''} — the peer_token matches on both sides`);
    if (row) {
      console.log(`  live on the arbiter at ${serverUrl}:`);
      for (const line of peerStatusLine(row).split('\n')) console.log(`    ${line}`);
    } else {
      console.log(`  the row is live on the arbiter — the next poll tick (≤${Math.round(pollMs / 1000)}s) fetches the first snapshot; watch with \`idlefill mesh status\``);
    }
    console.log('  join creates the READ row only — control edges are the pairing ceremony\'s (`idlefill mesh pair`)');
    return 0;
  }

  // -------------------------------------------------------------------------
  // leave — drop the row, re-read, report
  // -------------------------------------------------------------------------

  if (cmd === 'leave') {
    const target = String(positional[0] ?? '').trim();
    const { config, exists } = readLocalServerConfig();
    if (!exists || !config) {
      throw new MeshFail(`leave refused — no server/config.json at ${SERVER_CONFIG_PATH} — there is no federation registry here to leave. Nothing was written.`);
    }
    const rm = removeMeshPeer(config, target);
    if (rm.action === 'not-found') {
      throw new MeshFail(
        `leave refused — no mesh_peers row matches "${target}"${rm.known.length ? ` (known: ${rm.known.join(', ')})` : ' (the registry is empty)'}. Nothing was written.`,
      );
    }
    if (rm.action === 'ambiguous') {
      throw new MeshFail(`leave refused — "${target}" matches ${rm.matches.length} peers (${rm.matches.join(', ')}) — name the url. Nothing was written.`);
    }
    const backup = writeConfigAtomicWithBackup(rm.config, new Date());
    const rr = await apiCall(serverUrl, token, 'POST', '/api/mesh/peers/reload');
    if (rr.status !== 200) {
      const detail = String(rr.payload?.error ?? rr.payload?.reason ?? rr.text) || 'no detail';
      console.error(`idlefill mesh: the arbiter refused the re-read — HTTP ${rr.status}: ${detail}`);
      console.error(`  the row IS removed from server/config.json (backup: ${backup ?? 'new file'}) and the arbiter applies it at its next boot.`);
      return 1;
    }
    const applied = ((rr.payload?.peers ?? []) as { url: string }[]).map((p) => p.url);
    const label = rm.name ?? rm.url;
    if (json) {
      console.log(jsonPayload({ left: rm.url, name: rm.name, backup, applied }));
      return 0;
    }
    console.log(`ok: left "${label}" (${rm.url}) — row removed from server/config.json (backup: ${backup ?? 'new file'})`);
    if (applied.includes(rm.url)) {
      console.log('  note: the arbiter\'s live set STILL lists this url — the fleet roster (not mesh_peers) owns that row; unpair it to fully remove it');
    } else {
      console.log(`  the arbiter at ${serverUrl} re-applied its peer set without it — no restart`);
    }
    return 0;
  }

  // -------------------------------------------------------------------------
  // pair [code] — ride the LOCKED ceremony (#39 / #55 D4 shape (b))
  // -------------------------------------------------------------------------

  if (cmd === 'pair') {
    const code = positional[0]?.trim();
    if (!code) {
      const r = await apiCall(serverUrl, token, 'POST', '/api/mesh/pair/code');
      if (r.status !== 200) {
        const detail = String(r.payload?.error ?? r.text) || 'no detail';
        const named = explainPairError(r.status, detail);
        throw new MeshFail(named ?? `POST /api/mesh/pair/code → HTTP ${r.status}: ${detail}`);
      }
      const p = r.payload as Record<string, unknown>;
      if (json) {
        console.log(jsonPayload(p));
        return 0;
      }
      console.log(`pairing code: ${p.code} — valid ${p.ttl_s}s, one-time`);
      console.log(`  hand it to the peer over the tailnet; on THAT machine run: idlefill mesh pair ${p.code}`);
      console.log(`  when redeemed, that machine becomes the CONTROLLER of this one (pairing.md D5 — direction is explicit, never bidirectional)`);
      return 0;
    }
    const r = await apiCall(serverUrl, token, 'POST', '/api/mesh/pair', { code });
    if (r.status !== 200) {
      const detail = String(r.payload?.error ?? r.text) || 'no detail';
      const named = explainPairError(r.status, detail);
      throw new MeshFail(named ?? `POST /api/mesh/pair → HTTP ${r.status}: ${detail}`);
    }
    const p = r.payload as Record<string, unknown>;
    if (json) {
      console.log(jsonPayload(p));
      return 0;
    }
    console.log(`ok: paired with ${p.peer_name ?? p.paired_with} — this machine is the CONTROLLER (direction: ${p.direction})`);
    if (p.already_recorded) console.log('  the edge record already existed — nothing changed');
    console.log('  the per-edge credential is this arbiter\'s ed25519 key (identity.json) — no shared secret rides anywhere');
    return 0;
  }

  throw new MeshUsage(MESH_USAGE);
}
