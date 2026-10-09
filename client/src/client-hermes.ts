/**
 * #84: the loopback Hermes-gateway connector surface on the client daemon —
 * the Settings-tab card's backend. Before this, turning the #73 connector on
 * meant hand-editing the launch env (`IDLEFILL_HERMES_GATEWAY=1`) and writing
 * a 0600 JSON key file; the operator now sets it from the dashboard.
 *
 *   GET  /client/hermes-gateway
 *        → { enabled, env_switch, base_url, profiles, stored_profiles,
 *            key_file, gateway: { reachable, version?, ledger_size? } | null }
 *   PUT  /client/hermes-gateway  { enabled?, keys?: { <profile>: string|null } }
 *        → { restart_required: true, stored_profiles: [...] }
 *
 * THE KEY RULE: key VALUES never leave the client. GET answers only WHICH
 * profiles have a key stored (never the values); PUT accepts new values and
 * writes them straight to the key file. Keys are never logged, never
 * published to the arbiter, never echoed back.
 *
 * Writes (the same discipline as the sibling config editors):
 *   - keys → the connector's key file (default `~/.idlefill/hermes-gateway-
 *     keys.json` per resolveHermesGatewayConfig): read-modify-write,
 *     `null`/empty string REMOVES a profile's entry, tmp-then-rename, mode
 *     0600 (the directory is created 0700 when missing — fresh machine).
 *   - enabled → the `hermes_gateway` block in the client's own config.json
 *     (every other config key preserved verbatim, file mode preserved,
 *     tmp-then-rename). Not file-backed (IDLEFILL_CLIENT_CONFIG) ⇒ 503 for
 *     the whole PUT when it carries `enabled` — keys can still be written.
 *   - validation is fail-closed and whole-body: one bad member ⇒ 400, no
 *     partial write.
 *
 * Restart posture: the connector is constructed at daemon boot (frozen
 * config discipline), so a successful PUT answers `restart_required: true`
 * and NOTHING restarts here — the same promise the /client/projects editor
 * makes. GET re-reads the key file live, so "stored, restart pending" is
 * visible to the page without the daemon re-reading its own config.
 *
 * Guards (EXACT posture of the sibling surfaces, all fail-closed):
 *   - Host: loopback only;
 *   - Origin (CSRF): a present Origin must name a loopback origin;
 *   - Auth: `X-Idlefill-Edit: <arbiter token>`, constant-time; no token
 *     configured ⇒ 401 (an empty header never "matches" an empty config);
 *   - CORS: loopback origins get explicit allow headers (cross-port fetch).
 */

