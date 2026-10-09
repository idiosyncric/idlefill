/**
 * busy-veto.test.ts — #52 slice 3: the monotonic busy veto (D2/D3/D4).
 *
 * Covers, with real fixtures (no network, no FS for the collector path;
 * a temp state file for the grant gate):
 *   - NO knob / no reading / no loadView → NO `load_busy`, and the
 *     verdict is byte-for-byte the pre-#52 detector output (D2: the
 *     load axis is inert until the owner sets a number);
 *   - a FRESH strata busy read (live.state generating) VETOES: the feed
 *     says idle, the engine reads busy, `idle` is false, the grant is
 *     denied with reason 'load_busy' (D2 rule 4);
 *   - a STALE busy read is UNKNOWN: `load_busy` absent, the verdict
 *     stands on the feed and mtime (D2 rule 2 / D3);
 *   - llama-swap WITH the owner's knob set: gpu ABOVE it vetoes, gpu
 *     BELOW (or AT) it does not (D4);
 *   - the HARD RULE (D2 rule 1): a busy read can only DELAY a grant —
 *     it never makes a busy engine read idle, and a fresh load_busy
 *     false never forces idle (the feed+mtime basis stands);
 *   - the feed-degraded fail-closed plane is untouched (D2 rule 3):
 *     `signal_degraded` is never read from the load axis;
 *   - config: the knob has NO default (unset = no predicate), and a
 *     non-positive / garbage value is refused (unset), never coerced.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IdleDetector } from '../src/idle.js';
import {
  LoadCollector,
  loadBusyFor,
  parseStrataLoadState,
  type LoadReading,
  type LoadResponseLike,
  type LoadSignalView,
} from '../src/load.js';
import { Arbiter, WATCHED_SERVER_ID } from '../src/arbiter.js';
import { StateStore } from '../src/state.js';
import { DEFAULTS, applyDefaults } from '../src/config.js';
import type { ActivityEntry, IdleSignal, ServerConfig } from '../src/types.js';

const T0 = Date.parse('2026-10-09T06:00:00Z');

// ---------------------------------------------------------------------------
// Fixtures.

/** The captured llama-swap /metrics body (gpu_util 91) from load-capture. */
const LLAMASWAP_METRICS = `# HELP llamaswap_gpu_util_percent GPU utilization percent (0-100)
# TYPE llamaswap_gpu_util_percent gauge
llamaswap_gpu_util_percent{id="0",name="NVIDIA GeForce RTX 5090"} 91
llamaswap_gpu_memory_used_bytes 3.2656850944e+10
llamaswap_gpu_memory_total_bytes 3.4190917632e+10
`;
/** A cooler llama-swap /metrics body (gpu_util 12). */
const LLAMASWAP_METRICS_COOL = `llamaswap_gpu_util_percent 12
llamaswap_gpu_memory_used_bytes 1000
llamaswap_gpu_memory_total_bytes 10000
`;
/** A strata /metrics body with a generation in flight. */
const STRATA_BUSY = JSON.stringify({
  time: 1791396000,
  engine: { model: 'qwen3.8-flash-next-q2_0' },
  live: { state: 'generating' },
  requests: [],
  totals: { since: 1, requests: 42, prompt_tokens: 100, reused: 0, output_tokens: 200 },
});
/** A strata /metrics body with the single slot idle. */
const STRATA_IDLE = JSON.stringify({
  time: 1791396000,
  engine: { model: 'qwen3.8-flash-next-q2_0' },
  live: { state: 'idle' },
  requests: [],
  totals: { since: 1, requests: 42, prompt_tokens: 100, reused: 0, output_tokens: 200 },
});

// ---------------------------------------------------------------------------
// The D4 predicate (pure function of kind + reading + threshold).

