/**
 * The loopback client-config editor routes (#61 step 3 A3): the page cannot
 * write a local file, but the LOCAL client can — and the desktop webview /
 * loopback-served page always live on the same machine, so the page reaches
 * the client's ALREADY-BOUND loopback proxy directly on these two paths:
 *
 *   GET  /client/projects  → { projects: [...] }  (the raw config entries)
 *   PUT  /client/projects  → { restart_required: true }  (rewrite + restart note)
 *
 * Guards (all fail-closed):
 *   - Host: only 127.0.0.1 / localhost (the proxy is loopback-bound already;
 *     this closes DNS-rebinding-style Host games).
 *   - Origin (CSRF): a request that CARRIES an Origin header must come from
 *     a loopback origin (localhost/127.0.0.1, any port). A non-browser
 *     client with no Origin header is allowed.
 *   - Auth: `X-Idlefill-Edit: <arbiter token>` — the SAME token the client
 *     holds in its own config.json. Compared constant-time. The desktop
 *     webview already injects the token for the page, so zero pasting holds.
 *   - CORS: this is a cross-PORT fetch (page on the arbiter origin, client
 *     on the proxy port), so loopback origins get explicit allow headers
 *     (mirror of the arbiter's public-read posture, scoped to loopback).
 *
 * Write discipline (the Swift save path's promise, mirrored):
 *   - validate EVERY entry first; any invalid entry → 400 for the whole
 *     PUT, never a partial file (launch-time parsing would fail-fast on a
 *     bad adapter/executor, so the file must never carry one).
 *   - preserve every other config key (the token included) and the file's
 *     existing mode (0600) — read before, chmod'd back after.
 *   - tmp-then-rename, like every other client write.
 *   - a successful PUT does NOT restart anything: the restart stays a
 *     native/launchd action (the response says restart_required).
 */

import { constants, chmodSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface ClientProjectsOpts {
  /** The arbiter token this client holds (config.json `token`). */
  token: string;
  /** Absolute path of the file-backed client config, or null when the config came from IDLEFILL_CLIENT_CONFIG (no file to write). */
  configPath: string | null;
}

/** Loopback hostname test (same rule as index.ts isLoopbackUrl, kept local so proxy.ts stays dependency-light). */
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

/** Constant-time compare of the edit token (length mismatch = false, no early-return leak on content). */
function tokenEquals(a: string, b: string): boolean {
  // HMAC-digest both sides to fixed length, then timingSafeEqual — the
  // comparison itself never reveals a byte offset.
  const key = 'idlefill-client-projects';
  const ha = createHmac('sha256', key).update(a).digest();
  const hb = createHmac('sha256', key).update(b).digest();
  return timingSafeEqual(ha, hb);
}

/** Loopback-allow CORS headers (cross-port fetch from the page's origin). */
function corsHeaders(origin: string | undefined): Record<string, string> {
  const h: Record<string, string> = { vary: 'Origin' };
  if (origin && loopbackOrigin(origin)) {
    h['access-control-allow-origin'] = origin;
    h['access-control-allow-credentials'] = 'false';
  }
  return h;
}

export interface ProjectsValidation {
  ok: boolean;
  error?: string;
  projects?: Record<string, unknown>[];
}

/**
 * Validate a PUT body the way launch-time config parsing demands (fail
 * closed): an object with a `projects` array; every entry an object with
 * non-empty `name` / `model` / `queue_file` strings; `estimated_seconds` /
 * `timeout_seconds` finite numbers > 0 when present; `executor` /
 * `adapter` strings when present. Any OTHER key passes through untouched
 * (the editor round-trips the whole entry — results_file, cwd,
 * scheduled_rebuild, and future keys survive verbatim). One invalid entry
 * rejects the WHOLE body — never a partial write.
 */
export function validateProjectsBody(body: unknown): ProjectsValidation {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'body must be an object with a projects array' };
  }
  const raw = (body as { projects?: unknown }).projects;
  if (!Array.isArray(raw)) return { ok: false, error: 'projects must be an array' };
  const out: Record<string, unknown>[] = [];
  for (let i = 0; i < raw.length; i++) {
    const p = raw[i];
    if (!p || typeof p !== 'object' || Array.isArray(p)) {
      return { ok: false, error: `row ${i + 1}: project must be an object` };
    }
    const r = p as Record<string, unknown>;
    for (const key of ['name', 'model', 'queue_file']) {
      const v = r[key];
      if (typeof v !== 'string' || v.trim() === '') {
        return { ok: false, error: `row ${i + 1}: ${key} is required` };
      }
    }
    for (const key of ['estimated_seconds', 'timeout_seconds']) {
      if (r[key] === undefined) continue;
      const v = r[key];
      if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
        return { ok: false, error: `row ${i + 1}: ${key} must be a positive number` };
      }
    }
    for (const key of ['executor', 'adapter']) {
      if (r[key] === undefined) continue;
      if (typeof r[key] !== 'string') return { ok: false, error: `row ${i + 1}: ${key} must be a string` };
    }
    out.push(r);
  }
  return { ok: true, projects: out };
}

