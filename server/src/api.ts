/**
 * Fastify routes for the arbiter.
 *
 * Auth: every API route requires a token from config `api_tokens` via
 * Auth: every API route requires one of the configured tokens, presented either as the Bearer
 * credential in the Authorization header or as a `token` query parameter.
 * the same way. The dashboard page itself is unauthenticated in phase 1
 * (documented in README); `/api/state` is a read-only endpoint that is
 * public ONLY when the request carries no token at all — if a token is
 * present and wrong, it is rejected (401). This matches the spec's
 * "dashboard itself is unauthenticated read-only state" while keeping the
 * authenticated API surface strict.
 */

import { existsSync, readFileSync } from 'node:fs';
import fastify, { type FastifyInstance } from 'fastify';
import { WebSocketServer } from 'ws';
import type { Arbiter } from './arbiter.js';
import type { ServerConfig } from './types.js';

export interface ApiDeps {
  arbiter: Arbiter;
  cfg: ServerConfig;
  /** Path to the static dashboard. */
  publicDir: string;
}

/** Validate a request token against the configured set. */
export function isValidToken(cfg: ServerConfig, token: string | null | undefined): boolean {
  if (!token || typeof token !== 'string') return false;
  return cfg.api_tokens.includes(token);
}

/**
 * Parse a `limit` query param (1..500, default 10) for history windows.
 * Tolerates both Fastify query shapes (parsed object or raw query string).
 */
function queryLimit(req: { query: unknown }): number {
  let v: unknown = null;
  const q = req.query;
  if (typeof q === 'string') v = new URLSearchParams(q).get('limit');
  else if (q !== null && typeof q === 'object') v = (q as Record<string, unknown>).limit;
  const n = typeof v === 'string' ? Number.parseInt(v, 10) : Number.NaN;
  return Number.isInteger(n) && n >= 1 ? Math.min(500, n) : 10;
}

function bearer(req: { headers: Record<string, unknown>; query: unknown }): string | null {
  const h = req.headers['authorization'];
  if (typeof h === 'string' && h.toLowerCase().startsWith('bearer ')) return h.slice(7).trim();
  const q = (typeof req.query === 'object' && req.query !== null ? req.query : {}) as Record<string, unknown>;
  if (typeof q.token === 'string' && q.token.length > 0) return q.token;
  return null;
}

