/**
 * #85 slice A: the ON-DEMAND Hermes transcript surface on the client daemon's
 * loopback bind — the session viewer's real conversation, page by page.
 *
 *   GET /client/hermes-transcript/<session_id>?offset=<n>&limit=<n>
 *       → { ok: true, profile, session_id, offset, limit, returned,
 *           next_offset, has_more,
 *           messages: [{ role, content, content_truncated, tool_name,
 *                       tool_calls, token_count, finish_reason, timestamp, id }] }
 *       → { ok: false, error, reason } with a 503-class status when the
 *          connector is disabled, no profile carries a key, the gateway is
 *          unreachable (gateway_unreachable), or the walk answered only
 *          ambiguously — 401/403/5xx/malformed (gateway_ambiguous); 404
 *          ONLY when every keyed profile answered an explicit 404; 400
 *          for a malformed session id.
 *
 * WHY loopback (the editor precedent, #61/#84): transcript bytes belong to
 * the LOCAL page only. They NEVER ride the register heartbeat, never enter
 * the arbiter's /api/state, and are never bulk-polled — this route is hit
 * only while the viewer is open, and only one page at a time. The connector
 * side (`fetchTranscript`) walks keyed profiles in config order exactly like
 * the #83 exact-id probe: first profile that answers 200 wins; a 404 is a
 * definitive miss for THAT profile and walks on; a transport failure ends
 * the walk with `gateway_unreachable`.
 *
 * Guards are the EXACT posture of the sibling loopback surfaces
 * (client-hermes.ts / client-projects.ts), all fail-closed:
 *   - Host must be loopback;
 *   - an Origin header must name a loopback origin (CSRF);
 *   - auth: `X-Idlefill-Edit: <arbiter token>` (constant-time); no token
 *     configured ⇒ 401;
 *   - loopback origins get explicit CORS allow headers (cross-port fetch).
 * The gateway's per-profile API key NEVER appears in a response body.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { HermesGatewayConnector, TranscriptResult } from './hermes-gateway.js';

export interface HermesTranscriptOpts {
  /** The arbiter token this client holds (config.json `token`). */
  token: string;
  /** The live connector, or null when the connector is disabled/absent.
   *  A getter (not a value) so the route always sees the boot-time truth. */
  connector: () => HermesGatewayConnector | null;
}

const TRANSCRIPT_PREFIX = '/client/hermes-transcript/';

function loopbackHost(host: string): boolean {
  const h = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  return h === 'localhost' || h.startsWith('127.') || h === '::1';
}

function loopbackOrigin(origin: string): boolean {
  try {
    return loopbackHost(new URL(origin).hostname);
  } catch {
    return false;
  }
}

function tokenEquals(a: string, b: string): boolean {
  const key = 'idlefill-client-hermes-transcript';
  const ha = createHmac('sha256', key).update(a).digest();
  const hb = createHmac('sha256', key).update(b).digest();
  return timingSafeEqual(ha, hb);
}

function corsHeaders(origin: string | undefined): Record<string, string> {
  const h: Record<string, string> = { vary: 'Origin' };
  if (origin && loopbackOrigin(origin)) {
    h['access-control-allow-origin'] = origin;
    h['access-control-allow-credentials'] = 'false';
  }
  return h;
}

/** Answer one transcript verdict: the ok page (200) or the refusal with the
 *  status the connector named. Bounded: the body is at most
 *  TRANSCRIPT_PAGE_MAX sanitized rows (each content-capped). */
function sendVerdict(res: ServerResponse, verdict: TranscriptResult, cors: Record<string, string>): void {
  const body = JSON.stringify(verdict);
  res.writeHead(verdict.ok ? 200 : verdict.status, {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(body)),
    ...cors,
  });
  res.end(body);
}

/**
 * Handle GET (and OPTIONS preflight) on /client/hermes-transcript/<id>.
 * Resolves true when handled (the caller must then NOT passthrough it).
 * `fetchTranscript` never rejects by contract; the caller's `.catch` is
 * belt-and-braces for a seam surprise, mirroring the fire-safe posture of
 * the sibling loopback surfaces.
 */
export async function handleHermesTranscript(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  opts: HermesTranscriptOpts,
): Promise<boolean> {
  if (!url.pathname.startsWith(TRANSCRIPT_PREFIX)) return false;

  const cors = corsHeaders(req.headers.origin);

  // Host guard first — this bind is loopback-only by contract.
  const host = req.headers.host ?? '';
  if (!loopbackHost(host)) {
    res.writeHead(400, { 'content-type': 'application/json', ...cors });
    res.end(JSON.stringify({ ok: false, error: 'Host must be a loopback address', reason: 'bad_host' }));
    return true;
  }
  // CSRF posture: an Origin must name a loopback origin; absent is allowed.
  if (req.headers.origin !== undefined && !loopbackOrigin(req.headers.origin)) {
    res.writeHead(403, { 'content-type': 'application/json', ...cors });
    res.end(JSON.stringify({ ok: false, error: 'cross-origin request refused', reason: 'cross_origin' }));
    return true;
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      ...cors,
      'access-control-allow-methods': 'GET, OPTIONS',
      'access-control-allow-headers': 'content-type, x-idlefill-edit',
      'access-control-max-age': '600',
    });
    res.end();
    return true;
  }

  // Auth: the arbiter token, header-only, fail-closed. The transcript is a
  // READ surface but it is still conversation content — same credential as
  // the sibling editor surfaces. Auth BEFORE the method guard (the EXACT
  // sibling posture: an unauthenticated probe never learns the method shape).
  const edit = req.headers['x-idlefill-edit'];
  if (!opts.token || typeof edit !== 'string' || !tokenEquals(edit, opts.token)) {
    res.writeHead(401, { 'content-type': 'application/json', ...cors });
    res.end(JSON.stringify({
      ok: false,
      error: 'unauthorized',
      reason: 'unauthorized',
      hint: 'X-Idlefill-Edit must carry the arbiter token',
    }));
    return true;
  }

  // GET only (HEAD would pay the full gateway walk to throw the body away —
  // the viewer never asks for it, so the method simply does not exist here).
  if (req.method !== 'GET') {
    res.writeHead(405, { 'content-type': 'application/json', allow: 'GET, OPTIONS', ...cors });
    res.end(JSON.stringify({ ok: false, error: 'method not allowed', reason: 'method_not_allowed' }));
    return true;
  }

  const connector = opts.connector();
  // The connector is not constructed (disabled): a NAMED 503-class refusal,
  // zero gateway requests.
  if (!connector) {
    res.writeHead(503, { 'content-type': 'application/json', ...cors });
    res.end(JSON.stringify({
      ok: false,
      error: 'hermes gateway connector is disabled — transcript unavailable',
      reason: 'connector_disabled',
    }));
    return true;
  }

  let sessionId = url.pathname.slice(TRANSCRIPT_PREFIX.length);
  try {
    sessionId = decodeURIComponent(sessionId);
  } catch {
    /* malformed %xx: pass the raw segment — the connector normalizes/caps */
  }

  const verdict = await connector.fetchTranscript(sessionId, url.searchParams.get('offset'), url.searchParams.get('limit'));
  sendVerdict(res, verdict, cors);
  return true;
}
