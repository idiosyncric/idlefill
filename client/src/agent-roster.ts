/**
 * agent-roster.ts — issue #80: the daemon classifies THIS machine's Hermes
 * profiles and publishes the roster on the register heartbeat as the
 * `agent_roster` ADD-key.
 *
 * LOCAL-truth discipline (mirrors the #72 machine picker + the loopback
 * honesty of the agent-endpoints flow): the dashboard is served by this
 * machine's own arbiter, so the roster names this machine's profiles only.
 * The Hermes home is `~/.hermes`; a machine without it (the Linux daemons)
 * simply omits the key — the roster pane hides, it does not show an empty
 * list. Cross-machine rosters are the #55 fleet plane, not this module.
 *
 * Posture (per profile):
 *   - `adopted` : the profile's config.yaml names this machine's OWN bound
 *     aggregate port as an endpoint URL (host is loopback AND port equals
 *     the daemon's aggregate port — the same value it reports as
 *     `aggregate_port`).
 *   - `external`: the profile has a model block but routes elsewhere
 *     (another engine, strata, another machine, or a different loopback
 *     port).
 *   - `unset`   : no config.yaml, or no model block at all.
 *
 * CREDENTIAL posture (the issue's one-line rule, applied): the scan reads
 * `model.provider` + `model.base_url` for the DISPLAY fields and scans the
 * endpoint URLs for the POSTURE discriminator. It never follows a `key_env`
 * reference, never reads a profile `.env`, and never logs a profile it
 * cannot parse (an unparseable config just classifies as `unset`). A
 * published `base_url` that carries a credential-looking userinfo
 * (`user:pass@host`) is OMITTED, not redacted-in-place — none do today, the
 * rule is one line.
 *
 * WHY THE POSTURE SCANS EVERY ENDPOINT URL (not only model.base_url): in
 * real Hermes configs the effective idlefill endpoint usually lives under
 * `providers.<name>.base_url` / `.api`, not under `model.base_url` (which is
 * often absent). e.g. `web-dev` → `model.provider: llama-swap` (no
 * model.base_url) but `providers.idlefill.base_url: http://127.0.0.1:8800/v1`
 * = adopted. Scanning every `base_url:`/`api:` value is the only way to tag
 * such a profile adopted; the published provider/base_url DISPLAY fields
 * still come strictly from the `model` block, as the issue specifies.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type ProfilePosture = 'adopted' | 'external' | 'unset';

export interface AgentRosterRow {
  /** The profile directory name (one name per item, used consistently). */
  profile: string;
  posture: ProfilePosture;
  /** model.provider — display only; absent when the model block lacks it. */
  provider?: string;
  /**
   * The endpoint that justifies the posture: the loopback+aggregate URL for
   * `adopted`, model.base_url for `external`, absent for `unset`. Omitted
   * when it carries credential-looking userinfo.
   */
  base_url?: string;
}

// ---------------------------------------------------------------------------
// Minimal YAML surface (no dependency — the client has no yaml parser).
// Reads only the keys the roster needs. Best-effort by contract: any parse
// trouble yields undefined fields, never a throw, never a heartbeat break.
// ---------------------------------------------------------------------------

/** Strip a scalar value from a `key: value` line (handles quotes + blanks). */
function scalarValue(line: string, key: string): string | undefined {
  const m = line.match(new RegExp(`^\\s*${key}:\\s*(.*)$`));
  if (!m) return undefined;
  let v = (m[1] ?? '').trim();
  if (v === '') return undefined;
  if ((v.startsWith("'") && v.endsWith("'") && v.length >= 2) ||
      (v.startsWith('"') && v.endsWith('"') && v.length >= 2)) {
    v = v.slice(1, -1).trim();
  }
  if (v === '') return undefined;
  return v;
}

interface ModelBlock {
  /** Whether a top-level `model:` key was present. */
  present: boolean;
  provider?: string;
  base_url?: string;
}