/** Attach the API routes (authed) and the dashboard (public read). */
export function buildApi(deps: ApiDeps): FastifyInstance {
  const { arbiter, cfg, publicDir } = deps;

  const app = fastify({ logger: false });
  app.decorate('idlefill', { arbiter, cfg, publicDir });

  // --- auth guard for /api/* (except the documented public read paths) ---
  app.addHook('onRequest', async (req, reply) => {
    if (!req.raw.url?.startsWith('/api/')) return;
    const token = bearer(req);
    // Public read paths: none by design, EXCEPT /api/state when the caller
    // presents no token at all (anonymous dashboard poll). A wrong token on
    // ANY /api/* path is a 401.
    const isAnonymousState = req.url === '/api/state' && req.method === 'GET' && token === null;
    if (isAnonymousState) return;
    if (!isValidToken(cfg, token)) {
      await reply.code(401).send({ error: 'unauthorized', hint: 'present a valid token (Authorization: Bearer or ?token=)' });
      return;
    }
  });

  // ------------------------------------------------------------------
  // Clients
  // ------------------------------------------------------------------

  app.post('/api/clients/register', async (req, reply) => {
    const body = (req.body ?? {}) as { name?: string; ip?: string };
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) return reply.code(400).send({ error: 'name required' });
    const remote = (req.ip ?? '').split(':').pop() ?? 'unknown';
    const res = arbiter.registerClient(name, typeof body.ip === 'string' && body.ip.trim() ? body.ip.trim() : undefined, remote);
    return reply.code(200).send({ client_id: res.client_id, created: res.created });
  });

  /**
   * Operator override for a client: { override: "pause" | "force" | null,
   * until?: epoch_ms }. `null` clears it. `until` (future) makes it auto-expire.
   * Addressed by client name or client_id. 404 for an unknown client.
   */
  app.post('/api/clients/:ref/override', async (req, reply) => {
    const ref = decodeURIComponent((req.params as { ref: string }).ref);
    const body = (req.body ?? {}) as { override?: 'pause' | 'force' | null; until?: number };
    if (!ref.trim()) return reply.code(400).send({ error: 'client reference required' });
    const ov = body.override;
    if (ov !== 'pause' && ov !== 'force' && ov !== null) {
      return reply.code(400).send({ error: 'override must be "pause", "force", or null (clear)' });
    }
    const until = typeof body.until === 'number' && Number.isFinite(body.until) ? body.until : undefined;
    const res = arbiter.setClientOverride(ref.trim(), ov, until);
    if (!res.ok) return reply.code(404).send({ error: res.reason ?? 'unknown_client' });
    return { ok: true, client: res.client_name, override: res.override ?? null };
  });

  // ------------------------------------------------------------------
  // Leases
  // ------------------------------------------------------------------

  app.get('/api/leases', async (req) => {
    return { leases: arbiter.recentLeases(50), active: arbiter.activeLeases() };
  });

  app.post('/api/leases', async (req, reply) => {
    const body = (req.body ?? {}) as {
      client_id?: string;
      project?: string;
      job_id?: string;
      estimated_seconds?: number;
    };
    if (!body.client_id || !body.project || !body.job_id) {
      return reply.code(400).send({ error: 'client_id, project and job_id are required' });
    }
    const clientExists = arbiter.clientIp(body.client_id) !== null;
    if (!clientExists) {
      return reply.code(409).send({ reason: 'unknown_client' });
    }
    const res = arbiter.requestLease({
      client_id: body.client_id,
      project: String(body.project),
      job_id: String(body.job_id),
      estimated_seconds: typeof body.estimated_seconds === 'number' ? body.estimated_seconds : 0,
    });
    if (!res.ok || !res.lease) {
      return reply.code(409).send({ reason: res.reason ?? 'unknown' });
    }
    return reply.code(201).send({
      lease_id: res.lease.lease_id,
      client_id: res.lease.client_id,
      project: res.lease.project,
      job_id: res.lease.job_id,
      granted_at: res.lease.granted_at,
      expires_at: res.lease.expires_at,
      ttl_seconds: Math.round((res.lease.expires_at - res.lease.granted_at) / 1000),
    });
  });

  app.post('/api/leases/:id/usage', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as {
      tokens_out?: number;
      tokens_in?: number;
      ok?: boolean;
      error?: string;
    };
    const res = arbiter.finishLease({
      lease_id: id,
      tokens_out: typeof body.tokens_out === 'number' ? body.tokens_out : 0,
      tokens_in: typeof body.tokens_in === 'number' ? body.tokens_in : 0,
      ok: body.ok !== false,
      error: typeof body.error === 'string' ? body.error : undefined,
    });
    if (!res.ok) return reply.code(404).send({ error: res.reason ?? 'unknown_lease' });
    return { ok: true, lease: { lease_id: id, tokens_out: res.lease?.tokens_out, tokens_in: res.lease?.tokens_in, status: res.lease?.status } };
  });

  // ------------------------------------------------------------------
  // Projects
  // ------------------------------------------------------------------

  app.get('/api/projects', async () => {
    const day = new Date().toISOString().slice(0, 10);
    return {
      projects: cfg.projects.map((p) => ({ ...p, budget_today: arbiter.projectBudget(p.name, day) })),
    };
  });

  app.post('/api/projects/:name', async (req, reply) => {
    const { name } = req.params as { name: string };
    const body = (req.body ?? {}) as { paused?: boolean };
    if (typeof body.paused !== 'boolean') return reply.code(400).send({ error: 'paused (boolean) required' });
    const res = arbiter.setProjectPaused(name, body.paused);
    if (!res.ok) return reply.code(404).send({ error: res.reason ?? 'unknown_project' });
    const p = cfg.projects.find((x) => x.name === name)!;
    return { ok: true, name, paused: p.paused };
  });

  // ------------------------------------------------------------------
  // State (public read when anonymous; token-authed otherwise)
  // ------------------------------------------------------------------

  app.get('/api/state', async (req) => {
    // Note: the onRequest hook already 401'd a wrong token here; an anonymous
    // or correctly-tokened request reaches this handler.
    const s = arbiter['store'].state;
    const now = Date.now();
    const active = arbiter.activeLeases();
    const day = new Date().toISOString().slice(0, 10);
    const sig = arbiter['detector'].signal(now);
    const lastAct = s.last_activity;
    const lastActAgo = lastAct ? Math.max(0, Math.round((now - lastAct.ts) / 1000)) : null;
    const limit = queryLimit(req);

    return {
      now,
      idle: {
        idle: sig.idle,
        idle_seconds: cfg.idle_seconds,
        degraded: s.signal_degraded,
        degraded_reason: s.degraded_reason,
        reidle_gated: arbiter.reidleGated(),
        last_activity: lastAct ? { ...lastAct, age_s: lastActAgo } : null,
        last_log_write: s.last_log_write,
        last_log_write_age_s: s.last_log_write ? Math.max(0, Math.round((now - s.last_log_write) / 1000)) : null,
        idle_for_s: sig.idle_for_s,
      },
      leases: arbiter.recentLeases(limit),
      active_leases: active,
      // Client rows carry their active operator override (if any), so the
      // dashboard and clients can see pause/force state without a second call.
      clients: s.clients.map((c) => ({ ...c, override: arbiter.activeOverride(c.client_id, now) })),
      projects: cfg.projects.map((p) => ({ ...p, budget_today: arbiter.projectBudget(p.name, day) })),
      events: s.events.slice(Math.max(0, s.events.length - limit)).reverse(),
    };
  });

  // ------------------------------------------------------------------
  // Dashboard (static, public read in phase 1)
  // ------------------------------------------------------------------

  app.get('/', async (_req, reply) => {
    const file = `${publicDir}/index.html`;
    if (!existsSync(file)) return reply.code(500).send('dashboard missing (public/index.html)');
    return reply.type('text/html; charset=utf-8').send(readFileSync(file, 'utf-8'));
  });

  return app;
}

