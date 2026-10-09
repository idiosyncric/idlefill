/**
 * Fleet config loading + defaults (#55 slice 3).
 *
 * Mirrors the arbiter's config posture (server/src/config.ts):
 *   1. FLEET_CONFIG env — a JSON string (used by the container).
 *   2. config.json next to the entry point.
 *
 * Every field has a default so a bare dev run works out of the box.
 * `fleet/config.json` is gitignored — it carries deployment values,
 * never a secret (enrollment tokens are minted at runtime only).
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface FleetConfig {
  /** Port to listen on. Tailnet-only reach is enforced by the host (D7). */
  listen: number;
  /** The SQLite file (D6: a file, not a server). */
  db_file: string;
  /** Enrollment token TTL in ms (D2 LOCKED: 15 min default, configurable). */
  token_ttl_ms: number;
  /** Pairing code TTL in ms (D4 shape (b), PROPOSED: 5 min default, configurable). */
  pair_code_ttl_ms: number;
}

export const DEFAULTS: FleetConfig = {
  listen: 8789,
  db_file: process.env.FLEET_DB || './fleet.db',
  // D2 LOCKED: a one-time enrollment token is valid for 15 minutes.
  token_ttl_ms: 15 * 60_000,
  // D4 shape (b) PROPOSED: a pairing code is valid for 5 minutes.
  pair_code_ttl_ms: 5 * 60_000,
};

/** Coerce a raw (partial) config object into a full FleetConfig, applying defaults per field. */
export function applyDefaults(raw: Partial<FleetConfig> | null | undefined): FleetConfig {
  const r = raw ?? {};
  const listen = num(r.listen, DEFAULTS.listen);
  const tokenTtl = num(r.token_ttl_ms, DEFAULTS.token_ttl_ms);
  const pairCodeTtl = num(r.pair_code_ttl_ms, DEFAULTS.pair_code_ttl_ms);
  return {
    listen: listen > 0 && listen < 65536 ? listen : DEFAULTS.listen,
    db_file: str(r.db_file, DEFAULTS.db_file),
    // A non-positive TTL is nonsense — fall back to the default.
    token_ttl_ms: tokenTtl > 0 ? tokenTtl : DEFAULTS.token_ttl_ms,
    pair_code_ttl_ms: pairCodeTtl > 0 ? pairCodeTtl : DEFAULTS.pair_code_ttl_ms,
  };
}

export function loadConfig(
  entryDir: string = dirname(fileURLToPath(import.meta.url)),
  env: NodeJS.ProcessEnv = process.env,
): FleetConfig {
  let raw: Record<string, unknown> | null = null;

  const envJson = env.FLEET_CONFIG;
  if (envJson && envJson.trim()) {
    try {
      raw = JSON.parse(envJson);
    } catch (err) {
      throw new Error(`FLEET_CONFIG is not valid JSON: ${err}`);
    }
  } else {
    for (const candidate of [join(entryDir, 'config.json'), join(entryDir, '..', 'config.json')]) {
      if (existsSync(candidate)) {
        try {
          raw = JSON.parse(readFileSync(candidate, 'utf-8'));
        } catch (err) {
          throw new Error(`failed to parse config ${candidate}: ${err}`);
        }
        break;
      }
    }
  }

  return applyDefaults(raw);
}

function num(v: unknown, dflt: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : dflt;
}
function str(v: unknown, dflt: string): string {
  return typeof v === 'string' && v.length > 0 ? v : dflt;
}