/** The first `provider:`/`base_url:` inside the top-level `model:` block. */
function parseModelBlock(text: string): ModelBlock {
  const out: ModelBlock = { present: false };
  let inModel = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue; // comment
    if (/^\S/.test(line)) {
      // Top-level line: starts (model:) or ends the model block.
      if (/^model\s*:/.test(line)) {
        out.present = true;
        inModel = true;
      } else if (inModel) {
        inModel = false;
      }
      continue;
    }
    if (!inModel) continue;
    if (out.provider === undefined) out.provider = scalarValue(line, 'provider');
    if (out.base_url === undefined) out.base_url = scalarValue(line, 'base_url');
  }
  return out;
}

/** Every endpoint URL (`base_url:`/`api:`) at any depth — the posture set. */
function collectEndpointUrls(text: string): string[] {
  const urls: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue;
    const v = scalarValue(line, 'base_url') ?? scalarValue(line, 'api');
    if (v) urls.push(v);
  }
  return urls;
}

/** True when `url` names the loopback host on exactly `aggregatePort`. */
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
  const port = u.port !== '' ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80);
  return port === aggregatePort;
}

/** True when the URL's authority carries a userinfo (credential-looking). */
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
// Public surface
// ---------------------------------------------------------------------------

/**
 * Classify the profiles under `profilesDir` (the `~/.hermes/profiles`
 * directory). Returns `undefined` when the directory is absent or holds no
 * profile sub-directories (the caller omits the ADD-key); otherwise one row
 * per profile directory. Testable seam: the production entry point below
 * feeds this the real home.
 */
export function scanHermesProfilesAt(
  profilesDir: string,
  aggregatePort: number,
): AgentRosterRow[] | undefined {
  let entries: string[];
  try {
    const st = statSync(profilesDir);
    if (!st.isDirectory()) return undefined;
    entries = readdirSync(profilesDir);
  } catch {
    return undefined; // no Hermes home / unreadable → no report (key absent)
  }
  const rows: AgentRosterRow[] = [];
  for (const name of entries) {
    if (name.startsWith('.')) continue; // never publish hidden entries
    const profileDir = join(profilesDir, name);
    let isDir = false;
    try {
      isDir = statSync(profileDir).isDirectory();
    } catch {
      continue; // a stray non-directory entry is not a profile
    }
    if (!isDir) continue;

    // Read config.yaml best-effort. A missing/unreadable config is a real
    // profile with `unset` posture — never a throw, never a log.
    let text: string | null = null;
    try {
      text = readFileSync(join(profileDir, 'config.yaml'), 'utf-8');
    } catch {
      text = null;
    }

    if (text === null) {
      rows.push({ profile: name, posture: 'unset' });
      continue;
    }

    const model = parseModelBlock(text);
    const urls = collectEndpointUrls(text);
    const adoptedUrl = urls.find((u) => targetsAggregatePort(u, aggregatePort));

    let posture: ProfilePosture;
    let base_url: string | undefined;
    if (!model.present) {
      posture = 'unset'; // config exists but no model block
    } else if (adoptedUrl) {
      posture = 'adopted';
      base_url = hasUserInfo(adoptedUrl) ? undefined : adoptedUrl;
    } else {
      posture = 'external';
      base_url = model.base_url && hasUserInfo(model.base_url) ? undefined : model.base_url;
    }

    rows.push({
      profile: name,
      posture,
      ...(model.provider ? { provider: model.provider } : {}),
      ...(base_url ? { base_url } : {}),
    });
  }
  if (rows.length === 0) return undefined;
  return rows;
}

/**
 * Production entry point: scan `~/.hermes/profiles`. Returns `undefined`
 * when the Hermes home is absent (the register body then omits the key).
 */
export function scanHermesProfiles(aggregatePort: number): AgentRosterRow[] | undefined {
  return scanHermesProfilesAt(join(homedir(), '.hermes', 'profiles'), aggregatePort);
}
