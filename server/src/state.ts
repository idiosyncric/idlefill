/**
 * Atomic persistence for the arbiter's single state file.
 *
 * The state file is the ONLY persistence. Load at boot; every mutation goes
 * through `save` which writes to a tmp file in the same directory and
 * renames over the target (atomic on POSIX).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ArbiterState } from './types.js';

export interface StateStoreOpts {
  /** Cap for the lease history kept in memory/file. */
  leaseHistoryCap?: number;
  /** Cap for the event log kept in memory/file. */
  eventCap?: number;
}

export function emptyState(): ArbiterState {
  return {
    clients: [],
    overrides: {},
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
  state: ArbiterState;

  constructor(file: string, opts: StateStoreOpts = {}) {
    this.file = file;
    this.leaseHistoryCap = opts.leaseHistoryCap ?? 500;
    this.eventCap = opts.eventCap ?? 500;
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
        clients: Array.isArray(raw.clients) ? raw.clients : base.clients,
        // Tolerate state files from before client overrides existed.
        overrides: raw.overrides && typeof raw.overrides === 'object' ? raw.overrides : base.overrides,
        leases: Array.isArray(raw.leases) ? raw.leases : base.leases,
        budgets: raw.budgets && typeof raw.budgets === 'object' ? raw.budgets : base.budgets,
        events: Array.isArray(raw.events) ? raw.events : base.events,
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
    writeFileSync(tmp, JSON.stringify(this.state, null, 2));
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
