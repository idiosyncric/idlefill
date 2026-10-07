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