function strataReading(state: string): LoadReading {
  return { strata_live_state: state, in_flight: state === 'idle' || state === 'stopped' || state === 'none' ? 0 : 1, load_source: 'strata-metrics', read_at: T0 };
}
function llamaReading(gpu: number | undefined): LoadReading {
  return { ...(gpu !== undefined ? { gpu_util_percent: gpu } : {}), load_source: 'llamaswap-metrics', read_at: T0 };
}

test('D4 strata predicate: live.state not in {idle, stopped, none} means busy', () => {
  assert.equal(loadBusyFor('strata', strataReading('generating')), true);
  assert.equal(loadBusyFor('strata', strataReading('waiting')), true);
  assert.equal(loadBusyFor('strata', strataReading('idle')), false);
  assert.equal(loadBusyFor('strata', strataReading('stopped')), false);
  assert.equal(loadBusyFor('strata', strataReading('none')), false);
  // No state (no `live` object) → UNKNOWN, never a fake idle.
  assert.equal(loadBusyFor('strata', { load_source: 'strata-metrics', read_at: T0 }), null);
});

test('D4 llama-swap predicate: gpu ABOVE the owner-set knob; absent knob = no predicate', () => {
  // Knob unset → UNKNOWN (the kind has no predicate, the veto is inert).
  assert.equal(loadBusyFor('llama-swap', llamaReading(99), undefined), null);
  // Knob set at 80: above vetoes, at and below do not.
  assert.equal(loadBusyFor('llama-swap', llamaReading(91), 80), true);
  assert.equal(loadBusyFor('llama-swap', llamaReading(80), 80), false, 'AT the number is not busy');
  assert.equal(loadBusyFor('llama-swap', llamaReading(12), 80), false);
  // No gauge on the read → UNKNOWN (never a fake zero).
  assert.equal(loadBusyFor('llama-swap', llamaReading(undefined), 80), null);
  // Non-positive / garbage threshold is refused (unset), never coerced.
  assert.equal(loadBusyFor('llama-swap', llamaReading(91), 0), null);
  assert.equal(loadBusyFor('llama-swap', llamaReading(91), -5), null);
});

test('D4 oMLX predicate: none (identity/residency, not load)', () => {
  assert.equal(loadBusyFor('omlx', { omlx_loaded_count: 3, load_source: 'omlx-health', read_at: T0 }), null);
  assert.equal(loadBusyFor('omlx', llamaReading(99), 80), null, 'the kind wins over the input');
});

// ---------------------------------------------------------------------------
// The collector's freshness gate: load_busy is PRESENT only on a FRESH read.

