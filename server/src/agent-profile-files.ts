/**
 * agent-profile-files.ts — the mint hand-off's OPEN surface (owner ask
 * 2026-10-21): the one-time mint dialog offers a button per hand-off file
 * (the agent Hermes profile's `config.yaml` and `.env`); the arbiter
 * resolves the file under THIS machine's Hermes home and asks the OS
 * default association to open it, so the pasted block lands in its real
 * home instead of the operator hunting for the file.
 *
 * LOCAL-truth discipline (the same posture as GET /api/agent-roster): the
 * dashboard is served by this machine's own arbiter, so the route can only
 * honestly name files THIS box hosts. Cross-machine opening is the #55
 * fleet plane, not this module.
 *
 * Posture:
 *   - The target is ONLY `config.yaml` or `.env` DIRECTLY inside
 *     `<profiles>/<profile>` — the profile name is validated with the CLI's
 *     normalizeProfileName rules (cli/src/agent.ts, the naming authority:
 *     no separators, no `.`/`..`, no leading dot, no control bytes) and the
 *     joined path is then containment-checked against the profiles dir.
 *   - A missing FILE inside an existing profile is created EMPTY — the
 *     paste target must exist for the editor, and inventing zero bytes is
 *     honest; contents are never invented. A missing PROFILE directory is
 *     a named refusal, never a created one (the CLI connect posture:
 *     "no Hermes profile … Nothing was written").
 *   - The opener is the platform's default association: `open` (macOS),
 *     `xdg-open` (Linux), `start` via cmd (Windows). The child is detached
 *     and never awaited to close — an editor that stays open must not hold
 *     the request, and an opener that fails to launch (no handler) names
 *     the failure to the caller.
 */

import { spawn, type SpawnOptions, type ChildProcess } from 'node:child_process';
import { statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';

/** Which hand-off file to open: the Hermes profile's `config.yaml` or `.env`. */
export type AgentHandoffFile = 'config' | 'env';

const HANDOFF_FILE_NAMES: Record<AgentHandoffFile, string> = {
  config: 'config.yaml',
  env: '.env',
};

/**
 * The Hermes profiles dir — env override `IDLEFILL_HERMES_PROFILES_DIR`
 * (the same seam the CLI exposes in cli/src/agent.ts), else `~/.hermes/
 * profiles` (the same home client/src/agent-roster.ts scans).
 */
export function hermesProfilesDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.IDLEFILL_HERMES_PROFILES_DIR?.trim();
  return override || join(homedir(), '.hermes', 'profiles');
}

/** Ported verbatim in meaning from cli/src/agent.ts normalizeProfileName (the authority). */
export function normalizeAgentProfileName(raw: unknown): { ok: true; name: string } | { ok: false; reason: string } {
  if (typeof raw !== 'string') return { ok: false, reason: 'a profile name is required' };
  const name = raw;
  if (name.trim() === '') return { ok: false, reason: 'a profile name is required' };
  if (name !== name.trim()) return { ok: false, reason: `"${name.trim()}" — leading/trailing spaces are not the profile name` };
  if (/[\/\\\u0000-\u001f]/.test(name)) return { ok: false, reason: `"${name}" is not a single profile name — no path separators` };
  if (name === '.' || name === '..') return { ok: false, reason: `"${name}" is not a profile` };
  if (name.startsWith('.')) return { ok: false, reason: `"${name}" is hidden — the roster never publishes hidden entries and neither does this route` };
  return { ok: true, name };
}

/** The platform default-association opener for a path, or null (unsupported). */
export function platformOpenCommand(
  path: string,
  platform: NodeJS.Platform = process.platform,
): { cmd: string; args: string[] } | null {
  if (platform === 'darwin') return { cmd: 'open', args: [path] };
  if (platform === 'linux') return { cmd: 'xdg-open', args: [path] };
  if (platform === 'win32') return { cmd: 'cmd.exe', args: ['/c', 'start', '', path] };
  return null;
}

/** Injected in tests; the production shape is node's child_process.spawn. */
export type SpawnFn = (cmd: string, args: readonly string[], options?: SpawnOptions) => ChildProcess;

