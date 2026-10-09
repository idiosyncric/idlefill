/**
 * Fleet service entry point (#55 slice 3).
 *
 * The control plane, never a relay (docs/architecture/fleet-service.md):
 * it answers enrollment and roster queries only. It never sits in the
 * data path. A peer that wants the mesh pulls `GET /roster`, then pulls
 * `/api/mesh` directly from the listed arbiter — over the tailnet.
 *
 * This slice (enrollment + roster):
 *   POST /enroll     one-time token + public key + name -> session credential
 *   POST /heartbeat  instance_id + signed nonce + urls[] + presence
 *   GET  /roster     signed nonce -> the full roster
 *   POST /token      operator: mint an enrollment token (runtime only)
 *
 * Deferred (named in the report): pairing (D4 owner shape pending),
 * deployment (D7 — urza routing, no infra files here), the three PROPOSED
 * D3 cadence values.
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
  mintToken,
  openStore,
  roster,
  sanitizePresence,
  sanitizeUrls,
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
export function createApp(opts: { dbFile: string; tokenTtlMs: number; now?: () => number } = {
  dbFile: ':memory:',
  tokenTtlMs: 15 * 60_000,
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
  opts: { dbFile?: string; tokenTtlMs?: number } = {},
): Promise<{ app: App; port: number }> {
  const cfg = loadConfig(dirname(fileURLToPath(import.meta.url)));
  const app = createApp({
    dbFile: opts.dbFile ?? cfg.db_file,
    tokenTtlMs: opts.tokenTtlMs ?? cfg.token_ttl_ms,
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
  const { app, port } = await start(cfg.listen, { dbFile: cfg.db_file, tokenTtlMs: cfg.token_ttl_ms });
  console.error(
    `[fleet] listening on :${port} (db=${app.dbFile}) — enrollment + roster only; the data path stays arbiter-to-arbiter`,
  );
  const shutdown = () => {
    void app.close().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
