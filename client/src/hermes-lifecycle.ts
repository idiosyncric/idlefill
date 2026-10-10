/**
 * #85 slice G: the operator-driven session LIFECYCLE surface on the client
 * daemon's loopback bind — rename / pin straight from the Sessions row.
 *
 *   PATCH /client/hermes-lifecycle/<session_id>
 *         body: { title?, pinned?, archived?, hidden?, unread? }   (only these)
 *       → { ok: true, profile, session_id, patched: [field names…] }
 *       → { ok: false, error, reason } with a 503-class status when the
 *          connector is disabled, no profile carries a key, the gateway is
 *          unreachable (gateway_unreachable), or the walk answered only
 *          ambiguously — 401/403/5xx (gateway_ambiguous); 404 ONLY when
 *          every keyed profile answered an explicit 404 (session_not_found);
 *          the gateway's own status for a refused write (gateway_rejected);
 *          400 for a malformed id or a disallowed body (invalid_body —
 *          `end_reason` is refused BY NAME, it is deliberately not exposed
 *          this issue).
 *
 * THE SCOPE LAW (the #85 control-slice decision): this route fires ONLY on
 * a deliberate operator gesture — the dashboard's rename/pin click. Nothing
 * automated (no cycle, lease, poll, or timer) may call it; the connector
 * class has no automatic caller. Exactly-once per click: the verb never
 * retries, and this route answers the refusal verbatim rather than
 * resubmitting. The payload is NEVER published — the connector's verdict
 * carries field NAMES only, and nothing enters the enrichment ledger, so
 * no lifecycle write can ever ride the register heartbeat or /api/state.
 *
 * WHY loopback (the editor + slice-A precedent): a lifecycle write belongs
 * to the LOCAL operator at the LOCAL daemon. It never enters the arbiter's
 * wire in any shape (this is not an arbiter API — the arbiter has no
 * lifecycle verb, and the wire discipline stays ADD-keys-only because
 * nothing was added).
 *
 * Guards are the EXACT posture of the sibling loopback surfaces
 * (hermes-transcript.ts / client-hermes.ts / client-projects.ts), all
 * fail-closed:
 *   - Host must be loopback;
 *   - an Origin header must name a loopback origin (CSRF);
 *   - auth: `X-Idlefill-Edit: <arbiter token>` (constant-time); no token
 *     configured ⇒ 401 (auth BEFORE the method guard — an unauthenticated
 *     probe never learns the method shape);
 *   - PATCH/OPTIONS only; loopback origins get explicit CORS allow headers.
 * The gateway's per-profile API key NEVER appears in a response body.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { HermesGatewayConnector, LifecycleResult } from './hermes-gateway.js';

export interface HermesLifecycleOpts {
  /** The arbiter token this client holds (config.json `token`). */
  token: string;
  /** The live connector, or null when the connector is disabled/absent.
   *  A getter (not a value) so the route always sees the boot-time truth. */
  connector: () => HermesGatewayConnector | null;
}

const LIFECYCLE_PREFIX = '/client/hermes-lifecycle/';

/** The patch body is tiny by contract (five scalar fields, title ≤256).
 *  The bound is the client-hermes PUT posture: over it ⇒ 413, nothing read. */
const LIFECYCLE_BODY_MAX = 16 * 1024;

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
  const key = 'idlefill-client-hermes-lifecycle';
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

function sendJson(res: ServerResponse, status: number, payload: unknown, cors: Record<string, string>): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(body)),
    ...cors,
  });
  res.end(body);
}

/**
 * Handle PATCH (and OPTIONS preflight) on /client/hermes-lifecycle/<id>.
 * Resolves true when handled (the caller must then NOT passthrough it).
 * `patchLifecycle` never rejects by contract; the caller's `.catch` is
 * belt-and-braces for a seam surprise, mirroring the fire-safe posture of
 * the sibling loopback surfaces.
 */
