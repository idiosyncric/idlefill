/**
 * Fake arbiter for client tests: an in-process HTTP server on an ephemeral
 * 127.0.0.1 port implementing the minimal arbiter API surface the client
 * uses, plus a WS endpoint that can push `revoked` events. No network
 * access — everything is loopback.
 *
 * `override` steers the client-pause/force behavior: it is what
 * GET /api/state reports in clients[].override, and the
 * /api/clients/:id/override route updates it (so tests can drive the
 * daemon the same way the real control script does).
 */

import http from 'node:http';
import { AddressInfo } from 'node:net';
import { WebSocketServer, WebSocket } from 'ws';

export interface UsageReport {
  lease_id: string;
  body: Record<string, unknown>;
}

export interface FakeArbiter {
  url: string;
  /** Flip idle/busy (drives the client's grant decisions). */
  idle: boolean;
  /** Leases the client has requested. */
  leaseRequests: { project: string; job_id: string; client_id: string; estimated_seconds?: number }[];
  /** Usage/finish reports in order. */
  usageReports: UsageReport[];
  /** Currently active lease ids (mirrors what GET /api/state reports). */
  activeLeases: string[];
  /** Operator override reported in GET /api/state clients[] (null = none). */
  override: { override: string; until: number | null } | null;
  /**
   * Test seam: cap the number of GRANTS per job_id. A lease POST for a job
   * already at its cap is denied (409) regardless of idle — the deterministic
   * way to stop the daemon's immediate retry of a failed job (the old
   * "flip idle=false when the failure report lands" raced the 50ms poll and
   * occasionally let a second grant through, burning attempts: 2).
   */
  denyLeaseAfter: Map<string, number>;
  /** The most recent POST /api/clients/register body (heartbeat with queue depths). */
  lastRegister: Record<string, unknown>;
  /** Every register body received, in order. */
  registers: Record<string, unknown>[];
  /** Every POST /api/sessions/register body received, in order (issue #9). */
  sessionRegisters: Record<string, unknown>[];
  /** Session overrides keyed by token (what /api/state reports in sessions[]). */
  sessionOverrides: Map<string, { override: string; until: number | null }>;
  /** Steer the override directly (the POST /api/clients/:id/override route does this too). */
  setOverride(kind: 'pause' | 'force' | null, until?: number): void;
  /** Steer a SESSION override directly (mirrors POST /api/sessions/:token/override). */
  setSessionOverride(token: string, kind: 'pause' | 'force' | null, until?: number): void;
  grant(leaseId: string): void;
  revoke(leaseId: string, reason: string): void;
  nextLeaseId(): string;
  close(): Promise<void>;
}

