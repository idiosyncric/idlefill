// update.ts — the machine-update INTENT store (mesh-update.md D2, LOCKED).
// The control relay's `update` verb lands HERE, never on an exec: an
// intent is a record the host-side updater helper (scripts/host-updater.mjs)
// claims and executes with the machine's OWN documented command. Nothing
// executable is stored or accepted — the intent names only who asked and
// when.
//
// Posture (same as EdgeStore, the sibling file next to the state):
//   - `update_intents.json`, 0600, atomic rename writes;
//   - a missing file loads empty (the normal path — no intents yet);
//     a corrupt file moves aside `.corrupt-*` and loads empty with a
//     stderr WARNING — the arbiter always boots fail-closed;
//   - capped at the last INTENTS_CAP entries (FIFO eviction);
//   - single-flight: at most ONE live (queued|running) intent;
//   - TTL: a queued intent no helper claims within UPDATE_INTENT_TTL_S
//     flips to `stale` on the next read/write — a forgotten click can
//     never fire a deploy hours later.

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

export type UpdateIntentState = 'queued' | 'running' | 'done' | 'failed' | 'stale';

export interface UpdateIntent {
  /** `u-<hex>` — the id the helper claims against. */
  id: string;
  /** The requester's instance id (the signed edge's source). */
  source_instance_id: string;
  requested_at: number;
  state: UpdateIntentState;
  started_at?: number;
  finished_at?: number;
  /** Named outcome detail (the helper's report; length-capped). */
  detail?: string;
}

const INTENTS_SCHEMA = 1;
export const INTENTS_CAP = 20;
export const UPDATE_INTENT_TTL_S = 300;

/** Default file: `update_intents.json` next to the state file. */
export function intentsFileOf(stateFile: string): string {
  return join(dirname(stateFile) || '.', 'update_intents.json');
}

interface IntentsFile {
  v: number;
  intents: UpdateIntent[];
}

function saneIntent(raw: unknown): UpdateIntent | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || r.id.trim() === '' || r.id.length > 64) return null;
  if (typeof r.source_instance_id !== 'string' || r.source_instance_id.length > 64) return null;
  const STATES: UpdateIntentState[] = ['queued', 'running', 'done', 'failed', 'stale'];
  if (typeof r.state !== 'string' || !STATES.includes(r.state as UpdateIntentState)) return null;
  const out: UpdateIntent = {
    id: r.id,
    source_instance_id: r.source_instance_id,
    requested_at: typeof r.requested_at === 'number' && Number.isFinite(r.requested_at) ? r.requested_at : 0,
    state: r.state as UpdateIntentState,
  };
  if (typeof r.started_at === 'number' && Number.isFinite(r.started_at)) out.started_at = r.started_at;
  if (typeof r.finished_at === 'number' && Number.isFinite(r.finished_at)) out.finished_at = r.finished_at;
  if (typeof r.detail === 'string' && r.detail !== '') out.detail = r.detail.slice(0, 500);
  return out;
}

export class UpdateIntents {
  private readonly filePath: string;
  private intents: UpdateIntent[] = [];

  /** Load (or start empty). Never throws — the EdgeStore posture. */
  constructor(filePath?: string) {
    this.filePath = filePath ?? intentsFileOf('./state.json');
    this.load();
  }

  get file(): string {
    return this.filePath;
  }

  private load(): void {
    this.intents = [];
    if (!existsSync(this.filePath)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as IntentsFile;
      if (parsed && parsed.v === INTENTS_SCHEMA && Array.isArray(parsed.intents)) {
        this.intents = parsed.intents.map(saneIntent).filter((x): x is UpdateIntent => x !== null);
      }
    } catch {
      const aside = `${this.filePath}.corrupt-${Date.now()}`;
      try {
        renameSync(this.filePath, aside);
        console.warn(`update-intents: corrupt file moved aside as ${aside}; loading empty`);
      } catch {
        console.warn('update-intents: corrupt file unreadable; loading empty');
      }
    }
  }

  private persist(): void {
    const dir = dirname(this.filePath);
    if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    const body: IntentsFile = { v: INTENTS_SCHEMA, intents: this.intents };
    const tmp = `${this.filePath}.tmp-${randomBytes(3).toString('hex')}`;
    writeFileSync(tmp, JSON.stringify(body, null, 2), { mode: 0o600 });
    try {
      chmodSync(tmp, 0o600);
      if (existsSync(this.filePath) && statSync(this.filePath).mode !== 0o600) chmodSync(this.filePath, 0o600);
    } catch {
      /* best effort on hardening */
    }
    renameSync(tmp, this.filePath);
  }

  /** Sweep queued intents past the TTL to `stale`; persist when touched. */
  sweep(now: number): void {
    let touched = false;
    for (const it of this.intents) {
      if (it.state === 'queued' && now - it.requested_at > UPDATE_INTENT_TTL_S * 1000) {
        it.state = 'stale';
        it.finished_at = now;
        it.detail = 'no host updater claimed it within the TTL';
        touched = true;
      }
    }
    if (touched) this.persist();
  }

  /** Newest-last list (display order). */
  list(now?: number): UpdateIntent[] {
    if (now !== undefined) this.sweep(now);
    return [...this.intents];
  }

  /** The single live (queued|running) intent, or null. */
  live(now?: number): UpdateIntent | null {
    if (now !== undefined) this.sweep(now);
    return this.intents.find((i) => i.state === 'queued' || i.state === 'running') ?? null;
  }

  /** Request an update (single-flight: null = one is already live). */
  add(sourceInstanceId: string, now: number): UpdateIntent | null {
    if (this.live(now)) return null;
    const it: UpdateIntent = {
      id: `u-${randomBytes(4).toString('hex')}`,
      source_instance_id: sourceInstanceId.slice(0, 64),
      requested_at: now,
      state: 'queued',
    };
    this.intents.push(it);
    while (this.intents.length > INTENTS_CAP) this.intents.shift();
    this.persist();
    return it;
  }

  /** queued → running (the helper's claim). False = not claimable. */
  claim(id: string, now: number): UpdateIntent | null {
    this.sweep(now);
    const it = this.intents.find((i) => i.id === id);
    if (!it || it.state !== 'queued') return null;
    it.state = 'running';
    it.started_at = now;
    this.persist();
    return it;
  }

  /** running → done | failed (the helper's report). Null = not reportable. */
  finish(id: string, ok: boolean, detail: string | undefined, now: number): UpdateIntent | null {
    const it = this.intents.find((i) => i.id === id);
    if (!it || it.state !== 'running') return null;
    it.state = ok ? 'done' : 'failed';
    it.finished_at = now;
    if (typeof detail === 'string' && detail.trim() !== '') it.detail = detail.trim().slice(0, 500);
    this.persist();
    return it;
  }

  /**
   * Crash tolerance: a RUNNING intent whose arbiter restarted mid-deploy
   * is ambiguous truth. `resetRunning` marks them failed with the named
   * reason at boot (the helper's report never landed) — never silently
   * back to queued (the deploy may well have happened).
   */
  markRunningAbandoned(now: number): UpdateIntent[] {
    const hit = this.intents.filter((i) => i.state === 'running');
    for (const it of hit) {
      it.state = 'failed';
      it.finished_at = now;
      it.detail = 'the arbiter restarted while the helper was running it — outcome unknown';
    }
    if (hit.length > 0) this.persist();
    return hit;
  }
}