function llamaswapCollector(text: string, threshold?: number) {
  return new LoadCollector({
    url: 'http://100.105.225.1:11434',
    provider: 'llama-swap',
    stale_window_ms: 45_000, // the D3 default window
    ...(threshold !== undefined ? { llama_swap_busy_gpu_percent: threshold } : {}),
    transport: (async (_url: string) => ({ status: 200, ok: true, text: async () => text })) as unknown as (u: string, o?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<LoadResponseLike>,
  });
}

test('collector: a FRESH llama-swap read with the knob set publishes load_busy (true above, false below)', async () => {
  const c = llamaswapCollector(LLAMASWAP_METRICS, 80);
  await c.read(T0, null);
  const v = c.current(T0)!;
  assert.equal(v.load_source, 'llamaswap-metrics');
  assert.equal(v.gpu_util_percent, 91);
  assert.equal(v.load_age_s, 0);
  assert.equal(v.load_busy, true, '91 > 80 → busy');

  const c2 = llamaswapCollector(LLAMASWAP_METRICS_COOL, 80);
  await c2.read(T0, null);
  assert.equal(c2.current(T0)!.load_busy, false, '12 < 80 → not busy');
});

test('collector: the knob UNSET → no load_busy (the kind has no predicate), data still rides', async () => {
  const c = llamaswapCollector(LLAMASWAP_METRICS, undefined); // no knob
  await c.read(T0, null);
  const v = c.current(T0)!;
  assert.equal(v.gpu_util_percent, 91, 'the gauge is captured (display + sample)');
  assert.equal('load_busy' in v, false, 'no knob → the key is ABSENT, never a fake false');
});

test('collector: a STALE busy read is UNKNOWN — load_busy absent, the data keys still ride (D3)', async () => {
  const c = llamaswapCollector(LLAMASWAP_METRICS, 80);
  await c.read(T0, null);
  assert.equal(c.current(T0)!.load_busy, true, 'fresh at T0 → busy');
  // 46s later the same reading is past the 45s window → unknown.
  const v = c.current(T0 + 46_000)!;
  assert.equal('load_busy' in v, false, 'stale → the key is absent (D2 rule 2)');
  assert.equal(v.gpu_util_percent, 91, 'the data keys still ride (the operator sees why)');
  assert.equal(v.load_age_s, 46);
});

test('collector: strata FRESH busy publishes load_busy true; FRESH idle publishes load_busy false', async () => {
  const mk = (body: string) =>
    new LoadCollector({
      url: 'http://10.10.10.6:8080',
      provider: 'strata',
      stale_window_ms: 45_000,
      transport: (async (_u: string) => ({ status: 200, ok: true, text: async () => body })) as never,
    });
  const cb = await mk(STRATA_BUSY);
  await cb.read(T0, null);
  const vb = cb.current(T0)!;
  assert.equal(vb.load_source, 'strata-metrics');
  assert.equal(vb.in_flight, 1);
  assert.equal(vb.load_busy, true, 'live.state generating → busy');
  const ci = await mk(STRATA_IDLE);
  await ci.read(T0, null);
  const vi = ci.current(T0)!;
  assert.equal(vi.in_flight, 0);
  assert.equal(vi.load_busy, false, 'live.state idle → not busy');
});

// ---------------------------------------------------------------------------
// parseStrataLoadState (pinned against the payload shape).

test('parseStrataLoadState: the live slot, verbatim; no live object → null (unknown)', () => {
  assert.equal(parseStrataLoadState(JSON.parse(STRATA_BUSY)), 'generating');
  assert.equal(parseStrataLoadState(JSON.parse(STRATA_IDLE)), 'idle');
  assert.equal(parseStrataLoadState({ live: { state: ' WAITING ' } }), 'waiting', 'trimmed + lower-cased');
  assert.equal(parseStrataLoadState({}), null);
  assert.equal(parseStrataLoadState({ live: { state: '' } }), null);
  assert.equal(parseStrataLoadState(null), null);
});

// ---------------------------------------------------------------------------
// THE VERDICT PROOF: inert by default (no knob means no load_busy, the
// verdict is byte-for-byte what it is today), and monotonic when armed.

const VERDICT_KEYS = ['now', 'idle', 'idle_for_s', 'last_activity', 'last_log_write', 'signal_degraded', 'degraded_reason', 'feed_enabled', 'no_signal_reason'] as const;
function verdictOnly(sig: IdleSignal): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of VERDICT_KEYS) out[k] = sig[k];
  return out;
}
function entry(tsSecAgo: number): ActivityEntry {
  return {
    id: 1,
    timestamp: new Date(T0 - tsSecAgo * 1000).toISOString(),
    src: 'ip:10.0.0.5',
    model: 'Qwen3.8-27B',
    req_path: '/v1/chat/completions',
    resp_status_code: 200,
  };
}
function idleDetector(entries: ActivityEntry[] | 'fail'): IdleDetector {
  return new IdleDetector({
    fetchActivity: async () => {
      if (entries === 'fail') throw new Error('ECONNRESET');
      return entries;
    },
    logMtime: () => null,
    llama_swap_url: 'http://fake',
    activity_path: '/api/metrics/activity',
    log_glob: '',
    idle_seconds: 300,
  });
}

/** The load axis as the arbiter sees it (the tick's per-row view). */
function loadViewOf(collector: LoadCollector | null) {
  return (row: { id: string }, now: number): LoadSignalView | null =>
    collector ? collector.current(now) : null;
}