/**
 * Attach a WebSocketServer to the Fastify server's underlying http server on
 * /api/leases/events. Handshake validates the token (query `token` or
 * `Sec-WebSocket-Protocol`-independent; the client uses ?token=).
 *
 * Events pushed: {type:"revoked", lease_id, project, reason} and
 * {type:"lease", ...} (grants). One connection per client.
 */
export function attachWebSocket(app: FastifyInstance, arbiter: Arbiter, cfg: ServerConfig): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  app.server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname !== '/api/leases/events') {
      socket.destroy();
      return;
    }
    const token = url.searchParams.get('token');
    if (!isValidToken(cfg, token)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws) => {
    // Ping/pong keepalive (clients that die on the wire get reaped).
    const w = ws as WebSocket & { isAlive?: boolean };
    w.isAlive = true;
    w.on('pong', () => {
      w.isAlive = true;
    });
    w.on('error', () => {});
  });

  const interval = setInterval(() => {
    for (const ws of wss.clients) {
      const w = ws as WebSocket & { isAlive?: boolean };
      if (w.isAlive === false) {
        w.terminate();
        continue;
      }
      w.isAlive = false;
      try {
        w.ping();
      } catch {
        /* ignore */
      }
    }
  }, 30000);
  interval.unref?.();
  wss.on('close', () => clearInterval(interval));

  /** Push an event to ALL connected clients (fan-out is small). */
  const broadcast = (obj: unknown) => {
    const data = JSON.stringify(obj);
    for (const ws of wss.clients) {
      if (ws.readyState === 1) ws.send(data);
    }
  };

  // Revoke events are pushed by index.ts via this handle.
  (app as unknown as Record<string, unknown>).broadcastWs = broadcast;

  return wss;
}

import type { WebSocket } from 'ws';
