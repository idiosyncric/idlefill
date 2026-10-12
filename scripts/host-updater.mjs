#!/usr/bin/env node
// host-updater.mjs — the per-machine updater helper (mesh-update.md D3).
// The arbiter only RECORDS update intents; THIS helper is where a machine's
// update actually executes. Loop:
//
//   1. GET the LOCAL arbiter's /api/update-intents (local admin token from
//      the 0600 config — the token never crosses any wire beyond loopback),
//   2. claim exactly one queued intent (the arbiter's single-flight makes
//      the claim atomic — two helpers can never double-run an update),
//   3. run the machine's OWN documented update command,
//   4. report: POST /api/update-intents/:id/result { ok, detail }.
//
// What "update" means is a per-machine constant owned HERE, never on the
// wire (D2): a compromised controller cannot name what runs. The helper
// REFUSES to start when the command is unset — an unconfigured helper never
// executes anything.
//
// Config: IDLEFILL_UPDATER_CONFIG or ~/.idlefill/updater.json, mode 0600:
//   {
//     "arbiter_url": "http://127.0.0.1:8787",
//     "token": "<arbiter api_token>",
//     "command": "bash $HOME/idlefill/src/scripts/urza-selfupdate.sh",
//     "poll_s": 15
//   }
// macOS boxes point `command` at the checkout's ./update.sh instead.
//
// Supervised (systemd user unit / LaunchAgent — deploy/install-updater-
// service.sh renders it). Logs go to stdout/stderr (journald/launchd
// capture). A SIGTERM during a running update lands after the command
// exits; an arbiter that restarts mid-deploy names its running intent
// failed with "outcome unknown" — never silently re-queues it.

import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const cfgPath = process.env.IDLEFILL_UPDATER_CONFIG || join(homedir(), ".idlefill", "updater.json");
const log = (m) => console.log(`${new Date().toISOString()} ${m}`);
const die = (m) => {
  console.error(`${new Date().toISOString()} REFUSED: ${m}`);
  process.exit(1);
};

let raw;
try {
  raw = JSON.parse(readFileSync(cfgPath, "utf8"));
} catch (e) {
  die(`cannot read config ${cfgPath}: ${e.message}`);
}
try {
  const mode = statSync(cfgPath).mode & 0o777;
  if (mode & 0o077) die(`${cfgPath} is group/world-accessible (mode ${mode.toString(8)}) — the config holds the arbiter token; chmod 600 it`);
} catch (e) {
  die(`cannot stat config ${cfgPath}: ${e.message}`);
}
const base = typeof raw.arbiter_url === "string" ? raw.arbiter_url.replace(/\/+$/, "") : "";
const token = typeof raw.token === "string" ? raw.token : "";
const command = typeof raw.command === "string" ? raw.command.trim() : "";
const pollMs = (Number.isFinite(raw.poll_s) && raw.poll_s > 0 ? raw.poll_s : 15) * 1000;
if (!base) die("config missing arbiter_url (the LOCAL arbiter, e.g. http://127.0.0.1:8787)");
if (!token) die("config missing token (the local arbiter api_token)");
if (!command) die("config missing command — this machine's documented update command (mesh-update.md D3: an unconfigured helper never executes anything)");

const api = async (path, init = {}) =>
  fetch(`${base}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(15_000),
  });

const runOnce = async () => {
  const res = await api("/api/update-intents");
  if (!res.ok) {
    log(`intents list refused: HTTP ${res.status} — is the arbiter configured with an api_token matching the helper?`);
    return;
  }
  const intents = (await res.json()).intents ?? [];
  const queued = intents.find((i) => i.state === "queued"); // list is oldest→newest
  if (!queued) return;
  log(`claiming ${queued.id} (requested by ${queued.source_instance_id})`);
  const claim = await api(`/api/update-intents/${encodeURIComponent(queued.id)}/claim`, { method: "POST" });
  if (!claim.ok) {
    log(`claim ${queued.id} refused: HTTP ${claim.status} (gone, stale, or already claimed)`);
    return;
  }
  log(`running update command: ${command}`);
  const r = spawnSync(command, { shell: "/bin/bash", encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  const tail = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim().split("\n").slice(-8).join(" · ").slice(-400);
  const ok = !r.error && r.status === 0;
  const detail = ok ? (tail || "exit 0") : `${r.error ? r.error.message : `exit ${r.status}`}${tail ? ` — ${tail}` : ""}`;
  log(`update ${ok ? "succeeded" : "FAILED"}: ${detail}`);
  try {
    const rep = await api(`/api/update-intents/${encodeURIComponent(queued.id)}/result`, {
      method: "POST",
      body: JSON.stringify({ ok, detail }),
    });
    if (!rep.ok) log(`result report refused: HTTP ${rep.status} (the intent was not RUNNING — outcome already named elsewhere)`);
  } catch (e) {
    log(`result report failed to send: ${e.message} — the arbiter will name this intent abandoned if it restarts`);
  }
};

log(`host-updater watching ${base} every ${Math.round(pollMs / 1000)}s (config ${cfgPath})`);
for (;;) {
  try {
    await runOnce();
  } catch (e) {
    log(`poll error: ${e.message}`);
  }
  await new Promise((r) => setTimeout(r, pollMs));
}
