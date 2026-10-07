/**
 * Atomic persistence for the arbiter's single state file.
 *
 * The state file is the ONLY persistence. Load at boot; every mutation goes
 * through `save` which writes to a tmp file in the same directory and
 * renames over the target (atomic on POSIX).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, statSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ArbiterState, ClientRecord } from './types.js';

export interface StateStoreOpts {
  /** Cap for the lease history kept in memory/file. */
  leaseHistoryCap?: number;
  /** Cap for the event log kept in memory/file. */
  eventCap?: number;
  /** Cap for result rows kept PER PROJECT (issue #4). */
  resultsPerProjectCap?: number;
}

export function emptyState(): ArbiterState {
  return {
    servers: [],
    model_aliases: {},
    projects: [],
    clients: [],
    overrides: {},
    sessions: [],
    session_overrides: {},
    session_pins: {},
    throttled_jobs: {},
    results: {},
    leases: [],
    budgets: {},
    events: [],
    last_activity: null,
    last_log_write: null,
    signal_degraded: false,
    degraded_reason: null,
    updated_at: Date.now(),
  };
}

export class StateStore {
  private readonly file: string;
  private readonly leaseHistoryCap: number;
  private readonly eventCap: number;
  /** Result rows kept per project (issue #4) — read by the arbiter on write. */
  readonly resultsPerProjectCap: number;
  state: ArbiterState;

  constructor(file: string, opts: StateStoreOpts = {}) {
    this.file = file;
    this.leaseHistoryCap = opts.leaseHistoryCap ?? 500;
    this.eventCap = opts.eventCap ?? 500;
    this.resultsPerProjectCap = opts.resultsPerProjectCap ?? 200;
    this.state = this.load();
  }

  private load(): ArbiterState {
    if (!existsSync(this.file)) return emptyState();
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf-8'));
      const base = emptyState();
      return {
        ...base,
        ...raw,
        // Tolerate older state files: client rows gain fields over time
        // (last_seen, projects) — normalize any row that predates them.
        clients: Array.isArray(raw.clients)
          ? (raw.clients as ClientRecord[]).map((c) => ({
              ...c,
              last_seen: typeof c.last_seen === 'number' ? c.last_seen : Date.parse(c.registered_at) || 0,
              projects: Array.isArray(c.projects) ? c.projects : [],
            }))
          : base.clients,
        // Tolerate state files from before client overrides existed.
        overrides: raw.overrides && typeof raw.overrides === 'object' ? raw.overrides : base.overrides,
        // Tolerate state files from before sessions / session overrides existed.
        sessions: Array.isArray(raw.sessions) ? raw.sessions : base.sessions,
        session_overrides: raw.session_overrides && typeof raw.session_overrides === 'object' ? raw.session_overrides : base.session_overrides,
        // Tolerate state files from before the session engine-pin plane (#67).
        session_pins: raw.session_pins && typeof raw.session_pins === 'object' ? raw.session_pins : base.session_pins,
        // Tolerate state files from before per-job throttling (anti-thrash)
        // existed.
        throttled_jobs: raw.throttled_jobs && typeof raw.throttled_jobs === 'object' ? raw.throttled_jobs : base.throttled_jobs,
        // Tolerate state files from before per-job result rows (issue #4)
        // existed.
        results: raw.results && typeof raw.results === 'object' ? raw.results : base.results,
        leases: Array.isArray(raw.leases) ? raw.leases : base.leases,
        budgets: raw.budgets && typeof raw.budgets === 'object' ? raw.budgets : base.budgets,
        events: Array.isArray(raw.events) ? raw.events : base.events,
        // Tolerate state files from before server connections existed
        // (seeded from config by the arbiter after load).
        servers: Array.isArray(raw.servers) ? raw.servers : base.servers,
        // Tolerate state files from before the model-alias plane (#66 D1)
        // existed.
        model_aliases: raw.model_aliases && typeof raw.model_aliases === 'object' ? raw.model_aliases : base.model_aliases,
        // Tolerate state files from before persisted project rows existed.
        projects: Array.isArray(raw.projects) ? raw.projects : base.projects,
      };
    } catch (err) {
      // A corrupt state file must not crash the arbiter — start clean and say so.
      console.error(`[state] WARNING: could not parse ${this.file} (${err}); starting with a fresh state`);
      try {
        renameSync(this.file, `${this.file}.corrupt-${Date.now()}`);
      } catch {
        // ignore
      }
      return emptyState();
    }
  }

  /** Persist atomically: tmp write in the same dir + rename. */
  save(): void {
    this.state.updated_at = Date.now();
    const dir = dirname(this.file);
    if (dir && dir !== '.' && !existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = `${this.file}.tmp-${process.pid}`;
    // The state file can carry per-server credentials (#60 B) — owner-only,
    // set on the TMP before the rename so the secret is never world-readable
    // even for the instant between write and rename.
    writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    try {
      chmodSync(tmp, 0o600); // an existing tmp with a wider mode keeps it — force
    } catch {
      /* best effort */
    }
    renameSync(tmp, this.file);
  }

  /** Trim history after mutations; call before save when you appended. */
  trim(): void {
    if (this.state.leases.length > this.leaseHistoryCap) {
      // Keep the most recent entries (file order: appended = newest last).
      this.state.leases = this.state.leases.slice(this.state.leases.length - this.leaseHistoryCap);
    }
    if (this.state.events.length > this.eventCap) {
      this.state.events = this.state.events.slice(this.state.events.length - this.eventCap);
    }
  }

  appendEvent(e: { kind: ArbiterState['events'][number]['kind']; project?: string; lease_id?: string; detail?: string }): void {
    this.state.events.push({ ts: Date.now(), ...e });
  }

  /** File size for diagnostics. */
  fileSize(): number | null {
    try {
      return statSync(this.file).size;
    } catch {
      return null;
    }
  }
}
