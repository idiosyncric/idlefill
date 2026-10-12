/**
 * Catalog plane for the aggregate inference endpoint (#64, doc D2/D4).
 *
 * The catalog is built IN THE ARBITER (it owns the rows and the tokens):
 * every declared `ServerConnection` row contributes its model names, and
 * a NEW per-row credentialed probe of `GET <row.url>/v1/models` replaces
 * the declared list while the probe answers. A failed probe keeps the
 * declared list (the operator's inventory is never silently lost — the
 * same drop-don't-reject discipline as every observed field). Bare-name
 * collisions de-dup: the name rides ONCE, first row in declaration order
 * wins (owner decision 1 + 2 — no model_preference key this wave).
 *
 * What is published to the router (the `catalog` ADD-key on GET /api/state)
 * is model name + server id + engine url + the `auth_set` boolean —
 * NEVER the token (#60 B write-only posture, doc D2 rule 3). The token
 * crosses to the router ONLY through the dedicated loopback-scoped
 * GET /api/server-keys route the router itself calls.
 */

import type { ServerConnection } from './types.js';

/** One row of the published catalog (one entry per BARE model name). */
export interface CatalogEntry {
  name: string;
  /** The chosen row's id (D5: session rows must carry THIS server_id). */
  server_id: string;
  /** Engine base url the router forwards to. */
  url: string;
  /** True when the row carries a credential (the token itself never rides). */
  auth_set: boolean;
  /** 'probed' = this name came from a live /v1/models probe this tick;
   *  'declared' = it came from the operator-declared row (incl. a probe-blocked row). */
  catalog_source: 'probed' | 'declared';
  /**
   * #87 D2: observed capabilities from THIS tick's probe, ADD keys,
   * omitted when the engine does not expose them (and never present on a
   * 'declared' entry — a declaration is a routing claim, not a capability
   * claim).
   */
  context_length?: number;
  input_modalities?: string[];
  output_modalities?: string[];
}

/**
 * #87 D1: one probed model — the bare name plus the capability fields the
 * engine itself published (best-effort, drop-don't-reject): llama-family
 * `meta.n_ctx` / omlx `max_model_len` become `context_length`;
 * `architecture.input_modalities` / `architecture.output_modalities` ride
 * verbatim. A declared (operator-listed) name is a name ONLY.
 */
export interface ProbedModel {
  name: string;
  context_length?: number;
  input_modalities?: string[];
  output_modalities?: string[];
}

/**
 * Per-row /v1/models probe transport (injectable for tests — the exact
 * shape of the #60 B credentialed feed fetchers in idle.ts). Rejects on
 * any HTTP/network failure; resolves to the probed model entries.
 */
export type ModelsFetcher = (url: string, auth?: string) => Promise<ProbedModel[]>;

/**
 * Probe URL for a row: origin + '/v1/models'. A row whose url already
 * ends in /v1 (operator pasted the OpenAI base) gets '/models' appended
 * instead of a doubled '/v1/v1/models'.
 */
export function modelsProbeUrl(rowUrl: string): string {
  const base = rowUrl.replace(/\/+$/, '');
  return /\/v1$/.test(base) ? `${base}/models` : `${base}/v1/models`;
}

/**
 * Parse an OpenAI-style models payload into probed model entries:
 * {data:[{id}]} (llama-swap / oMLX), tolerating {models:[...]} or a bare
 * array of name strings. Non-string / blank names are dropped. #87 D1:
 * capability fields are captured best-effort — llama-family `meta.n_ctx`
 * and omlx `max_model_len` (first positive finite wins) become
 * `context_length`; `architecture.input_modalities` /
 * `architecture.output_modalities` (string arrays, trimmed, empties
 * dropped) ride verbatim. A malformed field is dropped, never fatal.
 */
