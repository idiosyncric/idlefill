/**
 * The `idlefill engine` group (cli.md D6, issue #90 S3) — the terminal twin
 * of the declared inference-server inventory the dashboard Resources tab and
 * `idlefill control server …` manage. A PURE API client over the existing
 * GET /api/servers + POST /api/servers (+ /api/servers/remove) surface
 * (server/src/api.ts:803-876) — this slice adds ZERO arbiter surface.
 *
 * `add --local` pre-flights the co-location rule (mesh.md rule 1: the
 * arbiter's idle detector reads the engine's log file on its OWN host):
 * candidate log locations are probed with the detector's OWN matcher
 * semantics (server/src/idle.ts makeRealLogMtimeSource — dirname + a
 * basename glob) and a log_glob is saved ONLY when it matches a real file.
 * No match = refuse with the rule named, save nothing. A remote/watched-
 * false row stays available and renders fail-closed for grants, honestly.
 *
 * Auth posture (D3): the token is read AT RUNTIME from the gitignored
 * config (same env overrides as the control group), never from argv,
 * never printed. Exit codes: 0 ok · 1 action failed · 2 usage.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { jsonPayload } from './json.js';

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const ENGINE_USAGE =
  'usage: idlefill engine [list] | add <name> <url> [--models a,b] [--peers p1] [--local [--log-glob G]] | ' +
  'set <id> [--name N] [--url U] [--models a,b] [--peers p1] | remove <id>';

// ---------------------------------------------------------------------------
// argv → payload (pure)
// ---------------------------------------------------------------------------

export interface EngineFlags {
  models?: string[];
  peers?: string[];
  name?: string;
  url?: string;
  logGlob?: string;
  local: boolean;
}

export type EngineParse =
  | { ok: true; cmd: string; positional: string[]; flags: EngineFlags }
  | { ok: false; error: string };

const VALUE_FLAGS = ['--models', '--peers', '--name', '--url', '--log-glob'] as const;

const listCsv = (v: string | undefined): string[] | undefined =>
  v ? String(v).split(',').map((x) => x.trim()).filter(Boolean) : undefined;

export function parseEngineArgs(argv: string[]): EngineParse {
  const [cmd, ...rest] = argv;
  if (!cmd) return { ok: true, cmd: 'list', positional: [], flags: { local: false } };
  if (!['list', 'add', 'set', 'remove'].includes(cmd)) {
    return { ok: false, error: `unknown engine command "${cmd}" — ${ENGINE_USAGE}` };
  }
  const positional: string[] = [];
  const flags: EngineFlags = { local: false };
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i] as string;
    if (tok === '--local') {
      flags.local = true;
      continue;
    }
    if (tok.startsWith('-')) {
      if (!(VALUE_FLAGS as readonly string[]).includes(tok)) {
        return { ok: false, error: `unknown flag "${tok}" — ${ENGINE_USAGE}` };
      }
      const val = rest[i + 1];
      if (val === undefined || val.startsWith('--')) {
        return { ok: false, error: `${tok} needs a value` };
      }
      i++;
      if (tok === '--models') flags.models = listCsv(val);
      if (tok === '--peers') flags.peers = listCsv(val);
      if (tok === '--name') flags.name = val;
      if (tok === '--url') flags.url = val;
      if (tok === '--log-glob') flags.logGlob = val;
      continue;
    }
    positional.push(tok);
  }
  return { ok: true, cmd, positional, flags };
}

export type PayloadResult = { ok: true; body: Record<string, unknown> } | { ok: false; error: string };

export function buildAddPayload(positional: string[], flags: EngineFlags): PayloadResult {
  const [name, url] = positional;
  if (!name || !url || positional.length !== 2) {
    return { ok: false, error: `add needs exactly <name> <url> — ${ENGINE_USAGE}` };
  }
  return {
    ok: true,
    body: {
      name,
      url,
      ...(flags.models ? { models: flags.models } : {}),
      ...(flags.peers ? { peers: flags.peers } : {}),
    },
  };
}

export function buildSetPayload(positional: string[], flags: EngineFlags): PayloadResult {
  const [id] = positional;
  if (!id || positional.length !== 1) {
    return { ok: false, error: `set needs exactly <id> — ${ENGINE_USAGE}` };
  }
  if (!flags.name && !flags.url && !flags.models && !flags.peers) {
    return { ok: false, error: 'set needs at least one of --name / --url / --models / --peers' };
  }
  return {
    ok: true,
    body: {
      id,
      ...(flags.name ? { name: flags.name } : {}),
      ...(flags.url ? { url: flags.url } : {}),
      ...(flags.models ? { models: flags.models } : {}),
      ...(flags.peers ? { peers: flags.peers } : {}),
    },
  };
}

export function buildRemovePayload(positional: string[]): PayloadResult {
  const [id] = positional;
  if (!id || positional.length !== 1) {
    return { ok: false, error: `remove needs exactly <id> — ${ENGINE_USAGE}` };
  }
  return { ok: true, body: { id } };
}

// ---------------------------------------------------------------------------
// `--local` co-location pre-flight (pure decision + the real probe)
// ---------------------------------------------------------------------------

export type ProbeResult =
  | { kind: 'match'; files: number }
  | { kind: 'no-match' }
  | { kind: 'unreadable'; error: string };

export type ProbeFn = (glob: string) => ProbeResult;

/** The detector's matcher semantics (idle.ts makeRealLogMtimeSource): basename glob, `*` → any. */
function globToBaseRe(pat: string): RegExp {
  const escaped = pat.replace(/[.+*?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.replace(/\\\*/g, '.*')}$`);
}

export const realProbe: ProbeFn = (glob) => {
  try {
    const dir = dirname(glob);
    const pat = basename(glob);
    if (pat === '' || pat === '.' || pat === '..') return { kind: 'no-match' };
    const re = globToBaseRe(pat);
    let files = 0;
    for (const name of readdirSync(dir)) {
      if (!re.test(name)) continue;
      try {
        if (statSync(join(dir, name)).isFile()) files++;
      } catch {
        /* raced away between readdir and stat — not a match */
      }
    }
    return files > 0 ? { kind: 'match', files } : { kind: 'no-match' };
  } catch (err) {
    return { kind: 'unreadable', error: (err as NodeJS.ErrnoException).code ?? String(err) };
  }
};

export interface LocalProbeDecision {
  verdict: 'save' | 'refuse';
  /** The glob to save (verdict 'save'). */
  log_glob?: string;
  matched?: number;
  /** Every candidate tried, with its outcome — the refusal names them all. */
  probed: Array<{ glob: string; outcome: string }>;
}

export function decideLocalProbe(candidates: string[], probe: ProbeFn): LocalProbeDecision {
  const probed: Array<{ glob: string; outcome: string }> = [];
  for (const glob of candidates) {
    const res = probe(glob);
    if (res.kind === 'match') {
      probed.push({ glob, outcome: `match (${res.files})` });
      return { verdict: 'save', log_glob: glob, matched: res.files, probed };
    }
    probed.push({ glob, outcome: res.kind === 'no-match' ? 'no match' : `unreadable (${res.error})` });
  }
  return { verdict: 'refuse', probed };
}

/**
 * Candidate log locations for `add --local` without an explicit --log-glob:
 * the conventional per-engine log spots on this host, keyed by the row name
 * (slugified). Deterministic — the refusal prints every one it probed.
 */
export function localCandidateGlobs(name: string, home: string, root: string): string[] {
  const slug =
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || name.trim();
  return [
    join(home, 'logs', `${slug}*.log`),
    join(home, 'logs', slug, '*.log'),
    join('/var/log', `${slug}*.log`),
    join('/var/log', slug, '*.log'),
    join(root, 'logs', `${slug}*.log`),
    join('/tmp', `${slug}*.log`),
  ];
}

export function isLoopbackUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === 'localhost' || host === '::1' || /^127(\.\d+){0,3}$/.test(host);
  } catch {
    return false;
  }
}

export function localRefusalText(name: string, decision: LocalProbeDecision): string {
  const lines = [
    `idlefill engine: --local refused — the co-location rule (mesh.md rule 1): the arbiter's idle detector reads the engine's log file on its OWN host, so a local engine row must carry a log_glob that matches a real file here. Nothing was saved.`,
    `  probed:`,
    ...decision.probed.map((p) => `    ${p.glob} — ${p.outcome}`),
    `  point --log-glob at the engine's log file, or add "${name}" without --local (a display + routing row, fail-closed for grants).`,
  ];
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Row rendering — the dashboard-plain voice (pure)
// ---------------------------------------------------------------------------

export interface ServerRow {
  id: string;
  name: string;
  url: string;
  activity_path?: string;
  log_glob?: string;
  models?: Array<{ name: string; running?: boolean; queued?: number }>;
  peers?: string[];
  auth_set?: boolean;
  watched?: boolean;
  engaged?: boolean;
  group_id?: string | null;
  max_concurrent?: number | null;
  signal?:
    | null
    | {
        idle?: boolean;
        idle_for_s?: number | null;
        degraded?: boolean;
        degraded_reason?: string | null;
        last_activity?: { age_s?: number } | null;
        last_log_write_age_s?: number | null;
        feed_enabled?: boolean;
        no_signal_reason?: string | null;
        reidle_gated?: boolean;
      };
}

/** The state word for one row (the dashboard's liveWord posture, terminal voice). */
export function verdictLine(s: ServerRow): string {
  if (!s.watched) {
    return 'not watched — display + routing metadata; grants against this engine fail closed (mesh.md rule 1)';
  }
  const sig = s.signal;
  if (!sig) return 'no signal from the arbiter this tick — fail-closed for grants';
  if (sig.degraded) return `degraded — grants blocked (${sig.degraded_reason ?? 'signal degraded'})`;
  if (sig.no_signal_reason) return `no signal resolves (${sig.no_signal_reason}) — fail-closed for grants`;
  if (s.engaged || (s.models ?? []).some((m) => m.running)) return 'running idle tasks — background work in progress';
  if (sig.idle) {
    let line = 'idle — grants open';
    if (typeof sig.idle_for_s === 'number') line += ` · idle for ${sig.idle_for_s}s`;
    if (typeof sig.last_log_write_age_s === 'number') line += ` · log wrote ${sig.last_log_write_age_s}s ago`;
    if (sig.feed_enabled === false) line += ' · no activity feed — log mtime carries the verdict';
    if (sig.reidle_gated) line += ' · reidle gate holding';
    return line;
  }
  let line = 'busy — grants blocked';
  if (typeof sig.last_activity?.age_s === 'number') line += ` · last activity ${sig.last_activity.age_s}s ago`;
  if (sig.feed_enabled === false) line += ' · no activity feed — log mtime carries the verdict';
  return line;
}

export function renderEngineRows(rows: ServerRow[], globalIdle: number | null): string[] {
  const out: string[] = [];
  for (const s of rows) {
    const feed = s.activity_path === '' ? '(no activity feed)' : (s.activity_path ?? '—');
    out.push(`${s.id}  ${s.watched ? '[watched]' : '[declared]'}  ${s.name}  ${s.url}  ${feed}${s.auth_set ? '  key:set' : ''}`);
    out.push(`  ${verdictLine(s)}`);
    if (s.watched) {
      out.push(
        `  runs when idle ≥${globalIdle ?? '—'}s · max ${s.max_concurrent ?? 1}${s.group_id ? ` (group ${s.group_id})` : ''}`,
      );
    }
    if (s.log_glob) out.push(`  log: ${s.log_glob}`);
    out.push(`  models: ${(s.models ?? []).length ? (s.models as NonNullable<ServerRow['models']>).map((m) => `${m.name}${m.running ? ' (running)' : ''}${m.queued ? ` (${m.queued} queued)` : ''}`).join(', ') : '—'}`);
    if (s.peers?.length) out.push(`  peers (routed behind this entry point): ${s.peers.join(', ')}`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Arbiter error voice (pure) — every failure names its reason (D3)
// ---------------------------------------------------------------------------

export function explainApiError(status: number, detail: string): string | null {
  if (detail.includes('unknown_server')) {
    return 'no engine with that id — `idlefill engine list` shows the ids';
  }
  if (detail.includes('leases_active')) {
    return 'remove refused: this engine has live leases — let them finish or revoke them first';
  }
  if (status === 401) return 'the arbiter refused the token — check the gitignored config (the token is never passed on the command line)';
  return null;
}

// ---------------------------------------------------------------------------
// Token + arbiter URL (runtime config read, same posture as the control group)
// ---------------------------------------------------------------------------

function readJsonConfig(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

/** Shared by the mesh group (#91) — the same control-group lookup order. */
export function resolveAuth(): { token: string; serverUrl: string } {
  const parseEnv = (raw: string | undefined): Record<string, unknown> | null => {
    if (!raw) return null;
    try {
      const v = JSON.parse(raw) as unknown;
      return v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };
  const clientCand =
    parseEnv(process.env.IDLEFILL_CLIENT_CONFIG) ??
    readJsonConfig(join(repoRoot, 'client', 'config.json')) ??
    readJsonConfig(join(repoRoot, 'client', 'config.client.json'));
  if (clientCand && typeof clientCand.token === 'string' && clientCand.token && !clientCand.token.startsWith('REPLACE_WITH')) {
    return {
      token: clientCand.token,
      serverUrl: typeof clientCand.server_url === 'string' ? clientCand.server_url : 'http://127.0.0.1:8787',
    };
  }
  const serverCand =
    parseEnv(process.env.IDLEFILL_CONFIG) ?? readJsonConfig(join(repoRoot, 'server', 'config.json'));
  if (serverCand && Array.isArray(serverCand.api_tokens) && serverCand.api_tokens.length > 0) {
    return {
      token: (serverCand.api_tokens as string[])[0] as string,
      serverUrl: `http://127.0.0.1:${serverCand.listen ?? 8787}`,
    };
  }
  throw new EngineFail(
    'no usable config: set IDLEFILL_CLIENT_CONFIG / IDLEFILL_CONFIG, or create client/config.json (token) or server/config.json (api_tokens)',
  );
}

// ---------------------------------------------------------------------------
// The live group
// ---------------------------------------------------------------------------

export class EngineFail extends Error {}
class EngineUsage extends Error {}

export async function runEngine(argv: string[], json: boolean): Promise<number> {
  try {
    return await runEngineInner(argv, json);
  } catch (err) {
    if (err instanceof EngineUsage) {
      console.error(`idlefill engine: ${err.message}`);
      return 2;
    }
    if (err instanceof EngineFail) {
      console.error(`idlefill engine: ${err.message}`);
      return 1;
    }
    throw err;
  }
}

async function runEngineInner(argv: string[], json: boolean): Promise<number> {
  const parsed = parseEngineArgs(argv);
  if (!parsed.ok) throw new EngineUsage(parsed.error);
  const { cmd, positional, flags } = parsed;
  if (flags.logGlob !== undefined && !(cmd === 'add' && flags.local)) {
    throw new EngineUsage('--log-glob only applies to `add --local`');
  }

  const { token, serverUrl } = resolveAuth();
  const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

  async function api(method: string, path: string, body?: unknown): Promise<Record<string, any>> {
    const res = await fetch(serverUrl + path, {
      method,
      headers: auth,
      body: body === undefined ? undefined : JSON.stringify(body),
    }).catch((err: Error) => {
      throw new EngineFail(`cannot reach the arbiter at ${serverUrl} (${err.message})`);
    });
    const text = await res.text();
    let payload: Record<string, any> | null = null;
    try {
      payload = JSON.parse(text);
    } catch {
      /* not json */
    }
    if (!res.ok) {
      const detail = String(payload?.error ?? payload?.reason ?? text) || 'no detail';
      const named = explainApiError(res.status, detail);
      throw new EngineFail(named ?? `${method} ${path} → HTTP ${res.status}: ${detail}`);
    }
    return payload ?? {};
  }

  // -------------------------------------------------------------------------
  // list — one GET /api/state: the same serverView the Resources tab reads,
  // plus the global idle threshold the row lines quote.
  // -------------------------------------------------------------------------

  if (cmd === 'list') {
    if (positional.length) throw new EngineUsage(`list takes no arguments — ${ENGINE_USAGE}`);
    const st = await api('GET', '/api/state');
    const rows = (st.servers ?? []) as ServerRow[];
    if (json) {
      console.log(jsonPayload(rows));
      return 0;
    }
    if (!rows.length) {
      console.log('no inference servers declared');
      return 0;
    }
    console.log(renderEngineRows(rows, typeof st.idle?.idle_seconds === 'number' ? st.idle.idle_seconds : null).join('\n'));
    return 0;
  }

  if (cmd === 'add') {
    const payload = buildAddPayload(positional, flags);
    if (!payload.ok) throw new EngineUsage(payload.error);
    const body = payload.body as Record<string, unknown> & { name: string; url: string };

    let localDecision: LocalProbeDecision | null = null;
    if (flags.local) {
      if (!isLoopbackUrl(serverUrl)) {
        throw new EngineFail(
          `--local refused — the co-location probe reads THIS machine's filesystem, but the arbiter lives at ${serverUrl}; a local engine needs the detector on the arbiter's host (mesh.md rule 1). Run the CLI where the arbiter runs, or add without --local (a display + routing row, fail-closed for grants).`,
        );
      }
      const candidates = flags.logGlob ? [flags.logGlob] : localCandidateGlobs(body.name, homedir(), repoRoot);
      const decision = decideLocalProbe(candidates, realProbe);
      if (decision.verdict === 'refuse') {
        console.error(localRefusalText(body.name, decision));
        return 1;
      }
      localDecision = decision;
      body.log_glob = decision.log_glob;
    }

    const res = await api('POST', '/api/servers', body);
    const srv = res.server as Record<string, any>;
    console.log(`ok: added ${srv.id} (${srv.name}) at ${srv.url} — declared on the arbiter at ${serverUrl}`);
    if (flags.local && localDecision) {
      const n = localDecision.matched ?? 0;
      console.log(
        `  local engine: log_glob "${body.log_glob}" matches ${n === 1 ? '1 file' : `${n} files`} on this host — the co-location rule (mesh.md rule 1) holds at save time`,
      );
    } else {
      console.log('  a row the arbiter holds no idle detector for is fail-closed for grants (mesh.md rule 1)');
    }
    return 0;
  }

  if (cmd === 'set') {
    const payload = buildSetPayload(positional, flags);
    if (!payload.ok) throw new EngineUsage(payload.error);
    const res = await api('POST', '/api/servers', payload.body);
    const srv = res.server as Record<string, any>;
    console.log(`ok: updated ${srv.id} (${srv.name})`);
    return 0;
  }

  // remove
  const payload = buildRemovePayload(positional);
  if (!payload.ok) throw new EngineUsage(payload.error);
  const res = await api('POST', '/api/servers/remove', payload.body);
  console.log(`ok: removed ${res.removed}`);
  return 0;
}