/**
 * Ask the OS to open `path` with its default handler. Resolves when the
 * opener PROCESS spawned (not when the editor closes — that may be never);
 * rejects with a named reason when the spawn fails or the platform has no
 * opener.
 */
export function openInDefaultEditor(
  path: string,
  deps: { platform?: NodeJS.Platform; spawnFn?: SpawnFn } = {},
): Promise<void> {
  const platform = deps.platform ?? process.platform;
  const spawnFn = deps.spawnFn ?? (spawn as SpawnFn);
  const opener = platformOpenCommand(path, platform);
  if (!opener) return Promise.reject(new Error(`no default opener for platform ${platform}`));
  return new Promise<void>((res, rej) => {
    let child: ChildProcess;
    try {
      child = spawnFn(opener.cmd, opener.args, { detached: true, stdio: 'ignore' });
    } catch (err) {
      rej(new Error(`${opener.cmd} failed to start: ${(err as Error).message}`));
      return;
    }
    // node fires 'spawn' once the process is actually up; 'error' covers
    // ENOENT (no handler on PATH). Either settles the request — the child's
    // lifetime is the editor's business, not the arbiter's.
    child.once('spawn', () => {
      child.unref();
      res();
    });
    child.once('error', (err) => rej(new Error(`${opener.cmd} failed to start: ${err.message}`)));
  });
}

export type OpenAgentHandoffResult =
  | { ok: true; path: string; created: boolean }
  | { ok: false; status: 400 | 404 | 500; error: string };

/**
 * The route's whole flow (pure of Fastify — testable with an injected
 * profiles dir via env and a fake spawn). Never throws; every refusal is
 * a named reason with an HTTP status for the route to carry.
 */
export async function openAgentHandoffFile(
  body: unknown,
  deps: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; spawnFn?: SpawnFn } = {},
): Promise<OpenAgentHandoffResult> {
  const input = (body ?? {}) as { profile?: unknown; file?: unknown };
  const pn = normalizeAgentProfileName(input.profile);
  if (!pn.ok) return { ok: false, status: 400, error: pn.reason };
  const name = pn.name;
  const file = input.file;
  if (file !== 'config' && file !== 'env') {
    return { ok: false, status: 400, error: `file must be "config" or "env" (got ${JSON.stringify(file) ?? 'undefined'})` };
  }

  const profilesDir = resolve(hermesProfilesDir(deps.env ?? process.env));
  let profilesIsDir = false;
  try {
    profilesIsDir = statSync(profilesDir).isDirectory();
  } catch {
    profilesIsDir = false;
  }
  if (!profilesIsDir) {
    return { ok: false, status: 404, error: `no Hermes profiles directory at ${profilesDir} on this machine` };
  }

  const profileDir = join(profilesDir, name);
  let profileIsDir = false;
  try {
    profileIsDir = statSync(profileDir).isDirectory();
  } catch {
    profileIsDir = false;
  }
  if (!profileIsDir) {
    return { ok: false, status: 404, error: `no Hermes profile "${name}" under ${profilesDir} on this machine — nothing was written` };
  }

  const filePath = resolve(join(profileDir, HANDOFF_FILE_NAMES[file]));
  // Belt-and-braces containment: the name validation already pins the shape,
  // but the joined path must still sit directly inside the profile dir.
  const rel = relative(profileDir, filePath);
  if (rel !== HANDOFF_FILE_NAMES[file] || isAbsolute(rel) || rel.startsWith('..')) {
    return { ok: false, status: 400, error: 'the resolved path escaped the profile directory — refused' };
  }

  let created = false;
  let isFile = false;
  try {
    isFile = statSync(filePath).isFile();
  } catch {
    isFile = false;
  }
  if (!isFile) {
    // Create the empty paste target (wx: never clobber a racing creation).
    try {
      writeFileSync(filePath, '', { flag: 'wx' });
      created = true;
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== 'EEXIST') {
        return { ok: false, status: 500, error: `cannot create ${filePath} (${e.message})` };
      }
    }
  }

  try {
    await openInDefaultEditor(filePath, deps);
  } catch (err) {
    return { ok: false, status: 500, error: (err as Error).message };
  }
  return { ok: true, path: filePath, created };
}
