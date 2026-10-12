/**
 * The `idlefill agent` group (cli.md D7, issue #92 S5) — the roster view +
 * the wave's ONLY out-of-repo write.
 *
 * `agent list` renders the agent_roster the daemon already publishes
 * (client/src/agent-roster.ts, #80) through the arbiter's token-gated
 * GET /api/agent-roster. The dashboard's fetch-honesty axis ports whole
 * (dashboard/src/lib/agent-stats.ts): no roster key = a NAMED ABSENCE
 * (a daemon without a ~/.hermes home, or offline) — never a fake zero;
 * a fetched-empty roster = a true 0 naming the zero-config posture.
 *
 * `connect <profile>` flips one Hermes profile to the `adopted` posture:
 * its model base URL points at this machine's aggregate endpoint
 * (`http://127.0.0.1:<aggregate_port>/v1` — the same port the roster
 * classifies on, read at runtime from client/config.json like every
 * other config fact). `disconnect <profile>` restores the prior config
 * from the timestamped backup connect wrote — it never invents a prior
 * endpoint.
 *
 * THE CREDENTIAL RULES ARE INHERITED WHOLE from agent-roster.ts (the
 * authority): the edit reads ONLY the profile's config.yaml — never a
 * profile `.env`, never follows a `key_env` reference; never prints a
 * credential; a userinfo-bearing URL (`user:pass@host`) in the config is
 * a REFUSAL, not something redacted-in-place or rewritten past; an
 * unparseable config is a NAMED REFUSAL, never a write. The timestamped
 * backup of config.yaml is written BEFORE any modification; the write is
 * atomic (tmp+rename); every unrelated line — keys, comments, quoting,
 * other providers — rides through byte-for-byte (line surgery, not a
 * re-serialize: there is no YAML parser in this repo and the roster
 * rules are line-based too).
 *
 * ROUTING, NEVER ADMISSION: connect/disconnect change where a profile
 * SENDS traffic. The idle gate decides admission; this command can never
 * make it grant something it would refuse (cli.md D7).
 *
 * Exit codes: 0 ok · 1 action failed · 2 usage.
 */

import { existsSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { EngineFail, repoRoot, resolveAuth } from './engine.js';
import { backupPathFor } from './mesh.js';
import { jsonPayload } from './json.js';

export const AGENT_USAGE =
  'usage: idlefill agent [list] [--json] | connect <profile> | disconnect <profile>';

/** Mirrors client/src/config.ts DEFAULTS — the fleet-wide aggregate port. */
export const DEFAULT_AGGREGATE_PORT = 8800;

// ---------------------------------------------------------------------------
// argv (pure)
// ---------------------------------------------------------------------------

export type AgentCmd = 'list' | 'connect' | 'disconnect';

export type AgentParse =
  | { ok: true; cmd: AgentCmd; positional: string[] }
  | { ok: false; error: string };

export function parseAgentArgs(argv: string[]): AgentParse {
  const [cmd, ...rest] = argv;
  if (!cmd) return { ok: true, cmd: 'list', positional: [] };
  if (!['list', 'connect', 'disconnect'].includes(cmd)) {
    return { ok: false, error: `unknown agent command "${cmd}" — ${AGENT_USAGE}` };
  }
  const sub = cmd as AgentCmd;
  const positional: string[] = [];
  for (const tok of rest) {
    if (tok.startsWith('-')) return { ok: false, error: `unknown flag "${tok}" — ${AGENT_USAGE}` };
    positional.push(tok);
  }
  if (sub === 'list' && positional.length) return { ok: false, error: `list takes no arguments — ${AGENT_USAGE}` };
  if (sub !== 'list' && positional.length !== 1) {
    return { ok: false, error: `${sub} needs exactly <profile> — ${AGENT_USAGE}` };
  }
  return { ok: true, cmd: sub, positional };
}

/**
 * A profile is ONE directory name under ~/.hermes/profiles. Refuse anything
 * that could escape it (separators, traversal, hidden entries the roster
 * itself never publishes).
 */
export function normalizeProfileName(raw: string): { ok: true; name: string } | { ok: false; reason: string } {
  const name = String(raw ?? '');
  if (name.trim() === '') return { ok: false, reason: 'a profile name is required' };
  if (name !== name.trim()) return { ok: false, reason: `"${name.trim()}" — leading/trailing spaces are not the profile name` };
  if (/[\/\\\u0000-\u001f]/.test(name)) return { ok: false, reason: `"${name}" is not a single profile name — no path separators` };
  if (name === '.' || name === '..') return { ok: false, reason: `"${name}" is not a profile` };
  if (name.startsWith('.')) return { ok: false, reason: `"${name}" is hidden — the roster never publishes hidden entries and neither does this command` };
  return { ok: true, name };
}

// ---------------------------------------------------------------------------
// The aggregate endpoint (pure) — the same value the roster classifies on
// ---------------------------------------------------------------------------

export function aggregateEndpointUrl(port: number): string | null {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return `http://127.0.0.1:${port}/v1`;
}

/** Ported verbatim in meaning from client/src/agent-roster.ts (the authority). */
export function targetsAggregatePort(url: string, aggregatePort: number): boolean {
  if (!aggregatePort || aggregatePort < 1 || aggregatePort > 65535) return false;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  let host = u.hostname;
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1); // [::1]
  const loopback =
    host === 'localhost' ||
    host === '::1' ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
  if (!loopback) return false;
  const port = u.port !== '' ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
  return port === aggregatePort;
}