function makeArbiter(opts: {
  entries?: ActivityEntry[] | 'fail';
  loadView?: (row: { id: string }, now: number) => LoadSignalView | null;
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'idlefill-busy-veto-'));
  const store = new StateStore(join(dir, 'state.json'));
  const cfg: ServerConfig = {
    listen: 0,
    api_tokens: ['t'],
    llama_swap_url: 'http://fake',
    activity_path: '/api/metrics/activity',
    log_glob: '',
    idle_seconds: 300,
    poll_ms: 15000,
    lease_ttl_seconds: 1800,
    lease_ttl_safety_factor: 2,
    lease_ttl_floor_seconds: 60,
    max_concurrent_leases: 1,
    job_fail_threshold: 5,
    job_cooldown_seconds: 300,
    projects: [{ name: 'career-ops', paused: false, daily_token_cap: 1000 }],
    state_file: join(dir, 'state.json'),
  };
  const det = idleDetector(opts.entries ?? [entry(400)]); // 400s quiet > 300s
  const arbiter = new Arbiter(store, cfg, det, {
    ...(opts.loadView ? { loadView: opts.loadView as never } : {}),
  });
  arbiter.registerClient('mac', '127.0.0.1', '100.94.165.102');
  return { dir, store, cfg, det, arbiter, client: store.state.clients[0]! };
}

const grant = (h: ReturnType<typeof makeArbiter>, now: number, job = 'job-1') =>
  h.arbiter.requestLease({ client_id: h.client.client_id, project: 'career-ops', job_id: job, estimated_seconds: 60, now });

/**
 * The faithful tick order (index.ts tickOnce): the feed poll populates the
 * detector's internal signals, THEN the load read runs, THEN the signal is
 * read. The arbiter reads the detector's INTERNAL state (no re-poll), so
 * the harness must poll at the evaluation `now` before reading the
 * signal — exactly what a tick does.
 */
async function sigAt(
  h: ReturnType<typeof makeArbiter>,
  now: number,
): Promise<IdleSignal> {
  await h.det.poll(now, new Set());
  const sig = h.arbiter.serverSignalVetoed(WATCHED_SERVER_ID, now);
  if (!sig) throw new Error('no signal for the watched server');
  return sig;
}

test('INERT BY DEFAULT: no knob / no load axis → no load_busy, the verdict is unchanged', async () => {
  // The pre-#52 baseline: the bare detector verdict.
  const baseline = await idleDetector([entry(400)]).poll(T0, new Set());

  // An arbiter with NO loadView wired at all (every existing test).
  const h = makeArbiter();
  const sig = await sigAt(h, T0);
  assert.equal('load_busy' in (sig as Record<string, unknown>), false, 'no load axis → the key is absent');
  assert.deepEqual(JSON.stringify(verdictOnly(sig)), JSON.stringify(verdictOnly(baseline)), 'the verdict is byte-for-byte the pre-#52 output');
  assert.equal(sig.idle, true);
  // The grant goes through (the veto is inert).
  const r = grant(h, T0);
  assert.equal(r.ok, true, `expected a grant, got ${JSON.stringify(r)}`);
  rmSync(h.dir, { recursive: true, force: true });
});

test('INERT BY DEFAULT: a llama-swap collector with NO knob → no load_busy, verdict unchanged', async () => {
  const c = llamaswapCollector(LLAMASWAP_METRICS, undefined); // 91% gpu, no knob
  await c.read(T0, null);
  const h = makeArbiter({ loadView: loadViewOf(c) });
  const sig = await sigAt(h, T0);
  assert.equal('load_busy' in (sig as Record<string, unknown>), false, 'no knob → no predicate → the key is absent');
  assert.equal(sig.idle, true, 'the verdict is unchanged (the knob is the owner\'s switch)');
  assert.equal(grant(h, T0).ok, true, 'the grant is not delayed while the knob is unset');
  rmSync(h.dir, { recursive: true, force: true });
});