import { constants, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface ClientHermesStatus {
  enabled: boolean;
  env_switch: boolean;
  base_url: string;
  profiles: string[];
  key_file: string;
  gateway: { reachable: boolean; version?: string; ledger_size?: number } | null;
}

export interface ClientHermesOpts {
  /** The arbiter token this client holds (config.json `token`). */
  token: string;
  /** Absolute path of the file-backed client config, or null when the config came from IDLEFILL_CLIENT_CONFIG. */
  configPath: string | null;
  /** Boot-time view of the connector config (base_url / profiles / key_file / enabled / env switch). */
  status: () => ClientHermesStatus;
}

const HERMES_PATH = '/client/hermes-gateway';

/** Loopback hostname test (same rule the sibling surfaces keep local). */
function loopbackHost(host: string): boolean {
  const h = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  return h === 'localhost' || h.startsWith('127.') || h === '::1';
}

/** An Origin header names a loopback origin? (scheme+host, any port) */
function loopbackOrigin(origin: string): boolean {
  try {
    return loopbackHost(new URL(origin).hostname);
  } catch {
    return false;
  }
}

/** Constant-time compare of the edit token (HMAC-digest to fixed length,
 *  then timingSafeEqual — the comparison never reveals a byte offset). */
function tokenEquals(a: string, b: string): boolean {
  const key = 'idlefill-client-hermes';
  const ha = createHmac('sha256', key).update(a).digest();
  const hb = createHmac('sha256', key).update(b).digest();
  return timingSafeEqual(ha, hb);
}

/** Loopback-allow CORS headers (a cross-port fetch from the page origin). */
function corsHeaders(origin: string | undefined): Record<string, string> {
  const h: Record<string, string> = { vary: 'Origin' };
  if (origin && loopbackOrigin(origin)) {
    h['access-control-allow-origin'] = origin;
    h['access-control-allow-credentials'] = 'false';
  }
  return h;
}

/**
 * Read the key file → the profile names that currently carry a non-empty
 * key. A missing/malformed file = none (the NORMAL fresh-machine case; the
 * same fail-quiet reading `readKeyFile` in the connector applies). VALUES
 * are never returned past this point — only the names.
 */
export function storedKeyProfiles(keyFile: string): string[] {
  try {
    if (!existsSync(keyFile)) return [];
    const raw = JSON.parse(readFileSync(keyFile, 'utf-8')) as Record<string, unknown>;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
    return Object.entries(raw)
      .filter(([, v]) => typeof v === 'string' && v.trim() !== '')
      .map(([k]) => k);
  } catch {
    return [];
  }
}

/**
 * Read-modify-write one key-file mutation: set/clear profile→key entries,
 * every other entry preserved, tmp-then-rename, final mode 0600 (the
 * secret-file posture; a stricter umask on the tmp write is tightened by
 * the chmod back). Creates the parent directory 0700 when missing. Returns
 * an error string on any failure (the whole PUT then 500s, nothing partial).
 */
export function writeKeyFile(keyFile: string, mutations: Map<string, string | null>): string | null {
  let current: Record<string, unknown> = {};
  try {
    if (existsSync(keyFile)) {
      const parsed = JSON.parse(readFileSync(keyFile, 'utf-8')) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return `${keyFile} is not a JSON object — refusing to overwrite it`;
      }
      current = parsed as Record<string, unknown>;
    } else {
      const dir = dirname(keyFile);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
  } catch (err) {
    return `could not read ${keyFile}: ${err instanceof Error ? err.message : err}`;
  }
  for (const [profile, value] of mutations) {
    if (value === null) delete current[profile];
    else current[profile] = value;
  }
  const tmp = `${keyFile}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(current, null, 2) + '\n', {
      mode: 0o600,
      flag: 'w',
    });
    // Tighten regardless of umask/pre-existing mode: this file is a secret.
    chmodSync(tmp, 0o600);
    renameSync(tmp, keyFile);
  } catch (err) {
    return `write failed: ${err instanceof Error ? err.message : err}`;
  }
  return null;
}

/**
 * Read-modify-write the `hermes_gateway` block in the client config file:
 * every other top-level key preserved, the file's mode preserved,
 * tmp-then-rename (the client-projects.ts discipline, mirrored). Returns an
 * error string on any failure.
 */
export function writeHermesBlockToConfig(configPath: string, enabled: boolean): string | null {
  let raw: string;
  let mode: number;
  try {
    raw = readFileSync(configPath, 'utf-8');
    mode = statSync(configPath).mode;
  } catch (err) {
    return `could not read ${configPath}: ${err instanceof Error ? err.message : err}`;
  }
  let cfg: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return `${configPath} is not a JSON object`;
    cfg = parsed as Record<string, unknown>;
  } catch (err) {
    return `${configPath} is not valid JSON: ${err instanceof Error ? err.message : err}`;
  }
  const block =
    cfg.hermes_gateway && typeof cfg.hermes_gateway === 'object' && !Array.isArray(cfg.hermes_gateway)
      ? (cfg.hermes_gateway as Record<string, unknown>)
      : {};
  cfg.hermes_gateway = { ...block, enabled };
  const tmp = `${configPath}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n');
    chmodSync(tmp, mode & (constants.S_IRWXU | constants.S_IRWXG | constants.S_IRWXO));
    renameSync(tmp, configPath);
  } catch (err) {
    return `write failed: ${err instanceof Error ? err.message : err}`;
  }
  return null;
}

/**
 * Validate a PUT body (fail closed, whole body): at least one of
 * `enabled`/`keys`; `enabled` a boolean; `keys` an object whose every
 * member names a profile (1–64 chars, no slashes) and carries either a
 * non-empty trimmed string (≤ 1024) or null/"" (clear). Returns the
 * sanitized mutations (profile → value | null) or an error.
 */
export function validateHermesBody(
  body: unknown,
): { ok: true; enabled: boolean | undefined; keys: Map<string, string | null> } | { ok: false; error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'body must be an object with enabled and/or keys' };
  }
  const r = body as { enabled?: unknown; keys?: unknown };
  if (r.enabled === undefined && r.keys === undefined) {
    return { ok: false, error: 'body must carry enabled and/or keys' };
  }
  let enabled: boolean | undefined;
  if (r.enabled !== undefined) {
    if (typeof r.enabled !== 'boolean') return { ok: false, error: 'enabled must be a boolean' };
    enabled = r.enabled;
  }
  const keys = new Map<string, string | null>();
  if (r.keys !== undefined) {
    if (!r.keys || typeof r.keys !== 'object' || Array.isArray(r.keys)) {
      return { ok: false, error: 'keys must be an object of profile → key (or null to clear)' };
    }
    for (const [profile, v] of Object.entries(r.keys as Record<string, unknown>)) {
      if (profile.trim() === '' || profile.length > 64 || profile.includes('/')) {
        return { ok: false, error: `bad profile name: ${JSON.stringify(profile).slice(0, 80)}` };
      }
      if (v === null || v === '') {
        keys.set(profile, null);
        continue;
      }
      if (typeof v !== 'string' || v.trim() === '' || v.trim().length > 1024) {
        return { ok: false, error: `key for ${JSON.stringify(profile)} must be a non-empty string (≤ 1024) or null` };
      }
      keys.set(profile, v.trim());
    }
  }
  return { ok: true, enabled, keys };
}