/**
 * Read-modify-write the projects array into the config file: every other
 * top-level key preserved, the file's existing mode preserved (0600),
 * tmp-then-rename. Returns an error string on any failure.
 */
export function writeProjectsToConfig(configPath: string, projects: Record<string, unknown>[]): string | null {
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
  cfg.projects = projects;
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
 * Handle GET / PUT / OPTIONS on /client/projects. Returns true when the
 * request was handled (the caller must then NOT passthrough it). The path
 * must match exactly (with-or-without query).
 */
export function handleClientProjects(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  opts: ClientProjectsOpts,
): boolean {
  if (url.pathname !== '/client/projects') return false;
  const cors = corsHeaders(req.headers.origin);

  // Host guard (before anything else).
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
  // Auth: the arbiter token, header-only (never a query param — a token in
  // a URL lands in logs). A client configured WITHOUT a token cannot
  // authenticate the write at all — fail closed (401), never accept an
  // empty header as "matching" the empty config.
  const edit = req.headers['x-idlefill-edit'];
  if (!opts.token || typeof edit !== 'string' || !tokenEquals(edit, opts.token)) {
    res.writeHead(401, { 'content-type': 'application/json', ...cors });
    res.end(JSON.stringify({ error: 'unauthorized', hint: 'X-Idlefill-Edit must carry the arbiter token' }));
    return true;
  }
  if (!opts.configPath) {
    res.writeHead(503, { 'content-type': 'application/json', ...cors });
    res.end(JSON.stringify({ error: 'client config is not file-backed (IDLEFILL_CLIENT_CONFIG)' }));
    return true;
  }

  if (req.method === 'GET') {
    let cfg: Record<string, unknown>;
    try {
      cfg = JSON.parse(readFileSync(opts.configPath, 'utf-8')) as Record<string, unknown>;
    } catch (err) {
      res.writeHead(500, { 'content-type': 'application/json', ...cors });
      res.end(JSON.stringify({ error: `could not read config: ${err instanceof Error ? err.message : err}` }));
      return true;
    }
    const projects = Array.isArray(cfg.projects) ? cfg.projects : [];
    res.writeHead(200, { 'content-type': 'application/json', ...cors });
    res.end(JSON.stringify({ projects }));
    return true;
  }

  if (req.method === 'PUT') {
    let body: unknown;
    try {
      const chunks: Buffer[] = [];
      // The proxy buffers only this route: a config file is small by
      // contract, so a hard cap guards against abuse without changing
      // passthrough behaviour (the LLM streaming path stays untouched).
      let size = 0;
      let over = false;
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > 256 * 1024) {
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
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
        } catch {
          res.writeHead(400, { 'content-type': 'application/json', ...cors });
          res.end(JSON.stringify({ error: 'invalid JSON body' }));
          return;
        }
        const v = validateProjectsBody(body);
        if (!v.ok) {
          res.writeHead(400, { 'content-type': 'application/json', ...cors });
          res.end(JSON.stringify({ error: v.error }));
          return;
        }
        const writeErr = writeProjectsToConfig(opts.configPath!, v.projects!);
        if (writeErr) {
          res.writeHead(500, { 'content-type': 'application/json', ...cors });
          res.end(JSON.stringify({ error: writeErr }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json', ...cors });
        res.end(JSON.stringify({ restart_required: true }));
      });
      req.on('error', () => {
        /* aborted upload — nothing to answer */
      });
    } catch (err) {
      res.writeHead(500, { 'content-type': 'application/json', ...cors });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    }
    return true;
  }

  res.writeHead(405, { 'content-type': 'application/json', 'allow': 'GET, PUT, OPTIONS', ...cors });
  res.end(JSON.stringify({ error: 'method not allowed' }));
  return true;
}