test('a FRESH strata busy read VETOES: feed idle, engine busy, grant denied with reason load_busy', async () => {
  const c = new LoadCollector({
    url: 'http://10.10.10.6:8080',
    provider: 'strata',
    stale_window_ms: 45_000,
    transport: (async (_u: string) => ({ status: 200, ok: true, text: async () => STRATA_BUSY })) as never,
  });
  await c.read(T0, null);
  const h = makeArbiter({ loadView: loadViewOf(c) });
  const sig = await sigAt(h, T0);
  assert.equal(sig.load_source, 'strata-metrics');
  assert.equal(sig.load_busy, true, 'a fresh busy read rides the signal');
  assert.equal(sig.idle_for_s, 400, 'the feed basis is still idle (idle_for unchanged)');
  assert.equal(sig.idle, false, 'the veto flips the verdict (D2 rule 4)');
  assert.equal(sig.signal_degraded, false, 'the load axis never degrades (D2 rule 3)');
  const r = grant(h, T0);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'load_busy', 'the denial names the load axis, not the feed');
  rmSync(h.dir, { recursive: true, force: true });
});

test('a STALE busy read is UNKNOWN and does not veto (D2 rule 2 / D3)', async () => {
  const c = llamaswapCollector(LLAMASWAP_METRICS, 80);
  await c.read(T0, null); // busy at T0
  const h = makeArbiter({ loadView: loadViewOf(c) });
  // 46s later: the reading is past the 45s window → unknown.
  const sig = await sigAt(h, T0 + 46_000);
  assert.equal('load_busy' in (sig as Record<string, unknown>), false, 'stale → the key is absent');
  assert.equal(sig.load_age_s, 46, 'the age still rides (the operator sees why the veto is absent)');
  assert.equal(sig.idle, true, 'the verdict stands on the feed and mtime');
  const r = grant(h, T0 + 46_000);
  assert.equal(r.ok, true, `the grant is not blocked by a stale read, got ${JSON.stringify(r)}`);
  rmSync(h.dir, { recursive: true, force: true });
});

