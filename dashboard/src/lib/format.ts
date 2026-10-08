// Formatting helpers — same wording rules as the legacy dashboard
// (DESIGN.md: plain words, exception-only color).

export function ago(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s ago`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m ago`;
}

export function fmt(n: number): string {
  return n.toLocaleString();
}

// Duration as "~Xh Ym" (the estimate passed to the arbiter at grant time).
export function durFmt(s: number | null | undefined): string {
  if (!s || s <= 0) return "";
  if (s < 60) return `~${Math.round(s)}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `~${m}m`;
  const h = Math.floor(m / 60);
  return `~${h}h${m % 60 ? " " + (m % 60) + "m" : ""}`;
}

// Plain m/s, no tilde (lease countdowns and running ages).
export function minSec(s: number): string {
  const n = Math.max(0, Math.floor(s));
  const m = Math.floor(n / 60);
  return `${m}m ${n % 60}s`;
}

export type StateWord = { label: string; tone: "ok" | "warn" | "err" | "accent" | "dim"; note: string };

export function liveWord(signal: { idle: boolean; degraded?: boolean } | null, running: boolean): StateWord {
  if (!signal) return { label: "not watched", tone: "dim", note: "declared, but the core has no idle detector for this row" };
  if (signal.degraded) return { label: "Degraded", tone: "err", note: "signal degraded — grants blocked" };
  if (running) return { label: "Running Idle Tasks", tone: "accent", note: "background work in progress" };
  if (signal.idle) return { label: "Idle", tone: "ok", note: "grants open" };
  return { label: "Busy", tone: "warn", note: "grants blocked" };
}

export const PROVIDER_CHOICES: [string, string][] = [
  ["llama-swap", "llama-swap (activity feed)"],
  ["strata", "strata (/metrics counters — works remote)"],
  ["omlx", "oMLX (log mtime + usage store — same machine only)"],
];

// ---------------------------------------------------------------------------
// Gate option text (fixed — the live state lives in the separate state word).
// Same two-option language across the engine / project / worker gates.
// ---------------------------------------------------------------------------

export function gateLabelText(mode: "paused" | "scheduled"): string {
  return mode === "paused" ? "Engine Paused" : "Engine Running";
}
export function projGateLabelText(mode: "paused" | "scheduled"): string {
  return mode === "paused" ? "Project Paused" : "Project Running";
}
export function sessGateLabelText(mode: "paused" | "running" | "forced"): string {
  return mode === "paused" ? "Session Paused" : mode === "forced" ? "Session Forced" : "Session Running";
}

// The session state word: paused (operator override) > active (online + a
// request within 30s) > idle. Stale is NOT a word — it is the exception tag
// on a row whose 90s heartbeat lapsed.
const SESSION_ONLINE_MS = 90_000;
const SESSION_ACTIVE_MS = 30_000;

export function sessStateWord(
  sess: { last_seen: number; last_activity: number | null; override?: { override: "pause" | "force" } | null },
  now: number,
): StateWord {
  if (sess.override?.override === "pause") {
    return { label: "Paused", tone: "warn", note: "paused — the router holds this session's traffic" };
  }
  const online = now - (sess.last_seen ?? 0) < SESSION_ONLINE_MS;
  const act = sess.last_activity;
  if (online && act !== null && now - act < SESSION_ACTIVE_MS) {
    return { label: "Active", tone: "ok", note: "a request was seen on this session just now" };
  }
  return { label: "Idle", tone: "dim", note: "no request seen on this session recently" };
}

export function sessStale(sess: { last_seen: number }, now: number): boolean {
  return now - (sess.last_seen ?? 0) >= SESSION_ONLINE_MS;
}

// The 90s liveness precedent (client workers, session rows, launcher hosts).
export function isOnline(lastSeen: number | undefined, now: number): boolean {
  return typeof lastSeen === "number" && now - lastSeen < 90_000;
}

// Cycle status word (the dev-cycle strip): done > running > paused > planned.
export function cycleTone(status: "planned" | "running" | "paused" | "done"): "ok" | "accent" | "warn" | "dim" {
  if (status === "done") return "ok";
  if (status === "running") return "accent";
  if (status === "paused") return "warn";
  return "dim";
}