export async function handleHermesLifecycle(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  opts: HermesLifecycleOpts,
): Promise<boolean> {
  if (!url.pathname.startsWith(LIFECYCLE_PREFIX)) return false;

  const cors = corsHeaders(req.headers.origin);

  // Host guard first — this bind is loopback-only by contract.
  const host = req.headers.host ?? '';
  if (!loopbackHost(host)) {
    sendJson(res, 400, { ok: false, error: 'Host must be a loopback address', reason: 'bad_host' }, cors);
    return true;
  }
  // CSRF posture: an Origin must name a loopback origin; absent is allowed.
  if (req.headers.origin !== undefined && !loopbackOrigin(req.headers.origin)) {
    sendJson(res, 403, { ok: false, error: 'cross-origin request refused', reason: 'cross_origin' }, cors);
    return true;
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      ...cors,
      'access-control-allow-methods': 'PATCH, OPTIONS',
      'access-control-allow-headers': 'content-type, x-idlefill-edit',
      'access-control-max-age': '600',
    });
    res.end();
    return true;
  }

  // Auth: the arbiter token, header-only, fail-closed. A lifecycle WRITE is
  // the most dangerous surface on this bind — same credential as the
  // sibling editor surfaces, checked BEFORE the method guard.
  const edit = req.headers['x-idlefill-edit'];
  if (!opts.token || typeof edit !== 'string' || !tokenEquals(edit, opts.token)) {
    sendJson(
      res,
      401,
      { ok: false, error: 'unauthorized', reason: 'unauthorized', hint: 'X-Idlefill-Edit must carry the arbiter token' },
      cors,
    );
    return true;
  }

  // PATCH only (GET would invite automation; the dashboard's click is a
  // PATCH, and nothing else may fire this verb).
  if (req.method !== 'PATCH') {
    res.writeHead(405, { 'content-type': 'application/json', allow: 'PATCH, OPTIONS', ...cors });
    res.end(JSON.stringify({ ok: false, error: 'method not allowed', reason: 'method_not_allowed' }));
    return true;
  }

  const connector = opts.connector();
  // The connector is not constructed (disabled): a NAMED 503-class refusal,
  // zero gateway requests, and the upload is drained so the socket closes.
  if (!connector) {
    req.resume();
    sendJson(res, 503, {
      ok: false,
      error: 'hermes gateway connector is disabled — lifecycle unavailable',
      reason: 'connector_disabled',
    }, cors);
    return true;
  }

  let sessionId = url.pathname.slice(LIFECYCLE_PREFIX.length);
  try {
    sessionId = decodeURIComponent(sessionId);
  } catch {
    /* malformed %xx: pass the raw segment — the connector normalizes/caps */
  }

  // Read the (tiny, bounded) JSON body, then one walk, one verdict. No
  // body-size games beyond the cap: over it ⇒ 413 fail-closed.
  const chunks: Buffer[] = [];
  let size = 0;
  let over = false;
  req.on('data', (c: Buffer) => {
    size += c.length;
    if (size > LIFECYCLE_BODY_MAX) {
      over = true;
      req.destroy();
    } else chunks.push(c);
  });
  req.on('end', () => {
    if (over) {
      sendJson(res, 413, { ok: false, error: 'body too large', reason: 'body_too_large' }, cors);
      return;
    }
    let body: unknown;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
    } catch {
      sendJson(res, 400, { ok: false, error: 'invalid JSON body', reason: 'invalid_body' }, cors);
      return;
    }
    void connector
      .patchLifecycle(sessionId, body)
      .then((verdict: LifecycleResult) => sendJson(res, verdict.ok ? 200 : verdict.status, verdict, cors))
      .catch(() => {
        // Contractually unreachable (patchLifecycle never rejects); answer
        // the fail-closed shape if a seam surprise ever gets here.
        if (!res.headersSent) {
          sendJson(res, 500, { ok: false, error: 'lifecycle verb failed unexpectedly', reason: 'internal' }, cors);
        } else {
          try {
            res.end();
          } catch {
            /* raced with socket teardown */
          }
        }
      });
  });
  req.on('error', () => {
    /* aborted upload — nothing to answer */
  });
  return true;
}
