// Coarse host counters — the htop-equivalent slice the operator asked for
// (owner ask 2026-10-11, with the Machines-tab "This Machine" card). The
// arbiter reads these about ITS OWN machine from `node:os` at read time:
// no daemon, no exec of htop/nvidia-smi, no process list. Same coarse-by-
// construction posture as the mesh snapshot: aggregate counters only —
// load averages, cpu count, memory totals, uptime. Never per-process,
// per-disk or per-user detail. The GPU truth deliberately does NOT live
// here: it rides the engine load axis (llama-swap /metrics, strata
// /metrics — util/VRAM/power per engine row); a host-level nvidia-smi
// probe would duplicate the engine's own numbers from a worse vantage.
//
// Inside a Linux container (the urza deploy) /proc/loadavg and the memory
// totals are HOST-wide (not cgroup-namespaced) — exactly the machine-level
// reading intended; the process can see what it can see, and the
// dashboard labels the line accordingly.
//
// Discipline (same as every wire block here): per-KEY tolerance. A key the
// platform does not provide (e.g. loadavg on a platform without it) is
// ABSENT, never a fake zero; garbage from an untrusted peer is dropped per
// key, and an all-garbage block is ABSENT on the sanitized snapshot.

import * as os from 'node:os';

export interface HostStats {
  /** 1-minute load average (host-wide; not per-core normalized). */
  load1?: number;
  load5?: number;
  load15?: number;
  /** Logical cpu count (for reading the load averages against). */
  cpus?: number;
  /** Total / free physical memory in bytes (host-wide in a container). */
  mem_total_bytes?: number;
  mem_free_bytes?: number;
  /** Host uptime in seconds. */
  uptime_s?: number;
}

/** os.cpus() is static for the process's life — read it once. */
let cpuCount: number | undefined;

/** Collect THIS machine's coarse host block, per-KEY tolerant. */
export function collectHostStats(): HostStats {
  const out: HostStats = {};
  const avg = os.loadavg();
  const finite = (v: number): boolean => Number.isFinite(v) && v >= 0;
  if (Array.isArray(avg) && finite(avg[0]!)) out.load1 = Math.round(avg[0]! * 100) / 100;
  if (Array.isArray(avg) && finite(avg[1]!)) out.load5 = Math.round(avg[1]! * 100) / 100;
  if (Array.isArray(avg) && finite(avg[2]!)) out.load15 = Math.round(avg[2]! * 100) / 100;
  if (cpuCount === undefined) {
    const n = os.cpus().length;
    if (Number.isInteger(n) && n > 0) cpuCount = n;
  }
  if (cpuCount !== undefined) out.cpus = cpuCount;
  const total = os.totalmem();
  const free = os.freemem();
  if (finite(total) && total > 0) out.mem_total_bytes = Math.floor(total);
  if (finite(free) && free >= 0) out.mem_free_bytes = Math.floor(free);
  const up = os.uptime();
  if (finite(up) && up >= 0) out.uptime_s = Math.floor(up);
  return out;
}

/**
 * Validate + cap an UNTRUSTED peer's host block (the sanitizeSnapshot
 * discipline applied per key): non-numbers, negatives and absurd values
 * are dropped key by key; nothing credible → the whole block is ABSENT.
 */
export function sanitizeHostStats(raw: unknown): HostStats | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const out: HostStats = {};
  const num = (v: unknown, max: number): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max ? v : undefined;
  const load = num(r.load1, 1e6); if (load !== undefined) out.load1 = load;
  const l5 = num(r.load5, 1e6); if (l5 !== undefined) out.load5 = l5;
  const l15 = num(r.load15, 1e6); if (l15 !== undefined) out.load15 = l15;
  const cpus = num(r.cpus, 4096); if (cpus !== undefined) out.cpus = Math.floor(cpus);
  const memT = num(r.mem_total_bytes, 2 ** 53); if (memT !== undefined) out.mem_total_bytes = Math.floor(memT);
  const memF = num(r.mem_free_bytes, 2 ** 53); if (memF !== undefined) out.mem_free_bytes = Math.floor(memF);
  const up = num(r.uptime_s, 1e12); if (up !== undefined) out.uptime_s = Math.floor(up);
  return Object.keys(out).length > 0 ? out : undefined;
}