export function startFakeArbiter(): Promise<FakeArbiter> {
  const state = {
    idle: true,
    override: null as { override: string; until: number | null } | null,
    leaseRequests: [] as { project: string; job_id: string; client_id: string; estimated_seconds?: number }[],
    usageReports: [] as UsageReport[],
    activeLeases: [] as string[],
    denyLeaseAfter: new Map<string, number>(),
    grantsByJob: new Map<string, number>(),
    n: 0,
    registered: false,
    registers: [] as Record<string, unknown>[],
    sessionRegisters: [] as Record<string, unknown>[],
    sessionTokens: new Set<string>(),
    sessionOverrides: new Map<string, { override: string; until: number | null }>(),
    clients: new Set<WebSocket>(),
  };

  const wss = new WebSocketServer({ noServer: true });
  wss.on('connection', (ws) => {
    state.clients.add(ws);
    ws.on('close', () => state.clients.delete(ws));
    ws.on('error', () => {});
  });

  const server = http.createServer((req, res) => {
    const send = (status: number, obj: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://x');
      const j = body ? JSON.parse(body) : {};

      if (req.method === 'POST' && url.pathname === '/api/clients/register') {
        state.registers.push(j);
        state.registered = true;
        return send(200, { client_id: 'c-test', created: state.registered && state.registers.length === 1 });
      }
      // Sessions (issue #9): register is idempotent by token (201 created /
      // 200 refresh), override set/clear per token — mirrors the real
      // arbiter's /api/sessions surface.
      if (req.method === 'POST' && url.pathname === '/api/sessions/register') {
        state.sessionRegisters.push(j);
        const token = typeof j.token === 'string' ? j.token.trim() : '';
        if (!token) return send(400, { error: 'token required' });
        const created = !state.sessionTokens.has(token);
        state.sessionTokens.add(token);
        return send(created ? 201 : 200, { created, session: { token } });
      }
      const sov = url.pathname.match(/^\/api\/sessions\/([^/]+)\/override$/);
      if (req.method === 'POST' && sov) {
        const token = decodeURIComponent(sov[1]!);
        if (!state.sessionTokens.has(token)) return send(404, { error: 'unknown_session' });
        const kind = j.override === null ? null : String(j.override);
        if (kind === null) state.sessionOverrides.delete(token);
        else state.sessionOverrides.set(token, { override: kind, until: typeof j.until === 'number' ? j.until : null });
        return send(200, { ok: true, override: state.sessionOverrides.get(token) ?? null });
      }
      const ov = url.pathname.match(/^\/api\/clients\/[^/]+\/override$/);
      if (req.method === 'POST' && ov) {
        const kind = j.override === null ? null : String(j.override);
        state.override = kind === null ? null : { override: kind, until: typeof j.until === 'number' ? j.until : null };
        return send(200, { ok: true, client: 'test-client', override: state.override });
      }
      if (req.method === 'GET' && url.pathname === '/api/state') {
        return send(200, {
          now: Date.now(),
          idle: { idle: state.idle, degraded: false, reidle_gated: false },
          active_leases: state.activeLeases.map((id) => ({ lease_id: id })),
          clients: [{ client_id: 'c-test', name: 'test-client', ip: '100.94.165.102', override: state.override }],
          sessions: [...state.sessionTokens].map((token) => ({
            token,
            override: state.sessionOverrides.get(token) ?? null,
          })),
        });
      }
      if (req.method === 'POST' && url.pathname === '/api/leases') {
        state.leaseRequests.push({
          project: j.project,
          job_id: j.job_id,
          client_id: j.client_id,
          estimated_seconds: j.estimated_seconds,
        });
        if (!state.idle) return send(409, { reason: 'not_idle' });
        // Per-job grant cap (test seam): a job at its cap is denied even
        // while idle, so tests that must observe exactly ONE attempt are
        // deterministic instead of racing the daemon's 50ms re-poll.
        const cap = state.denyLeaseAfter.get(j.job_id);
        if (cap !== undefined) {
          const g = (state.grantsByJob.get(j.job_id) ?? 0) + 1;
          state.grantsByJob.set(j.job_id, g);
          if (g > cap) return send(409, { reason: 'test_grant_cap' });
        }
        const lease_id = `l-fake-${++state.n}`;
        state.activeLeases.push(lease_id);
        return send(201, { lease_id, client_id: j.client_id, project: j.project, job_id: j.job_id, granted_at: Date.now(), expires_at: Date.now() + 1800_000, ttl_seconds: 1800 });
      }
      const m = url.pathname.match(/^\/api\/leases\/([^/]+)\/usage$/);
      if (req.method === 'POST' && m) {
        state.usageReports.push({ lease_id: m[1]!, body: j });
        const id = m[1]!;
        state.activeLeases = state.activeLeases.filter((x) => x !== id);
        return send(200, { ok: true });
      }
      return send(404, { error: `no route ${req.method} ${url.pathname}` });
    });
  });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname !== '/api/leases/events') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        get idle() {
          return state.idle;
        },
        set idle(v: boolean) {
          state.idle = v;
        },
        get override() {
          return state.override;
        },
        setOverride(kind: 'pause' | 'force' | null, until?: number) {
          state.override = kind === null ? null : { override: kind, until: until ?? null };
        },
        leaseRequests: state.leaseRequests,
        usageReports: state.usageReports,
        activeLeases: state.activeLeases,
        denyLeaseAfter: state.denyLeaseAfter,
        registers: state.registers,
        sessionRegisters: state.sessionRegisters,
        sessionOverrides: state.sessionOverrides,
        get lastRegister() {
          return state.registers[state.registers.length - 1] ?? {};
        },
        setSessionOverride(token: string, kind: 'pause' | 'force' | null, until?: number) {
          state.sessionTokens.add(token);
          if (kind === null) state.sessionOverrides.delete(token);
          else state.sessionOverrides.set(token, { override: kind, until: until ?? null });
        },
        grant(id) {
          state.activeLeases.push(id);
        },
        revoke(id, reason) {
          state.activeLeases = state.activeLeases.filter((x) => x !== id);
          const msg = JSON.stringify({ type: 'revoked', lease_id: id, reason });
          for (const ws of state.clients) {
            if (ws.readyState === WebSocket.OPEN) ws.send(msg);
          }
        },
        nextLeaseId() {
          return `l-fake-${state.n + 1}`;
        },
        close: () =>
          new Promise<void>((r) => {
            for (const ws of state.clients) ws.terminate();
            wss.close();
            server.close(() => r());
          }),
      });
    });
  });
}
