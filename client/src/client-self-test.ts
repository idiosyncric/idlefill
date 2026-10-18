/**
 * Egress self-test: the loopback ACTIVE-probe surface on the client daemon's
 * proxy bind — the answer to "does THIS machine's network actually work".
 *
 *   POST /client/egress-test   → { at, ok, results: [ {kind, …} ] }
 *
 * Why this exists (2026-10-18, live): the hypnotist machine's outbound
 * sockets were silently DENIED by a local firewall while every dashboard
 * tile stayed green — the arbiter's view of the engines came from the
 * ENGINES' own registrations, and the client's only testimony was a 502
 * inside each agent's session log. Nothing in the GUI could say "this
 * machine cannot reach its engines" until an agent hit it. This route asks
 * the question directly, from the only process whose egress matters (the
 * forwarding daemon itself): one bounded GET per engine row + the arbiter,
 * answerable with NO agent traffic, on demand, from the dashboard.
 *
 * Verdict rule (the honest one): ANY HTTP response — even 401/404 — proves
 * the egress PATH (socket + TLS + the peer's HTTP stack). A connection-level
 * errno (EHOSTUNREACH, EACCES, ETIMEDOUT, …) is the exception and names
 * itself. The probe never needs a credential and carries none.
 *
 * Guards (EXACT posture of the sibling surfaces — fail-closed):
 *   - Host: loopback only;
 *   - Origin (CSRF): a present Origin must name a loopback origin;
 *   - Auth: `X-Idlefill-Edit: <arbiter token>`, constant-time; no token
 *     configured ⇒ 401 (an empty header never "matches" an empty config);
 *   - CORS: loopback origins get explicit allow headers (cross-port fetch);
 *   - POST only (the probe is an explicit "run it now" verb; a stray GET
 *     never fires sockets at engines) + OPTIONS preflight for the page.
 *
 * The probe is READ-ONLY on every target (a GET /v1/models against an
 * engine, GET / against the arbiter): no engine state changes, no job,
 * no lease, no session. Bounded per probe (timeout) and per run (targets
 * capped) — a self-test must never become the thing that degrades the
 * machine.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import http from 'node:http';
import https from 'node:https';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { engineBase } from './aggregate.js';

export interface SelfTestTarget {
  server_id: string;
  url: string;
}

export interface SelfTestOpts {
  /** The arbiter token this client holds (config.json `token`). */
  token: string;
  /** Live probe list, computed AT CLICK time (never a boot snapshot):
   *  the arbiter URL, the aggregate's engine rows, and the machine's
   *  default llm_target (loopback, still worth a line — it is where
   *  unknown-model traffic lands). */
  targets: () => { arbiter: string; engines: SelfTestTarget[]; default_target?: string };
  /** Per-probe timeout in ms (test seam; default SELF_TEST_TIMEOUT_MS). */
  timeoutMs?: number;
  /** Total targets probed per run (test seam; default SELF_TEST_TARGET_CAP). */
  cap?: number;
}

export const SELF_TEST_PATH = '/client/egress-test';
/** One engine's /v1/models answers in tens of ms when the path exists; 5 s
 *  distinguishes "path works" from "no route/firewall blackhole" honestly. */
export const SELF_TEST_TIMEOUT_MS = 5_000;
/** Rows per machine are few (single digits); 32 bounds a pathological
 *  catalog without ever trimming a real fleet. */
export const SELF_TEST_TARGET_CAP = 32;

/** One probe result. `ok: true` carries the HTTP status (any status = path
 *  proven); `ok: false` carries the errno `code` (or 'TIMEOUT'). */
export interface SelfTestResult {
  kind: 'arbiter' | 'engine' | 'target';
  label: string;
  url: string;
  ok: boolean;
  status?: number;
  code?: string;
  ms: number;
}

/** Loopback hostname test (same rule as the sibling surfaces). */
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

/** Constant-time compare of the edit token (the client-hermes digest rule). */
function tokenEquals(a: string, b: string): boolean {
  const key = 'idlefill-client-selftest';
  const ha = createHmac('sha256', key).update(a).digest();
  const hb = createHmac('sha256', key).update(b).digest();
  return timingSafeEqual(ha, hb);
}

/** Loopback-allow CORS headers (the page's cross-port fetch). */
function corsHeaders(origin: string | undefined): Record<string, string> {
  const h: Record<string, string> = { vary: 'Origin' };
  if (origin && loopbackOrigin(origin)) {
    h['access-control-allow-origin'] = origin;
    h['access-control-allow-credentials'] = 'false';
  }
  return h;
}

/** Derive the probe URL for one engine row: origin (+ path prefix) + the
 *  plain `/v1/models` read. Unparseable urls answer as-is. */
export function probeUrlFor(url: string): string {
  try {
    new URL(url);
  } catch {
    return url;
  }
  return `${engineBase(url)}/v1/models`;
}