test('llama-swap WITH the knob set: gpu ABOVE vetoes, gpu BELOW does not', async () => {
  const cHot = llamaswapCollector(LLAMASWAP_METRICS, 80); // 91
  await cHot.read(T0, null);
  const hHot = makeArbiter({ loadView: loadViewOf(cHot) });
  const sigHot = await sigAt(hHot, T0);
  assert.equal(sigHot.load_busy, true);
  assert.equal(sigHot.idle, false);
  assert.equal(grant(hHot, T0).reason, 'load_busy');
  rmSync(hHot.dir, { recursive: true, force: true });

  const cCool = llamaswapCollector(LLAMASWAP_METRICS_COOL, 80); // 12
  await cCool.read(T0, null);
  const hCool = makeArbiter({ loadView: loadViewOf(cCool) });
  const sigCool = await sigAt(hCool, T0);
  assert.equal(sigCool.load_busy, false, 'a fresh read says not busy');
  assert.equal(sigCool.idle, true, 'the feed+mtime basis stands');
  assert.equal(grant(hCool, T0).ok, true);
  rmSync(hCool.dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// THE HARD RULE (D2 rule 1): a busy read can only DELAY a grant — it never
// makes a busy engine read idle, and a fresh load_busy false never forces
// idle (the feed+mtime basis stands).

test('D2 rule 1: a busy read never makes a busy engine read idle (the veto only delays)', async () => {
  // The feed says BUSY (fresh foreign activity) and the load read is busy.
  const c = llamaswapCollector(LLAMASWAP_METRICS, 80); // 91
  await c.read(T0, null);
  const hBusy = makeArbiter({ entries: [entry(10)], loadView: loadViewOf(c) });
  const sigBusy = await sigAt(hBusy, T0);
  assert.equal(sigBusy.idle, false, 'the feed alone already says busy');
  assert.equal(sigBusy.idle_for_s, 10, 'idle_for is the feed basis, untouched by the veto');
  assert.equal(sigBusy.load_busy, true);
  // The engine is busy; the veto must not make it read idle. (It already
  // reads not-idle — the veto cannot flip false→true.)
  assert.equal(sigBusy.idle, false, 'a busy read cannot make a busy engine read idle');
  rmSync(hBusy.dir, { recursive: true, force: true });
});

test('D2 rule 1: a fresh load_busy false NEVER forces idle (the feed+mtime basis stands)', async () => {
  // The feed says BUSY (fresh foreign activity); the load read says not busy.
  const c = llamaswapCollector(LLAMASWAP_METRICS_COOL, 80); // 12 → not busy
  await c.read(T0, null);
  const h = makeArbiter({ entries: [entry(10)], loadView: loadViewOf(c) });
  const sig = await sigAt(h, T0);
  assert.equal(sig.load_busy, false, 'a fresh read says not busy');
  assert.equal(sig.idle, false, 'a false load_busy must not force idle — the feed says busy');
  assert.equal(sig.idle_for_s, 10);
  rmSync(h.dir, { recursive: true, force: true });
});

test('D2 rule 3: a dead /metrics + busy knob NEVER degrades the verdict (fail-closed untouched)', async () => {
  // The feed is dead (degraded), the load read fails (no reading).
  const dead = new LoadCollector({
    url: 'http://100.105.225.1:11434',
    provider: 'llama-swap',
    stale_window_ms: 45_000,
    llama_swap_busy_gpu_percent: 80,
    transport: (async () => { throw new Error('ECONNREFUSED'); }) as never,
  });
  await dead.read(T0, null); // no reading
  const h = makeArbiter({ entries: 'fail', loadView: loadViewOf(dead) });
  const sig = await sigAt(h, T0); // the feed poll dies → degraded (the tick order)
  assert.equal(sig.signal_degraded, true, 'the feed failure still degrades (unchanged)');
  assert.equal(sig.idle, false, 'degraded ⇒ never idle (unchanged)');
  assert.equal('load_busy' in (sig as Record<string, unknown>), false, 'a failed load read is unknown, never a veto');
  const r = grant(h, T0);
  assert.equal(r.ok, false, 'no grant while degraded');
  assert.equal(r.reason, 'not_idle', 'the degraded fail-closed reason stands (not the load axis)');
  rmSync(h.dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Config: the knob has NO default (unset = no predicate), and a non-positive
// or garbage value is refused (unset), never coerced.

test('config: metrics_llamaswap_busy_gpu_percent has NO default (unset = no predicate)', () => {
  assert.equal(DEFAULTS.metrics_llamaswap_busy_gpu_percent, undefined, 'the owner\'s number is unset by design');
  assert.equal(applyDefaults({}).metrics_llamaswap_busy_gpu_percent, undefined, 'absent = unset');
});

test('config: a positive number sticks; non-positive / garbage is refused (unset)', () => {
  assert.equal(applyDefaults({ metrics_llamaswap_busy_gpu_percent: 80 }).metrics_llamaswap_busy_gpu_percent, 80);
  assert.equal(applyDefaults({ metrics_llamaswap_busy_gpu_percent: 45.5 }).metrics_llamaswap_busy_gpu_percent, 45.5);
  assert.equal(applyDefaults({ metrics_llamaswap_busy_gpu_percent: 0 }).metrics_llamaswap_busy_gpu_percent, undefined, '0 would veto on every reading → refused');
  assert.equal(applyDefaults({ metrics_llamaswap_busy_gpu_percent: -1 }).metrics_llamaswap_busy_gpu_percent, undefined);
  assert.equal(applyDefaults({ metrics_llamaswap_busy_gpu_percent: 'x' }).metrics_llamaswap_busy_gpu_percent, undefined);
  assert.equal(applyDefaults({ metrics_llamaswap_busy_gpu_percent: NaN }).metrics_llamaswap_busy_gpu_percent, undefined);
});
