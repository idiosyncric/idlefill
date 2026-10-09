/**
 * #46: the loopback session-control surface on the client daemon — the
 * true-pause interrupt half.
 *
 * The session gate HOLDS a paused / over-capacity session's requests (the
 * agent's HTTP client waits on the wire), so inside Hermes a parked turn
 * looks like the model is "thinking" forever. This route lets the operator
 * stop that stall:
 *
 *   POST /sessions/<token>/release
 *        → { ok: true, released: N }   (N parked requests answered)
 *
 * Guarded with the EXACT posture the sibling client-config editor
 * (client-projects.ts) uses — same fail-closed shape, loopback only:
 *   - Host: only 127.0.0.1 / localhost (the proxy is loopback-bound
 *     already; this closes DNS-rebinding-style Host games).
 *   - Origin (CSRF): a request that CARRIES an Origin header must come
 *     from a loopback origin; a non-browser client with no Origin is
 *     allowed.
 *   - Auth: `X-Idlefill-Edit: <arbiter token>` — the SAME token the
 *     client holds in its own config.json, compared constant-time. A
 *     client configured WITHOUT a token cannot authenticate (401, fail
 *     closed — an empty header never "matches" an empty config).
 *
 * Effect: the gate's `releaseHold(token)` answers every PARKED request
 * for the token with the retryable 503 + Retry-After the hold-cap
 * contract already defines, and frees the queue slot. It does NOT
 * interrupt in-flight traffic and does NOT clear the operator pause
 * override (the gate's honest limits, stated on the method).
 *
 * Unknown token / no parked holds → `{ ok: true, released: 0 }`: the
 * release is idempotent and a stale handle is a no-op, never an error
 * (the operator may call it after the turn already settled).
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface SessionControlOpts {
  /** The arbiter token this client holds (config.json `token`). */
  token: string;
  /** The session gate that owns the parked holds (absent = gate off). */
  gate: { releaseHold(token: string): number };
}

/** `/sessions/<token>/release` — distinct from the gate's `/s/<token>/…`
 *  passthrough (that regex requires `/s/`, so the control path can never
 * be mistaken for session traffic) and from `/sessions/<token>/transcript`
 *  (different last segment; both live on this loopback bind). */
const RELEASE_PATH_RE = /^\/sessions\/([^/]+)\/release$/;

/** Loopback hostname test (same rule as client-projects.ts keeps local). */
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

/** Constant-time compare of the control token (mirrors client-projects:
 *  HMAC-digest both sides, then timingSafeEqual — no early-return leak). */
function tokenEquals(a: string, b: string): boolean {
  const key = 'idlefill-session-control';
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
 * Handle POST /sessions/<token>/release. Returns true when the request was
 * handled (the caller must then NOT passthrough it). The path must match
 * exactly (with-or-without query); every other path/method falls through
 * (false) so passthrough and the sibling control routes are untouched.
 */
export function handleSessionControl(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  opts: SessionControlOpts,
): boolean {
  const m = RELEASE_PATH_RE.exec(url.pathname);
  if (!m) return false;

  const cors = corsHeaders(req.headers.origin);

  // Host guard (before anything else) — same posture as the config editor.
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
  // Method: POST only (the release is a state change; a GET here would
  // answer 405 rather than silently no-op, so a mistaken fetch is visible).
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      ...cors,
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'content-type, x-idlefill-edit',
      'access-control-max-age': '600',
    });
    res.end();
    return true;
  }
  if (req.method !== 'POST') {
    res.writeHead(405, { 'content-type': 'application/json', allow: 'POST, OPTIONS', ...cors });
    res.end(JSON.stringify({ error: 'method not allowed' }));
    return true;
  }
  // Auth: the arbiter token, header-only (never a query param — a token in
  // a URL lands in logs). Fail closed when the client has no token or the
  // header is missing/mismatched: 401, and the request is handled (a bad
  // token is a NO-OP release, never a partial one).
  const edit = req.headers['x-idlefill-edit'];
  if (!opts.token || typeof edit !== 'string' || !tokenEquals(edit, opts.token)) {
    res.writeHead(401, { 'content-type': 'application/json', ...cors });
    res.end(JSON.stringify({ error: 'unauthorized', hint: 'X-Idlefill-Edit must carry the arbiter token' }));
    return true;
  }

  let token = m[1] ?? '';
  try {
    token = decodeURIComponent(token);
  } catch {
    /* malformed %xx: keep the raw token (the arbiter stores it verbatim) */
  }
  // releaseHold is idempotent: unknown token or no parked holds ⇒ 0.
  const released = opts.gate.releaseHold(token);
  const body = JSON.stringify({ ok: true, released });
  res.writeHead(200, {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(body)),
    ...cors,
  });
  res.end(body);
  return true;
}