function hasUserInfo(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  return u.username !== '' || u.password !== '';
}

// ---------------------------------------------------------------------------
// The minimal YAML surface (line-based, ported from agent-roster.ts) — the
// edit never re-serializes the file: it carries every unrelated line through
// untouched, so there is nothing to drift.
// ---------------------------------------------------------------------------

function scalarValue(line: string, key: string): string | undefined {
  const m = line.match(new RegExp(`^\\s*${key}:\\s*(.*)$`));
  if (!m) return undefined;
  let v = (m[1] ?? '').trim();
  if (v === '') return undefined;
  if (
    (v.startsWith("'") && v.endsWith("'") && v.length >= 2) ||
    (v.startsWith('"') && v.endsWith('"') && v.length >= 2)
  ) {
    v = v.slice(1, -1).trim();
  }
  if (v === '') return undefined;
  return v;
}

interface YamlFacts {
  /** Parseable at all (text, no control bytes, no tab indentation, no duplicate top-level model:). */
  parseable: boolean;
  unparseableReason?: string;
  modelPresent: boolean;
  modelLine: number; // index of the top-level `model:` line (-1 when absent)
  modelBaseUrlLine: number; // first `base_url:` inside the model block (-1 when absent)
  modelChildIndent: string; // indent of the model block's children (for insertion)
  /** `model:` carries an inline scalar (`model: some-model`) — no block to hold a base_url. */
  modelInlineScalar: boolean;
  /** Every endpoint URL value (`base_url:`/`api:`) at any depth, with its line. */
  endpoints: Array<{ url: string; line: number }>;
  userInfoUrl: string | null; // ANY endpoint value carrying userinfo — never echoed
}