export function parseModelsPayload(body: unknown): ProbedModel[] {
  const out: ProbedModel[] = [];
  const seen = new Set<string>();
  const add = (v: unknown): void => {
    if (typeof v === 'string') {
      const s = v.trim();
      if (s === '' || seen.has(s)) return;
      seen.add(s);
      out.push({ name: s });
      return;
    }
    if (!v || typeof v !== 'object') return;
    const it = v as Record<string, unknown>;
    const name = typeof it.id === 'string' ? it.id.trim() : typeof it.name === 'string' ? it.name.trim() : '';
    if (name === '' || seen.has(name)) return;
    seen.add(name);
    const entry: ProbedModel = { name };
    const meta = it.meta && typeof it.meta === 'object' ? (it.meta as Record<string, unknown>) : undefined;
    const ctx = typeof meta?.n_ctx === 'number' ? meta.n_ctx : typeof it.max_model_len === 'number' ? it.max_model_len : undefined;
    if (ctx !== undefined && Number.isFinite(ctx) && ctx > 0) entry.context_length = Math.floor(ctx);
    const arch = it.architecture && typeof it.architecture === 'object' ? (it.architecture as Record<string, unknown>) : undefined;
    const mods = (v: unknown): string[] | undefined => {
      if (!Array.isArray(v)) return undefined;
      const list = v.filter((m): m is string => typeof m === 'string' && m.trim() !== '').map((m) => m.trim());
      return list.length > 0 ? list : undefined;
    };
    const inMod = mods(arch?.input_modalities);
    if (inMod) entry.input_modalities = inMod;
    const outMod = mods(arch?.output_modalities);
    if (outMod) entry.output_modalities = outMod;
    out.push(entry);
  };
  const arrays: unknown[][] = [];
  if (Array.isArray(body)) arrays.push(body);
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const j = body as Record<string, unknown>;
    if (Array.isArray(j.data)) arrays.push(j.data);
    if (Array.isArray(j.models)) arrays.push(j.models);
  }
  for (const arr of arrays) {
    for (const item of arr) add(item);
  }
  return out;
}

/** The real credentialed fetcher (production): Bearer only when a row token exists. */
export function makeRealModelsFetcher(): ModelsFetcher {
  return async (url, auth) => {
    const headers: Record<string, string> = {};
    if (auth) headers.authorization = `Bearer ${auth}`;
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`models probe HTTP ${res.status}`);
    return parseModelsPayload(await res.json());
  };
}

/**
 * Merge rows + this-tick probe results into the deduped catalog.
 *
 * - Base layer: every row's declared `models` (union across rows).
 * - Probe layer: a row present in `probed` REPLACES its declared list
 *   (D4 merge). A row ABSENT from `probed` (failed/blocked probe, fetcher
 *   never ran) keeps the declared list and publishes catalog_source
 *   'declared' — never falsely 'probed'.
 * - An EMPTY successful probe list counts as no observed names: it does
 *   NOT erase the declared inventory (keeps 'declared' — the honest
 *   conservative reading of "the declared inventory is never lost").
 * - Collision rule: a bare name appears ONCE; the FIRST row in
 *   declaration order owns it (routing pins there, no fail-over inside
 *   one chat).
 * - The entry NEVER carries the token — auth_set only.
 */
export function buildCatalog(
  rows: readonly ServerConnection[],
  probed: ReadonlyMap<string, ProbedModel[]>,
): CatalogEntry[] {
  const out: CatalogEntry[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const p = probed.get(row.id);
    const useProbe = p !== undefined && p.length > 0;
    const source: CatalogEntry['catalog_source'] = useProbe ? 'probed' : 'declared';
    const list: ProbedModel[] = useProbe ? p : row.models.map((name) => ({ name }));
    for (const m of list) {
      const name = typeof m?.name === 'string' ? m.name.trim() : '';
      if (name === '' || seen.has(name)) continue;
      seen.add(name);
      const entry: CatalogEntry = {
        name,
        server_id: row.id,
        url: row.url,
        auth_set: row.auth_token !== undefined && row.auth_token !== '',
        catalog_source: source,
      };
      // #87 D2: capability ADD keys ride only from a probed entry — a
      // declared name never claims a capability.
      if (useProbe) {
        if (m.context_length !== undefined) entry.context_length = m.context_length;
        if (m.input_modalities !== undefined) entry.input_modalities = m.input_modalities;
        if (m.output_modalities !== undefined) entry.output_modalities = m.output_modalities;
      }
      out.push(entry);
    }
  }
  return out;
}

/**
 * True when a socket address is loopback. Covers the IPv4 127.0.0.0/8
 * forms, the IPv6 ::1 (with optional %scope), and Node's mapped
 * `::ffff:127.x.x.x` spelling. The arbiter binds 0.0.0.0, so routes that
 * must be machine-local (GET /api/server-keys) check THIS on the raw
 * socket — the test seam is app.inject's custom remoteAddress.
 */
export function isLoopbackAddress(addr: string | undefined | null): boolean {
  if (typeof addr !== 'string') return false;
  let a = addr.trim();
  if (a.toLowerCase().startsWith('::ffff:')) a = a.slice(7);
  if (a === '::1' || a.startsWith('::1%')) return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a);
}
