/**
 * Fleet service entry point (#55 slice 3).
 *
 * The control plane, never a relay (docs/architecture/fleet-service.md):
 * it answers enrollment and roster queries only. It never sits in the
 * data path. A peer that wants the mesh pulls `GET /roster`, then pulls
 * `/api/mesh` directly from the listed arbiter — over the tailnet.
 *
 * This wave (enrollment + roster + pairing ceremony, #55 D4 shape (b)):
 *   POST /enroll     one-time token + public key + name -> session credential
 *   POST /heartbeat  instance_id + signed nonce + urls[] + presence
 *   GET  /roster     signed nonce -> the full roster (edges as an ADD key)
 *   POST /token      operator: mint an enrollment token (runtime only)
 *   POST /pair/code      signed nonce (B) -> a one-time pairing code
 *   POST /pair/redeem    signed nonce (A) + code -> the directed edge A -> B
 *                        (+ the peer's public key, for A's local edge record)
 *   POST /pair/unpair    signed nonce (an edge end) + edge -> the edge is gone
 *
 * The pairing routes are the edge-FORMATION ceremony (D4): the service
 * records the directed edge and publishes it in the rosters. It never
 * relays control between the two arbiters — each side talks directly,
 * authenticated against its own locally-stored edge record (D1).
 *
 * Deferred (named in the report): deployment (D7 — urza routing, no
 * infra files here), the three PROPOSED D3 cadence values, key rotation
 * (re-pairing is the recovery path, pairing.md open question 3).
 *
 * Deps: `node:http` + `node:sqlite` + `node:crypto` only (D7: dependency-
 * free Node). No server code is imported. No network egress.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import {
  authenticate,
  enroll,
  heartbeat,
  isValidEd25519PublicKey,
  mintPairCode,
  mintToken,
  openStore,
  redeemPairCode,
  roster,
  sanitizePresence,
  sanitizeUrls,
  unpairEdge,
} from './store.js';

const MAX_BODY = 64 * 1024;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

async function parseJson(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const raw = await readBody(req);
  if (raw.trim() === '') return {};
  try {
    const v: unknown = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function send(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

export interface App {
  server: Server;
  /** The SQLite file path (for tests + diagnostics). */
  dbFile: string;
  /** Close the server. */
  close(): Promise<void>;
}

/**
 * Build the fleet HTTP app. `now` is injectable for tests (the token
 * expiry test advances the clock without sleeping).
 */