/**
 * Handle GET / PUT / OPTIONS on /client/hermes-gateway. Returns true when
 * the request was handled (the caller must then NOT passthrough it).
 */
export function handleClientHermes(req: IncomingMessage, res: ServerResponse, url: URL, opts: ClientHermesOpts): boolean {
  if (url.pathname !== HERMES_PATH) return false;
  const cors = corsHeaders(req.headers.origin);

  // Host guard (before anything else) — same posture as the sibling editors.
  const host = req.headers.host ?? '';
  if (!loopbackHost(host)) {
    res.writeHead(400, { 'content-type': 'application/json', ...cors });
    res.end(JSON.stringify({ error: 'Host must be a loopback address' }));
    return true;
  }
  // CSRF posture: an Origin header must name a loopback origin; absent is
  // allowed (non-browser clients).
  if (req.headers.origin !== undefined && !loopbackOrigin(req.headers.origin)) {
    res.writeHead(403, { 'content-type': 'application/json', ...cors });
    res.end(JSON.stringify({ error: 'cross-origin request refused' }));
    return true;
  }
  // CORS preflight (the page's cross-port fetch asks first for PUT).
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      ...cors,
      'access-control-allow-methods': 'GET, PUT, OPTIONS',
      'access-control-allow-headers': 'content-type, x-idlefill-edit',
      'access-control-max-age': '600',
    });
    res.end();
    return true;
  }
  // Auth: the arbiter token, header-only. Fail closed without it.
  const edit = req.headers['x-idlefill-edit'];
  if (!opts.token || typeof edit !== 'string' || !tokenEquals(edit, opts.token)) {
    res.writeHead(401, { 'content-type': 'application/json', ...cors });
    res.end(JSON.stringify({ error: 'unauthorized', hint: 'X-Idlefill-Edit must carry the arbiter token' }));
    return true;
  }

  if (req.method === 'GET') {
    const st = opts.status();
    res.writeHead(200, { 'content-type': 'application/json', ...cors });
    res.end(
      JSON.stringify({
        ...st,
        // NEVER key values — the names that carry one (re-read live, so a
        // stored-but-not-yet-applied state is visible to the page).
        stored_profiles: storedKeyProfiles(st.key_file),
      }),
    );
    return true;
  }

  if (req.method === 'PUT') {
    const chunks: Buffer[] = [];
    // Bounded like the projects editor: this payload is small by contract.
    let size = 0;
    let over = false;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 64 * 1024) {
        over = true;
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (over) {
        res.writeHead(413, { 'content-type': 'application/json', ...cors });
        res.end(JSON.stringify({ error: 'body too large' }));
        return;
      }
      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
      } catch {
        res.writeHead(400, { 'content-type': 'application/json', ...cors });
        res.end(JSON.stringify({ error: 'invalid JSON body' }));
        return;
      }
      const v = validateHermesBody(body);
      if (!v.ok) {
        res.writeHead(400, { 'content-type': 'application/json', ...cors });
        res.end(JSON.stringify({ error: v.error }));
        return;
      }
      const st = opts.status();
      // An `enabled` write needs a file-backed config; fail closed for the
      // WHOLE PUT (never a key write with a silently dropped enable).
      if (v.enabled !== undefined && !opts.configPath) {
        res.writeHead(503, { 'content-type': 'application/json', ...cors });
        res.end(JSON.stringify({ error: 'client config is not file-backed (IDLEFILL_CLIENT_CONFIG) — enabled cannot be persisted' }));
        return;
      }
      if (v.enabled !== undefined) {
        const err = writeHermesBlockToConfig(opts.configPath!, v.enabled);
        if (err) {
          res.writeHead(500, { 'content-type': 'application/json', ...cors });
          res.end(JSON.stringify({ error: err }));
          return;
        }
      }
      if (v.keys.size > 0) {
        const err = writeKeyFile(st.key_file, v.keys);
        if (err) {
          res.writeHead(500, { 'content-type': 'application/json', ...cors });
          res.end(JSON.stringify({ error: err }));
          return;
        }
      }
      res.writeHead(200, { 'content-type': 'application/json', ...cors });
      res.end(JSON.stringify({ restart_required: true, stored_profiles: storedKeyProfiles(st.key_file) }));
    });
    req.on('error', () => {
      /* aborted upload — nothing to answer */
    });
    return true;
  }

  res.writeHead(405, { 'content-type': 'application/json', allow: 'GET, PUT, OPTIONS', ...cors });
  res.end(JSON.stringify({ error: 'method not allowed' }));
  return true;
}