function inspectYaml(text: string): YamlFacts {
  const out: YamlFacts = {
    parseable: true,
    modelPresent: false,
    modelLine: -1,
    modelBaseUrlLine: -1,
    modelChildIndent: '  ',
    modelInlineScalar: false,
    endpoints: [],
    userInfoUrl: null,
  };
  if (/\u0000/.test(text)) {
    out.parseable = false;
    out.unparseableReason = 'the config.yaml carries binary bytes (a NUL) — it is not parseable text';
    return out;
  }
  if (/[\x01-\x08\x0b\x0c\x0e-\x1f]/.test(text)) {
    out.parseable = false;
    out.unparseableReason = 'the config.yaml carries control characters — it is not parseable text';
    return out;
  }
  const lines = text.split(/\r?\n/);
  let inModel = false;
  let topModelCount = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (/^\t/.test(line)) {
      out.parseable = false;
      out.unparseableReason = `the config.yaml is tab-indented (line ${i + 1}) — YAML needs spaces; refusing to edit an ambiguous file`;
      return out;
    }
    if (/^\s*#/.test(line)) continue;
    if (/^\S/.test(line)) {
      inModel = false;
      if (/^model\s*:/.test(line)) {
        topModelCount++;
        if (topModelCount > 1) {
          out.parseable = false;
          out.unparseableReason = `the config.yaml has more than one top-level model: block — which one routes is ambiguous; refusing to edit`;
          return out;
        }
        out.modelPresent = true;
        out.modelLine = i;
        out.modelInlineScalar = scalarValue(line, 'model') !== undefined;
        inModel = true;
      }
    } else if (inModel) {
      if (out.modelBaseUrlLine < 0 && /^\s*base_url\s*:/.test(line)) {
        out.modelBaseUrlLine = i;
        out.modelChildIndent = (line.match(/^(\s*)/) as RegExpMatchArray)[1] as string || '  ';
      }
    }
    if (out.modelLine >= 0 && inModel && out.modelChildIndent === '  ' && /^\s+\S/.test(line) && i > out.modelLine) {
      const ind = (line.match(/^(\s*)/) as RegExpMatchArray)[1] as string;
      if (ind && !/^\s*base_url\s*:/.test(line)) out.modelChildIndent = ind;
    }
    const v = scalarValue(line, 'base_url') ?? scalarValue(line, 'api');
    if (v) {
      out.endpoints.push({ url: v, line: i });
      if (!out.userInfoUrl && hasUserInfo(v)) out.userInfoUrl = v;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// connect plan (pure) — the model base URL flip, line surgery only
// ---------------------------------------------------------------------------

export type ConnectPlan =
  | { action: 'refuse'; reason: string }
  | { action: 'unchanged'; endpoint: string }
  | { action: 'write'; newText: string; endpoint: string; prior: string | null };

export function planConnect(text: string, port: number): ConnectPlan {
  const endpoint = aggregateEndpointUrl(port);
  if (!endpoint) return { action: 'refuse', reason: `the aggregate port (${port}) is not a usable port — nothing to point the profile at` };
  const f = inspectYaml(text);
  if (!f.parseable) return { action: 'refuse', reason: `${f.unparseableReason} — named refusal, nothing was written` };
  if (f.userInfoUrl) {
    // The URL is NEVER echoed (refused, not redacted) — the rule from agent-roster.ts.
    return { action: 'refuse', reason: 'an endpoint URL in the profile config.yaml carries userinfo (user:pass@host) — a credential-bearing URL is refused, not rewritten and not redacted; nothing was written' };
  }
  if (f.modelPresent && f.endpoints.some((e) => targetsAggregatePort(e.url, port))) {
    return { action: 'unchanged', endpoint };
  }
  if (f.modelInlineScalar) {
    return { action: 'refuse', reason: '`model:` is an inline scalar (`model: <name>`) — there is no block to hold a base_url; refusing to guess a rewrite, nothing was written' };
  }
  const priorEntry = f.endpoints.find((e) => !targetsAggregatePort(e.url, port));
  const prior = priorEntry ? priorEntry.url : null;
  const lines = text.split(/\r?\n/);
  if (f.modelLine >= 0) {
    if (f.modelBaseUrlLine >= 0) {
      const indent = (lines[f.modelBaseUrlLine] as string).match(/^\s*/)![0];
      lines[f.modelBaseUrlLine] = `${indent}base_url: ${endpoint}`;
    } else {
      const insertAt = f.modelLine + 1;
      lines.splice(insertAt, 0, `${f.modelChildIndent}base_url: ${endpoint}`);
    }
    return { action: 'write', newText: lines.join('\n'), endpoint, prior };
  }
  // No model block (an `unset` profile): append the minimal block the roster
  // needs to classify adopted — every other line stays where it is.
  const block = `model:\n  base_url: ${endpoint}\n`;
  const joined = text === '' ? block : text.endsWith('\n') ? `${text}${block}` : `${text}\n${block}`;
  return { action: 'write', newText: joined, endpoint, prior };
}

// ---------------------------------------------------------------------------
// disconnect plan (pure) — restore the prior config from the newest backup
// that PRE-DATES the connect; never invent a prior endpoint.
// ---------------------------------------------------------------------------

export interface BackupCandidate {
  name: string;
  text: string;
}

export type DisconnectPlan =
  | { action: 'refuse'; reason: string }
  | { action: 'not-adopted'; endpoint: string }
  | { action: 'no-usable-backup'; endpoint: string; scanned: number }
  | { action: 'restore'; restoreText: string; backupName: string; endpoint: string };

export function planDisconnect(currentText: string, backups: BackupCandidate[], port: number): DisconnectPlan {
  const endpoint = aggregateEndpointUrl(port);
  if (!endpoint) return { action: 'refuse', reason: `the aggregate port (${port}) is not a usable port — nothing to disconnect from` };
  const cur = inspectYaml(currentText);
  if (!cur.parseable) return { action: 'refuse', reason: `${cur.unparseableReason} — named refusal, nothing was written` };
  if (cur.userInfoUrl) {
    return { action: 'refuse', reason: 'an endpoint URL in the profile config.yaml carries userinfo (user:pass@host) — a credential-bearing URL is refused, not rewritten and not redacted; nothing was written' };
  }
  if (!cur.endpoints.some((e) => targetsAggregatePort(e.url, port))) {
    return { action: 'not-adopted', endpoint };
  }
  // Newest first (the backup names carry the timestamp — lexically sortable).
  const sorted = [...backups].sort((a, b) => (a.name < b.name ? 1 : -1));
  let scanned = 0;
  for (const b of sorted) {
    scanned++;
    const bf = inspectYaml(b.text);
    if (!bf.parseable) continue; // a corrupt backup is skipped, never restored
    if (bf.userInfoUrl) continue; // a credential-bearing backup is not touched
    if (bf.endpoints.some((e) => targetsAggregatePort(e.url, port))) continue; // this backup already routes HERE — not a PRIOR config
    return { action: 'restore', restoreText: b.text, backupName: b.name, endpoint };
  }
  return { action: 'no-usable-backup', endpoint, scanned };
}

/** The roster-pane wording for backup names written by this command. */
export function profileBackupNames(entries: string[]): string[] {
  return entries.filter((n) => /^config\.yaml\.bak-\d{8}T\d{6}Z$/.test(n));
}

// ---------------------------------------------------------------------------
// Roster rendering (pure) — the dashboard's honesty posture, terminal voice
// ---------------------------------------------------------------------------

export interface RosterRowView {
  profile: string;
  posture: string;
  provider?: string;
  base_url?: string;
}

export function renderRosterRows(rows: RosterRowView[], client?: string): string[] {
  const adopted = rows.filter((r) => r.posture === 'adopted').length;
  const out = [`${adopted} of ${rows.length} profiles adopted on this machine${client ? ` (reported by the daemon "${client}")` : ''}`];
  for (const r of rows) {
    const who = r.profile;
    const via = r.provider ? ` · model.provider: ${r.provider}` : '';
    if (r.posture === 'adopted') {
      out.push(`  ${who}  routes through idlefill${r.base_url ? ` — ${r.base_url}` : ''}${via}`);
    } else if (r.posture === 'external') {
      out.push(`  ${who}  routes elsewhere${r.base_url ? ` — ${r.base_url}` : ' (no endpoint published)'}${via}`);
    } else {
      out.push(`  ${who}  no config${via}`);
    }
  }
  out.push('');
  out.push('connect / disconnect a profile with `idlefill agent connect <profile>` / `idlefill agent disconnect <profile>`');
  return out;
}

/** Named absence — the roster was never reported (not a zero). agent-stats.ts posture. */
export function rosterAbsentText(): string {
  return [
    'no Hermes roster reported — the local daemon has no ~/.hermes home (or is offline), so nothing was fetched.',
    'That is a named absence, not a zero: run this on a machine whose daemon has a Hermes home.',
  ].join('\n');
}

/** Fetched-empty — a TRUE 0 naming the zero-config posture. */
export function rosterEmptyText(): string {
  return [
    '0 Hermes profiles — the roster WAS fetched and came back empty: a true zero.',
    'No profile on this machine routes anywhere; the aggregate endpoint accepts any caller (the zero-config posture).',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// The live group
// ---------------------------------------------------------------------------

class AgentFail extends Error {}
class AgentUsage extends Error {}

function readJsonConfig(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    return raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * This machine's aggregate port — the same key the roster classifies on
 * (client/src/config.ts `aggregate_port`, default 8800), read at RUNTIME
 * from the gitignored client config (same lookup order as resolveAuth).
 * An explicit 0 = the listener is disabled → a named refusal, never a write.
 */
export function resolveAggregatePort(env: NodeJS.ProcessEnv = process.env): number {
  let raw: Record<string, unknown> | null = null;
  if (env.IDLEFILL_CLIENT_CONFIG?.trim()) {
    try {
      const v = JSON.parse(env.IDLEFILL_CLIENT_CONFIG) as unknown;
      raw = v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
    } catch {
      throw new AgentFail('IDLEFILL_CLIENT_CONFIG is not valid JSON — refusing to guess the aggregate port');
    }
  }
  if (raw === null) {
    raw =
      readJsonConfig(join(repoRoot, 'client', 'config.json')) ??
      readJsonConfig(join(repoRoot, 'client', 'config.client.json'));
  }
  if (raw === null) return DEFAULT_AGGREGATE_PORT;
  if (raw.aggregate_port === undefined) return DEFAULT_AGGREGATE_PORT;
  const p = raw.aggregate_port;
  if (typeof p !== 'number' || !Number.isFinite(p)) {
    throw new AgentFail(`aggregate_port in the client config is not a number (${typeof p}) — refusing to guess it`);
  }
  if (p === 0) {
    throw new AgentFail('aggregate_port is 0 — this machine has NO aggregate endpoint to connect a profile to. Set aggregate_port in client/config.json and restart the daemon.');
  }
  return Math.max(0, Math.floor(p));
}

function hermesProfilesDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.IDLEFILL_HERMES_PROFILES_DIR?.trim();
  return override || join(homedir(), '.hermes', 'profiles');
}

/** Backup (existing bytes only), then atomic tmp+rename — the state-file posture. */
export function writeProfileWithBackup(path: string, newText: string, now: Date): string | null {
  const existed = existsSync(path);
  let backup: string | null = null;
  if (existed) {
    backup = backupPathFor(path, now);
    writeFileSync(backup, readFileSync(path));
  }
  const tmp = `${path}.tmp-${process.pid}-${now.getTime()}`;
  writeFileSync(tmp, newText);
  renameSync(tmp, path);
  return backup;
}

export async function runAgent(argv: string[], json: boolean): Promise<number> {
  try {
    return await runAgentInner(argv, json);
  } catch (err) {
    if (err instanceof AgentUsage) {
      console.error(`idlefill agent: ${err.message}`);
      return 2;
    }
    if (err instanceof AgentFail || err instanceof EngineFail) {
      console.error(`idlefill agent: ${err.message}`);
      return 1;
    }
    throw err;
  }
}

async function runAgentInner(argv: string[], json: boolean): Promise<number> {
  const parsed = parseAgentArgs(argv);
  if (!parsed.ok) throw new AgentUsage(parsed.error);
  const { cmd, positional } = parsed;

  // -------------------------------------------------------------------------
  // list — the daemon's published agent_roster, fetch-honest
  // -------------------------------------------------------------------------

  if (cmd === 'list') {
    const { token, serverUrl } = resolveAuth();
    const res = await fetch(`${serverUrl}/api/agent-roster`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    }).catch((err: Error) => {
      throw new AgentFail(`cannot reach the arbiter at ${serverUrl} (${err.message})`);
    });
    if (res.status === 401 || res.status === 403) {
      throw new AgentFail('the arbiter refused the token — check the gitignored config (the token is never passed on the command line)');
    }
    if (res.status === 404) {
      throw new AgentFail('this arbiter has no /api/agent-roster route — it predates the #80 roster; update the arbiter');
    }
    if (res.status < 200 || res.status >= 300) {
      const text = await res.text().catch(() => '');
      throw new AgentFail(`GET /api/agent-roster → HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
    }
    const body = (await res.json().catch(() => null)) as { client?: string; roster?: RosterRowView[] } | null;
    if (json) {
      console.log(jsonPayload(body ?? {}));
      return 0;
    }
    if (!body || !Array.isArray(body.roster)) {
      console.log(rosterAbsentText());
      return 0;
    }
    if (body.roster.length === 0) {
      console.log(rosterEmptyText());
      return 0;
    }
    console.log(renderRosterRows(body.roster, typeof body.client === 'string' ? body.client : undefined).join('\n'));
    return 0;
  }

  // -------------------------------------------------------------------------
  // connect / disconnect — the wave's ONLY out-of-repo write, guarded
  // -------------------------------------------------------------------------

  const pn = normalizeProfileName(positional[0] as string);
  if (!pn.ok) throw new AgentUsage(`connect/disconnect refused — ${pn.reason} — ${AGENT_USAGE}`);
  const profile = pn.name;
  const port = resolveAggregatePort();
  const endpoint = aggregateEndpointUrl(port);
  if (!endpoint) throw new AgentFail(`aggregate port ${port} is not a usable port`);

  const profilesDir = hermesProfilesDir();
  const profileDir = join(profilesDir, profile);
  let isDir = false;
  try {
    isDir = statSync(profileDir).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) {
    let known: string[] = [];
    try {
      known = readdirSync(profilesDir).filter((n) => !n.startsWith('.')).sort().slice(0, 24);
    } catch {
      /* no Hermes home here */
    }
    throw new AgentFail(
      `${cmd} refused — no Hermes profile "${profile}" under ${profilesDir}${known.length ? ` (known: ${known.join(', ')})` : ''}. Nothing was written.`,
    );
  }

  const configPath = join(profileDir, 'config.yaml');
  let text: string;
  try {
    text = existsSync(configPath) ? readFileSync(configPath, 'utf-8') : '';
  } catch (err) {
    throw new AgentFail(`${cmd} refused — cannot read ${configPath} (${(err as Error).message}). Nothing was written.`);
  }

  if (cmd === 'connect') {
    const plan = planConnect(text, port);
    if (plan.action === 'refuse') throw new AgentFail(`connect refused — ${plan.reason}`);
    if (plan.action === 'unchanged') {
      console.log(`ok: "${profile}" already routes to ${plan.endpoint} — the profile is adopted; nothing was written.`);
      return 0;
    }
    const backup = writeProfileWithBackup(configPath, plan.newText, new Date());
    console.log(`ok: connected "${profile}" — its model now routes to ${plan.endpoint} (config.yaml ${backup ? `backed up to ${backup.split(/[\\/]/).pop()}` : 'created — there was no file to back up'})`);
    if (plan.prior) console.log(`  prior endpoint: ${plan.prior}`);
    console.log('  the daemon re-classifies this profile as `adopted` on its next heartbeat (~20s) — check with `idlefill agent list`');
    console.log('  routing only: this changes where the profile SENDS traffic — the idle gate still decides admission');
    return 0;
  }

  // disconnect
  let backups: BackupCandidate[] = [];
  try {
    backups = profileBackupNames(readdirSync(profileDir)).map((name) => ({
      name,
      text: readFileSync(join(profileDir, name), 'utf-8'),
    }));
  } catch (err) {
    throw new AgentFail(`disconnect refused — cannot list backups in ${profileDir} (${(err as Error).message}). Nothing was written.`);
  }
  const plan = planDisconnect(text, backups, port);
  if (plan.action === 'refuse') throw new AgentFail(`disconnect refused — ${plan.reason}`);
  if (plan.action === 'not-adopted') {
    throw new AgentFail(
      `disconnect refused — "${profile}" does not route to this machine's aggregate endpoint (${plan.endpoint}) — there is nothing here to disconnect. Nothing was written.`,
    );
  }
  if (plan.action === 'no-usable-backup') {
    throw new AgentFail(
      `disconnect refused — "${profile}" routes to ${plan.endpoint}, but no config.yaml backup holds a PRIOR config${plan.scanned ? ` (scanned ${plan.scanned} backup(s))` : ' (none found)'}. Refusing to invent a prior endpoint. Nothing was written.`,
    );
  }
  const backup = writeProfileWithBackup(configPath, plan.restoreText, new Date());
  console.log(`ok: disconnected "${profile}" — config.yaml restored from ${plan.backupName} (its pre-connect bytes); the current bytes were backed up first as ${backup ? backup.split(/[\\/]/).pop() : 'n/a'}`);
  console.log('  the daemon re-classifies this profile off `adopted` on its next heartbeat (~20s) — check with `idlefill agent list`');
  console.log('  routing only: this changes where the profile SENDS traffic — the idle gate still decides admission');
  return 0;
}