export function createApp(opts: { dbFile: string; tokenTtlMs: number; pairCodeTtlMs?: number; now?: () => number } = {
  dbFile: ':memory:',
  tokenTtlMs: 15 * 60_000,
  pairCodeTtlMs: 5 * 60_000,
}): App {
  const now = opts.now ?? (() => Date.now());
  const db = openStore(opts.dbFile);

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const q = url.searchParams;
    try {
      // -----------------------------------------------------------------
      // POST /token — operator mints an enrollment token (runtime only).
      // The plaintext token is returned once. Only the hash is stored.
      // -----------------------------------------------------------------
      if (path === '/token' && req.method === 'POST') {
        const { token, expires_at } = mintToken(db, opts.tokenTtlMs, now());
        return send(res, 200, { token, expires_at });
      }

      // -----------------------------------------------------------------
      // POST /enroll — one-time token + public key + name.
      // -----------------------------------------------------------------
      if (path === '/enroll' && req.method === 'POST') {
        const body = await parseJson(req);
        if (!body) return send(res, 400, { error: 'invalid_body' });
        const token = typeof body.token === 'string' ? body.token : '';
        const publicKey = typeof body.public_key === 'string' ? body.public_key : '';
        const name = typeof body.name === 'string' ? body.name : '';
        if (!token || !publicKey || !name) return send(res, 400, { error: 'invalid_body' });
        // Validate the key BEFORE redeeming: a malformed request must not
        // burn the operator's single-use token.
        if (!isValidEd25519PublicKey(publicKey)) {
          return send(res, 400, { error: 'invalid_public_key' });
        }
        const r = enroll(db, { token, public_key: publicKey, name }, now());
        if (!r.ok) {
          const status = r.error === 'invalid_name' ? 400 : 401;
          return send(res, status, { error: r.error });
        }
        return send(res, 200, {
          instance_id: r.instance_id,
          credential: r.credential,
          // ADD key on the response: the first server-issued nonce.
          nonce: r.nonce,
        });
      }

      // Everything below authenticates with a signed nonce (D2 step 3).
      // The auth fields ride the JSON body for a POST (heartbeat) and the
      // query string for a GET (roster). Both carry the same ADD keys.
      const body = await parseJson(req);
      const strField = (k: string): string => {
        if (body && typeof body[k] === 'string') return body[k];
        const v = q.get(k);
        return v === null ? '' : v;
      };
      const authInstanceId = strField('instance_id');
      const authNonce = strField('nonce');
      const authSignature = strField('signature');
      const auth = authenticate(
        db,
        { instance_id: authInstanceId, nonce: authNonce, signature: authSignature },
        now(),
      );
      if (!auth.ok) return send(res, 401, { error: auth.error });

      // -----------------------------------------------------------------
      // POST /heartbeat — urls[] + coarse presence.
      // The authenticated instance_id is authoritative (the signature
      // binds it to the stored public key).
      // -----------------------------------------------------------------
      if (path === '/heartbeat' && req.method === 'POST') {
        if (!body) return send(res, 400, { error: 'invalid_body' });
        // urls / presence are ADD keys: absent = keep the stored value.
        const urls = body.urls === undefined ? null : sanitizeUrls(body.urls);
        if (body.urls !== undefined && urls === null) return send(res, 400, { error: 'invalid_urls' });
        const presence = sanitizePresence(body.presence);
        const ok = heartbeat(db, authInstanceId, urls, presence, now());
        if (!ok) return send(res, 404, { error: 'unknown_instance' });
        return send(res, 200, { ok: true });
      }

      // -----------------------------------------------------------------
      // GET /roster — the full fleet (a PULL, never a push).
      // -----------------------------------------------------------------
      if (path === '/roster' && req.method === 'GET') {
        return send(res, 200, { instances: roster(db) });
      }

      // -----------------------------------------------------------------
      // POST /pair/code (D4 shape (b), PROPOSED) — B mints a one-time
      // pairing code. The code binds to B's instance_id (the
      // authenticated signer) and is stored HASHED, single-use + TTL —
      // the enrollment token's exact posture. The plaintext code is
      // returned once; B hands it to A (the tailnet is the trust
      // boundary, D7). Optional `target_name` (ADD key) is a display
      // hint for A and is never stored.
      // -----------------------------------------------------------------
      if (path === '/pair/code' && req.method === 'POST') {
        const { code, expires_at } = mintPairCode(db, authInstanceId, opts.pairCodeTtlMs ?? 5 * 60_000, now());
        return send(res, 200, { code, ttl_s: Math.round((expires_at - now()) / 1000) });
      }

      // -----------------------------------------------------------------
      // POST /pair/redeem (D4 shape (b), PROPOSED) — A redeems B's code.
      // The authenticated signer is the CONTROLLER (`from`); the minter
      // is the CONTROLLED instance (`to`) — pairing A to B makes A the
      // controller of B (pairing.md D5, directional). The edge row is
      // INSERTed (idempotent) and published in both rosters; the
      // response carries B's public key so A can write its LOCAL edge
      // record immediately (pairing.md D1: the target verifies the
      // requester's signature against the stored peer public key). The
      // service is the directory, never the pipe: after this, A and B
      // talk directly — no relay (mesh.md D1).
      // -----------------------------------------------------------------
      if (path === '/pair/redeem' && req.method === 'POST') {
        if (!body) return send(res, 400, { error: 'invalid_body' });
        const code = typeof body.code === 'string' ? body.code : '';
        if (code.trim() === '') return send(res, 400, { error: 'invalid_body' });
        const r = redeemPairCode(db, code, authInstanceId, now());
        if (!r.ok) {
          // A bad/used/expired code or a self-pair is an operator-side
          // mistake, not an auth failure: 400 with the named reason.
          // (Auth itself — a bad signature, replayed nonce, unknown
          // instance — is the 401 above, before this point.)
          return send(res, 400, { error: r.error });
        }
        return send(res, 200, { edge: r.edge, peer_public_key: r.peer_public_key, peer_name: r.peer_name });
      }

      // -----------------------------------------------------------------
      // POST /pair/unpair (D4, PROPOSED) — remove a directed edge. The
      // caller must be one of the edge's ends. Directional semantics
      // (pairing.md D5): this deletes ONLY the named direction; the
      // reverse is a separate edge. The enforcement point for revocation
      // is the controlled side (pairing.md D6: its operator removes its
      // LOCAL edge record; the next roster pull confirms it is gone) —
      // the service never pushes.
      // -----------------------------------------------------------------
      if (path === '/pair/unpair' && req.method === 'POST') {
        if (!body || !body.edge || typeof body.edge !== 'object' || Array.isArray(body.edge)) {
          return send(res, 400, { error: 'invalid_body' });
        }
        const e = body.edge as Record<string, unknown>;
        const from = typeof e.from === 'string' ? e.from : '';
        const to = typeof e.to === 'string' ? e.to : '';
        if (from.trim() === '' || to.trim() === '') return send(res, 400, { error: 'invalid_body' });
        const r = unpairEdge(db, authInstanceId, from, to);
        if (!r.ok) return send(res, 404, { error: 'unknown_edge' });
        return send(res, 200, { ok: true });
      }

      return send(res, 404, { error: 'not_found' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return send(res, msg === 'body too large' ? 413 : 400, { error: msg });
    }
  });

  return {
    server,
    dbFile: opts.dbFile,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections?.();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

/** Start the service on `listen` (0 = ephemeral). Returns the bound port. */
export async function start(
  listen = 0,
  opts: { dbFile?: string; tokenTtlMs?: number; pairCodeTtlMs?: number } = {},
): Promise<{ app: App; port: number }> {
  const cfg = loadConfig(dirname(fileURLToPath(import.meta.url)));
  const app = createApp({
    dbFile: opts.dbFile ?? cfg.db_file,
    tokenTtlMs: opts.tokenTtlMs ?? cfg.token_ttl_ms,
    pairCodeTtlMs: opts.pairCodeTtlMs ?? cfg.pair_code_ttl_ms,
  });
  // D6: the SQLite file. Ensure the parent directory exists.
  if (app.dbFile !== ':memory:') {
    const dir = dirname(app.dbFile);
    if (dir && dir !== '.' && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
  const port = await new Promise<number>((resolve, reject) => {
    const onErr = (err: Error) => reject(err);
    app.server.once('error', onErr);
    app.server.listen(listen, () => {
      app.server.off('error', onErr);
      const addr = app.server.address();
      resolve(typeof addr === 'object' && addr ? addr.port : 0);
    });
  });
  return { app, port };
}

// Direct-run guard: `tsx src/index.ts` / `node dist/index.js` start the
// service; importing this module (tests) does not.
const isMain = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  const here = fileURLToPath(import.meta.url);
  return resolve(entry) === here;
})();

if (isMain) {
  const cfg = loadConfig(dirname(fileURLToPath(import.meta.url)));
  const { app, port } = await start(cfg.listen, {
    dbFile: cfg.db_file,
    tokenTtlMs: cfg.token_ttl_ms,
    pairCodeTtlMs: cfg.pair_code_ttl_ms,
  });
  console.error(
    `[fleet] listening on :${port} (db=${app.dbFile}) — enrollment + roster + pairing ceremony; the data path stays arbiter-to-arbiter`,
  );
  const shutdown = () => {
    void app.close().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