/**
 * One bounded probe: GET `url`, resolve on ANY response (status is data,
 * not verdict), reject-free. Never throws; never carries a credential.
 */
export type ProbeOutcome = { ok: boolean; status?: number; code?: string; ms: number };

export function probeTarget(url: string, timeoutMs: number): Promise<ProbeOutcome> {
  return new Promise((resolveProbe) => {
    const started = Date.now();
    let settled = false;
    const settle = (r: { ok: boolean; status?: number; code?: string }): void => {
      if (settled) return;
      settled = true;
      resolveProbe({ ...r, ms: Date.now() - started });
    };
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      settle({ ok: false, code: 'ERR_INVALID_URL' });
      return;
    }
    const transport = u.protocol === 'https:' ? https : http;
    let req: http.ClientRequest;
    try {
      req = transport.request(
        {
          protocol: u.protocol,
          hostname: u.hostname,
          port: u.port || (u.protocol === 'https:' ? 443 : 80),
          path: u.pathname === '' ? '/' : u.pathname,
          method: 'GET',
          timeout: timeoutMs,
        },
        (res) => {
          const status = res.statusCode ?? 0;
          res.resume(); // drain so the socket closes clean
          settle({ ok: true, status });
        },
      );
    } catch {
      settle({ ok: false, code: 'ERR_INVALID_URL' });
      return;
    }
    req.on('timeout', () => {
      req.destroy(); // no response inside the window — a blackhole is an exception
      settle({ ok: false, code: 'ETIMEDOUT' });
    });
    req.on('error', (err) => settle({ ok: false, code: (err as NodeJS.ErrnoException).code ?? 'ERR' }));
    req.end();
  });
}

/**
 * Handle POST / OPTIONS on /client/egress-test. Returns true when the
 * request was handled (the caller must then NOT passthrough it). The probe
 * run is async: every guard answers synchronously, then the walk answers
 * the response itself (fire-safe — the caller wraps with the same
 * seam-surprise catch the transcript surface uses).
 */
export function handleClientSelfTest(req: IncomingMessage, res: ServerResponse, url: URL, opts: SelfTestOpts): boolean {
  if (url.pathname !== SELF_TEST_PATH) return false;
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
  // CORS preflight (the page's cross-port fetch asks first for POST).
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
  // Auth: the arbiter token, header-only. Fail closed without it — BEFORE
  // any socket opens (an unauthenticated request must never aim the probe).
  const edit = req.headers['x-idlefill-edit'];
  if (!opts.token || typeof edit !== 'string' || !tokenEquals(edit, opts.token)) {
    res.writeHead(401, { 'content-type': 'application/json', ...cors });
    res.end(JSON.stringify({ error: 'unauthorized', hint: 'X-Idlefill-Edit must carry the arbiter token' }));
    return true;
  }
  if (req.method !== 'POST') {
    res.writeHead(405, { 'content-type': 'application/json', allow: 'POST, OPTIONS', ...cors });
    res.end(JSON.stringify({ error: 'method not allowed — the egress test is an explicit POST' }));
    return true;
  }

  const timeoutMs = opts.timeoutMs ?? SELF_TEST_TIMEOUT_MS;
  const cap = opts.cap ?? SELF_TEST_TARGET_CAP;
  // Targets are read at CLICK time (fresh catalog), then bounded. A seam
  // failure here answers LOUD (500) — it must never crash the daemon and
  // never fall through to the LLM target.
  let t: { arbiter: string; engines: SelfTestTarget[]; default_target?: string };
  try {
    t = opts.targets();
  } catch (err) {
    res.writeHead(500, { 'content-type': 'application/json', ...cors });
    res.end(JSON.stringify({ error: `targets unavailable: ${err instanceof Error ? err.message : err}` }));
    return true;
  }
  const plan: { kind: SelfTestResult['kind']; label: string; url: string }[] = [
    { kind: 'arbiter', label: 'arbiter', url: t.arbiter },
  ];
  if (typeof t.default_target === 'string' && t.default_target !== '') {
    plan.push({ kind: 'target', label: 'llm_target', url: t.default_target });
  }
  for (const e of t.engines.slice(0, cap)) plan.push({ kind: 'engine', label: e.server_id, url: probeUrlFor(e.url) });

  void Promise.all(plan.slice(0, cap).map(async (p) => ({ ...p, ...(await probeTarget(p.url, timeoutMs)) })))
    .then((results) => {
      res.writeHead(200, { 'content-type': 'application/json', ...cors });
      res.end(
        JSON.stringify({
          at: Date.now(),
          ok: results.every((r) => r.ok),
          results,
        }),
      );
    })
    .catch(() => {
      // probeTarget never rejects and plan is fixed-size — this only covers
      // a raced socket teardown mid-answer (the transcript surface's rule).
      try {
        res.destroy();
      } catch {
        /* ignore */
      }
    });
  return true;
}
