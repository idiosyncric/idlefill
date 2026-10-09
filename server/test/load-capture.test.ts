/**
 * load-capture.test.ts — #52 slice 1: capture engine load metrics
 * (DATA ONLY, no verdict change).
 *
 * Covers, with REAL fixtures (verbatim probe captures from
 * docs/reports/ISSUE52-METRIC-INVENTORY.md, 2026-10-09):
 *   - the captured llama-swap Prometheus /metrics sample → the exact
 *     gauges the design doc D5 names (metric names pinned here)
 *   - the captured llama-swap activity entry → the tokens block and
 *     duration_ms kept by the type (ADD fields, no renames)
 *   - the captured oMLX /health payload → identity + residency keys
 *   - failure paths: 404, unreachable, malformed body → NO reading
 *     (absent = unset, never a fake zero), the last good reading stays
 *     with a growing load_age_s
 *   - the VERDICT is byte-identical when the new fetch fails:
 *     signal_degraded / idle / idle_for_s before and after the load
 *     read is exactly the pre-#52 IdleDetector output (the load axis
 *     is a separate plane; D2 rule 3: a dead /metrics never degrades
 *     the verdict)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IdleDetector } from '../src/idle.js';
import {
  LoadCollector,
  parseLlamaSwapMetrics,
  parseOmlxHealth,
  parsePrometheusGauges,
  newestFeedTps,
  modelQuantFromName,
} from '../src/load.js';
import { DEFAULTS, applyDefaults } from '../src/config.js';
import type { ActivityEntry, IdleSignal } from '../src/types.js';

// ---------------------------------------------------------------------------
// Real fixtures (verbatim from the inventory doc's full captures).

const T0 = Date.parse('2026-10-09T06:10:00Z');

/** llama-swap GET /metrics → 200 (2026-10-09 05:55:28Z, GPU gauges). */
const LLAMASWAP_METRICS_FIXTURE = `# HELP llamaswap_gpu_temperature_celsius GPU temperature in Celsius
# TYPE llamaswap_gpu_temperature_celsius gauge
llamaswap_gpu_temperature_celsius{id="0",name="NVIDIA GeForce RTX 5090",uuid="GPU-ae309ca9-6422-1807-df2a-0850cfa4df1f"} 70
# HELP llamaswap_gpu_util_percent GPU utilization percent (0-100)
# TYPE llamaswap_gpu_util_percent gauge
llamaswap_gpu_util_percent{id="0",name="NVIDIA GeForce RTX 5090",uuid="GPU-ae309ca9-6422-1807-df2a-0850cfa4df1f"} 91
# HELP llamaswap_gpu_memory_util_percent GPU memory utilization percent (0-100)
# TYPE llamaswap_gpu_memory_util_percent gauge
llamaswap_gpu_memory_util_percent{id="0",name="NVIDIA GeForce RTX 5090",uuid="GPU-ae309ca9-6422-1807-df2a-0850cfa4df1f"} 95.51323335480112
# HELP llamaswap_gpu_memory_used_bytes GPU memory used in bytes
# TYPE llamaswap_gpu_memory_used_bytes gauge
llamaswap_gpu_memory_used_bytes{id="0",name="NVIDIA GeForce RTX 5090",uuid="GPU-ae309ca9-6422-1807-df2a-0850cfa4df1f"} 3.2656850944e+10
# HELP llamaswap_gpu_memory_total_bytes GPU memory total in bytes
# TYPE llamaswap_gpu_memory_total_bytes gauge
llamaswap_gpu_memory_total_bytes{id="0",name="NVIDIA GeForce RTX 5090",uuid="GPU-ae309ca9-6422-1807-df2a-0850cfa4df1f"} 3.4190917632e+10
# HELP llamaswap_gpu_fan_speed_percent GPU fan speed percent (0-100)
# TYPE llamaswap_gpu_fan_speed_percent gauge
llamaswap_gpu_fan_speed_percent{id="0",name="NVIDIA GeForce RTX 5090",uuid="GPU-ae309ca9-6422-1807-df2a-0850cfa4df1f"} 51
# HELP llamaswap_gpu_power_draw_watts GPU power draw in watts
# TYPE llamaswap_gpu_power_draw_watts gauge
llamaswap_gpu_power_draw_watts{id="0",name="NVIDIA GeForce RTX 5090",uuid="GPU-ae309ca9-6422-1807-df2a-0850cfa4df1f"} 448.69
llamaswap_cpu_util_percent{core="20"} 100
llamaswap_memory_total_bytes 101147738112
`;

/** llama-swap GET /api/metrics/activity → 200 (captured entry id 69577). */
const LLAMASWAP_ACTIVITY_ENTRY_FIXTURE = {
  id: 69577,
  timestamp: '2026-10-09T05:55:25Z',
  src: 'ip:100.94.165.102',
  model: 'Qwen3.8-27B',
  req_path: '/v1/chat/completions',
  resp_content_type: 'text/event-stream',
  resp_status_code: 200,
  tokens: {
    cache_tokens: 0,
    draft_tokens: 4464,
    draft_acc_tokens: 2846,
    input_tokens: 45880,
    output_tokens: 4334,
    prompt_per_second: 6384.427118730863,
    tokens_per_second: 141.41882904412867,
  },
  duration_ms: 102908,
  has_capture: true,
  metadata: { fifo_priority: '0' },
};

/** oMLX GET /health → 200 (captured 2026-10-09). */
const OMLX_HEALTH_FIXTURE = {
  status: 'healthy',
  default_model: 'LFM2.5-2.6B-MLX-8bit',
  engine_pool: {
    model_count: 13,
    loaded_count: 0,
    final_ceiling: 38332312276,
    current_model_memory: 0,
  },
  mcp: null,
};

// ---------------------------------------------------------------------------
// Fake transport (the collector's injectable seam).

function fakeTransport(
  respond: (url: string, headers?: Record<string, string>) =>
    | { ok: true; status: number; text: string }
    | { ok: false; status: number }
    | 'throw',
) {
  const calls: { url: string; headers?: Record<string, string> }[] = [];
  const transport = async (url: string, opts?: { headers?: Record<string, string> }) => {
    calls.push({ url, headers: opts?.headers });
    const r = respond(url, opts?.headers);
    if (r === 'throw') throw new Error('ECONNREFUSED');
    if (!r.ok) return { status: r.status, ok: false, text: async () => 'not found' };
    return { status: r.status, ok: true, text: async () => r.text };
  };
  return { transport, calls };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
void sleep; // reserved for timed-transport fixtures; unused today

// ---------------------------------------------------------------------------
// The parsers (pinned against the captured fixtures).

test('parsePrometheusGauges: the captured llama-swap sample parses to its gauges', () => {
  const g = parsePrometheusGauges(LLAMASWAP_METRICS_FIXTURE);
  assert.equal(g.get('llamaswap_gpu_util_percent')?.[0], 91);
  assert.equal(g.get('llamaswap_gpu_memory_used_bytes')?.[0], 3.2656850944e10);
  assert.equal(g.get('llamaswap_gpu_memory_total_bytes')?.[0], 3.4190917632e10);
  assert.equal(g.get('llamaswap_gpu_temperature_celsius')?.[0], 70);
  assert.equal(g.get('llamaswap_cpu_util_percent')?.[0], 100); // label-less line shape
});

test('parsePrometheusGauges: malformed lines are skipped, never a fake zero', () => {
  const g = parsePrometheusGauges('garbage line without value\n# HELP x\nllamaswap_gpu_util_percent 91\nllamaswap_gpu_memory_used_bytes nan\n');
  assert.deepEqual([...g.entries()], [['llamaswap_gpu_util_percent', [91]]]);
});

test('parseLlamaSwapMetrics: the D5 gauges from the captured sample', () => {
  const m = parseLlamaSwapMetrics(LLAMASWAP_METRICS_FIXTURE);
  assert.deepEqual(m, {
    gpu_util_percent: 91,
    gpu_mem_used_bytes: 3.2656850944e10,
    gpu_mem_total_bytes: 3.4190917632e10,
  });
});

test('parseLlamaSwapMetrics: a 200 body with no recognized gauge is a failed read (null, not zero)', () => {
  assert.equal(parseLlamaSwapMetrics('llamaswap_renamed_gauge 1\n'), null);
  assert.equal(parseLlamaSwapMetrics(''), null);
});

test('the captured activity entry keeps its tokens block + duration_ms (ADD fields, no renames)', () => {
  const e: ActivityEntry = {
    id: LLAMASWAP_ACTIVITY_ENTRY_FIXTURE.id,
    timestamp: LLAMASWAP_ACTIVITY_ENTRY_FIXTURE.timestamp,
    src: LLAMASWAP_ACTIVITY_ENTRY_FIXTURE.src,
    model: LLAMASWAP_ACTIVITY_ENTRY_FIXTURE.model,
    req_path: LLAMASWAP_ACTIVITY_ENTRY_FIXTURE.req_path,
    resp_status_code: LLAMASWAP_ACTIVITY_ENTRY_FIXTURE.resp_status_code,
    tokens: { ...LLAMASWAP_ACTIVITY_ENTRY_FIXTURE.tokens },
    duration_ms: LLAMASWAP_ACTIVITY_ENTRY_FIXTURE.duration_ms,
  };
  // The existing six fields are unchanged (back-compat).
  assert.equal(e.id, 69577);
  assert.equal(e.timestamp, '2026-10-09T05:55:25Z');
  assert.equal(e.src, 'ip:100.94.165.102');
  assert.equal(e.model, 'Qwen3.8-27B');
  assert.equal(e.req_path, '/v1/chat/completions');
  assert.equal(e.resp_status_code, 200);
  // The wire's tokens block + duration survive the type (pre-#52 they
  // were dropped at the type boundary).
  assert.equal(e.tokens?.tokens_per_second, 141.41882904412867);
  assert.equal(e.tokens?.cache_tokens, 0);
  assert.equal(e.tokens?.draft_tokens, 4464);
  assert.equal(e.tokens?.draft_acc_tokens, 2846);
  assert.equal(e.tokens?.input_tokens, 45880);
  assert.equal(e.tokens?.output_tokens, 4334);
  assert.equal(e.tokens?.prompt_per_second, 6384.427118730863);
  assert.equal(e.duration_ms, 102908);
});

test('newestFeedTps: newest-first entries → the first rate wins; absent = null, never zero', () => {
  const entries: ActivityEntry[] = [
    {
      id: 2,
      timestamp: '2026-10-09T05:56:00Z',
      src: 'ip:1.2.3.4',
      model: 'Qwen3.8-27B',
      req_path: '/v1/chat/completions',
      resp_status_code: 200,
      tokens: { tokens_per_second: 250.5 },
    },
    {
      id: 1,
      timestamp: '2026-10-09T05:55:25Z',
      src: 'ip:1.2.3.4',
      model: 'Qwen3.8-27B',
      req_path: '/v1/chat/completions',
      resp_status_code: 200,
      tokens: { tokens_per_second: 141.41882904412867 },
    },
    {
      id: 0,
      timestamp: '2026-10-09T05:54:00Z',
      src: 'ip:1.2.3.4',
      model: 'Qwen3.8-27B',
      req_path: '/v1/chat/completions',
      resp_status_code: 200,
    },
  ];
  assert.equal(newestFeedTps(entries), 250.5, 'the newest entry with a rate wins');
  assert.equal(newestFeedTps([entries[2]!]), null, 'no block → null, never a fake zero');
  assert.equal(newestFeedTps([]), null);
});

test('parseOmlxHealth: the captured payload → residency, model_loaded ABSENT at loaded_count 0', () => {
  const h = parseOmlxHealth(OMLX_HEALTH_FIXTURE);
  assert.deepEqual(h, { omlx_loaded_count: 0 }, 'the payload names the default, not the loaded (D8)');
});

test('parseOmlxHealth: a resident model carries model_loaded + the derived model_quant', () => {
  const h = parseOmlxHealth({
    status: 'healthy',
    default_model: 'LFM2.5-2.6B-MLX-8bit',
    engine_pool: { model_count: 13, loaded_count: 1, final_ceiling: 38332312276, current_model_memory: 1234 },
    mcp: null,
  });
  assert.deepEqual(h, {
    model_loaded: 'LFM2.5-2.6B-MLX-8bit',
    model_quant: '8bit',
    omlx_loaded_count: 1,
  });
});

test('parseOmlxHealth: a payload with no usable identity or residency is null (not a fake reading)', () => {
  assert.equal(parseOmlxHealth({}), null);
  assert.equal(parseOmlxHealth(null), null);
  assert.equal(parseOmlxHealth({ default_model: 'x', engine_pool: { loaded_count: 'many' } }), null);
});

test('modelQuantFromName: best-effort, absent when not parseable', () => {
  assert.equal(modelQuantFromName('LFM2.5-2.6B-MLX-8bit'), '8bit');
  assert.equal(modelQuantFromName('qwen3.8-flash-next-q2_0'), 'q2_0');
  assert.equal(modelQuantFromName('Qwen3.8-27B'), undefined);
  assert.equal(modelQuantFromName(''), undefined);
});

// ---------------------------------------------------------------------------
// The collector: happy paths (fake transport, captured fixtures).

test('llama-swap: /metrics gauges + the feed rate ride the reading (D5 keys)', async () => {
  const { transport } = fakeTransport((url) =>
    url === 'http://100.105.225.1:11434/metrics'
      ? { ok: true, status: 200, text: LLAMASWAP_METRICS_FIXTURE }
      : { ok: false, status: 404 },
  );
  const c = new LoadCollector({ url: 'http://100.105.225.1:11434', transport });
  const reading = await c.read(T0, 141.41882904412867);
  assert.ok(reading);
  const view = c.current(T0)!;
  assert.equal(view.load_source, 'llamaswap-metrics');
  assert.equal(view.load_age_s, 0);
  assert.equal(view.gpu_util_percent, 91);
  assert.equal(view.gpu_mem_used_bytes, 3.2656850944e10);
  assert.equal(view.gpu_mem_total_bytes, 3.4190917632e10);
  assert.equal(view.tokens_per_second, 141.41882904412867);
  assert.equal('gpu_memory_util_percent' in view, false, 'only the D5 keys ride');
  assert.equal('in_flight' in view, false, 'no engine exposes one today → absent, not zero');
});

test('llama-swap: no feed rate this tick → tokens_per_second stays absent', async () => {
  const { transport } = fakeTransport((url) =>
    url === 'http://100.105.225.1:11434/metrics' ? { ok: true, status: 200, text: LLAMASWAP_METRICS_FIXTURE } : { ok: false, status: 404 },
  );
  const c = new LoadCollector({ url: 'http://100.105.225.1:11434', transport });
  await c.read(T0, null);
  const view = c.current(T0)!;
  assert.equal(view.gpu_util_percent, 91);
  assert.equal('tokens_per_second' in view, false);
});

test('omlx: /health → omlx-health reading with load_age_s labelling the age', async () => {
  const { transport } = fakeTransport((url) =>
    url === 'http://127.0.0.1:8000/health' ? { ok: true, status: 200, text: JSON.stringify(OMLX_HEALTH_FIXTURE) } : { ok: false, status: 404 },
  );
  const c = new LoadCollector({ url: 'http://127.0.0.1:8000', provider: 'omlx', transport });
  await c.read(T0, null);
  const view = c.current(T0)!;
  assert.equal(view.load_source, 'omlx-health');
  assert.equal(view.omlx_loaded_count, 0);
  assert.equal('model_loaded' in view, false, '0 resident → the payload names no loaded model');
  // 20s later the SAME reading rides with a labelled age (the stale
  // window is display-only: nothing vetoes, nothing is dropped).
  const later = c.current(T0 + 20_000)!;
  assert.equal(later.load_age_s, 20);
  assert.equal(later.omlx_loaded_count, 0);
});

test('omlx: the credential rides the Authorization header (same family as the feed fetchers)', async () => {
  const { transport, calls } = fakeTransport((url) =>
    url === 'http://127.0.0.1:8000/health' ? { ok: true, status: 200, text: JSON.stringify(OMLX_HEALTH_FIXTURE) } : { ok: false, status: 404 },
  );
  const c = new LoadCollector({ url: 'http://127.0.0.1:8000', provider: 'omlx', auth_token: 'sekret', transport });
  await c.read(T0, null);
  assert.equal(calls[0]?.url, 'http://127.0.0.1:8000/health');
  assert.equal(calls[0]?.headers?.authorization, 'Bearer sekret');
});

test('strata kind: the /metrics collector reads live.state; a payload with no live object is UNKNOWN (no reading)', async () => {
  const { transport, calls } = fakeTransport((url) =>
    url === 'http://10.10.10.6:8080/metrics' ? { ok: true, status: 200, text: '{}' } : { ok: false, status: 404 },
  );
  const c = new LoadCollector({ url: 'http://10.10.10.6:8080', provider: 'strata', transport });
  // A body with no `live` object names no state → UNKNOWN, never a fake idle.
  assert.equal(await c.read(T0, null), null);
  assert.equal(c.current(T0), null);
  assert.equal(calls.length, 1, 'the strata collector polls /metrics (the feed adapter own payload)');
  assert.equal(calls[0]!.url, 'http://10.10.10.6:8080/metrics');
});

// ---------------------------------------------------------------------------
// The collector: failure paths (404, unreachable, malformed body).

test('404 → no reading: absent keys, never a fake zero', async () => {
  const { transport } = fakeTransport((url) =>
    url === 'http://100.105.225.1:11434/metrics' ? { ok: false, status: 404 } : { ok: false, status: 404 },
  );
  const c = new LoadCollector({ url: 'http://100.105.225.1:11434', transport });
  assert.equal(await c.read(T0, 141.41882904412867), null);
  assert.equal(c.current(T0), null);
});

test('unreachable (ECONNREFUSED) → no reading, the tick is never disturbed', async () => {
  const { transport } = fakeTransport(() => 'throw');
  const c = new LoadCollector({ url: 'http://100.105.225.1:11434', transport });
  assert.equal(await c.read(T0, null), null); // read() resolved, did not throw
  assert.equal(c.current(T0), null);
});

test('malformed body (200 with unparseable JSON / no gauges) → no reading', async () => {
  const c1 = new LoadCollector({
    url: 'http://127.0.0.1:8000',
    provider: 'omlx',
    transport: (async () => ({ status: 200, ok: true, text: async () => 'not-json' })) as never,
  });
  assert.equal(await c1.read(T0, null), null);
  const c2 = new LoadCollector({
    url: 'http://100.105.225.1:11434',
    transport: (async () => ({ status: 200, ok: true, text: async () => 'llamaswap_renamed 1\n' })) as never,
  });
  assert.equal(await c2.read(T0, null), null, 'a 200 without the recognized gauges is a failed read');
});

test('a failed read never wipes the last good reading; its age keeps growing', async () => {
  let mode: 'good' | 'dead' = 'good';
  const { transport } = fakeTransport((url) => {
    if (mode === 'dead') return 'throw';
    return url === 'http://100.105.225.1:11434/metrics'
      ? { ok: true, status: 200, text: LLAMASWAP_METRICS_FIXTURE }
      : { ok: false, status: 404 };
  });
  const c = new LoadCollector({ url: 'http://100.105.225.1:11434', transport });
  await c.read(T0, 141.41882904412867);
  mode = 'dead';
  await c.read(T0 + 15_000, null); // the endpoint died: no reading, no throw
  const view = c.current(T0 + 20_000)!;
  assert.equal(view.gpu_util_percent, 91, 'the last good reading stays');
  assert.equal(view.load_age_s, 20, 'and its age is labelled (the stale window, display-only)');
});

test('a bad url yields no reading and no throw', async () => {
  const c = new LoadCollector({ url: 'not-a-url', transport: (async () => { throw new Error('should not be called'); }) as never });
  assert.equal(await c.read(T0, null), null);
});

// ---------------------------------------------------------------------------
// THE VERDICT PROOF: byte-identical when the new fetch fails.
//
// The same detector, same feed, same clock — with and without a load
// read on the same tick (a dead /metrics). The verdict fields must be
// byte-identical: the load axis is a separate plane and D4 is OFF.

function entry(tsSecAgo: number, src = 'ip:10.0.0.5', model = 'Qwen3.8-27B'): ActivityEntry {
  return {
    id: 1,
    timestamp: new Date(T0 - tsSecAgo * 1000).toISOString(),
    src,
    model,
    req_path: '/v1/chat/completions',
    resp_status_code: 200,
    tokens: { tokens_per_second: 141.41882904412867 },
    duration_ms: 102908,
  };
}

const VERDICT_KEYS = ['now', 'idle', 'idle_for_s', 'last_activity', 'last_log_write', 'signal_degraded', 'degraded_reason', 'feed_enabled', 'no_signal_reason'] as const;

/** The verdict-only view of a signal (the pre-#52 shape — load keys excluded). */
function verdictOnly(sig: IdleSignal): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of VERDICT_KEYS) out[k] = sig[k];
  return out;
}

function detectorWith(
  feed: ActivityEntry[] | 'fail',
  o: { logGlob?: string; logMtimeMs?: number | null } = {},
): IdleDetector {
  return new IdleDetector({
    fetchActivity: async () => {
      if (feed === 'fail') throw new Error('ECONNRESET');
      return feed;
    },
    logMtime: () => (o.logGlob ? o.logMtimeMs ?? null : null),
    llama_swap_url: 'http://100.105.225.1:11434',
    activity_path: '/api/metrics/activity',
    log_glob: o.logGlob ?? '',
    idle_seconds: 300,
  });
}

test('verdict byte-identical with vs without a SUCCESSFUL load read (fresh feed, idle)', async () => {
  const plain = detectorWith([entry(400)]);
  const baseline = await plain.poll(T0, new Set());

  const loaded = detectorWith([entry(400)]);
  const collector = new LoadCollector({
    url: 'http://100.105.225.1:11434',
    transport: (async (url: string) =>
      url === 'http://100.105.225.1:11434/metrics'
        ? { status: 200, ok: true, text: async () => LLAMASWAP_METRICS_FIXTURE }
        : { status: 404, ok: false, text: async () => 'nf' }) as never,
  });
  // The tick order: the feed poll, THEN the load read on the same tick.
  const signal = await loaded.poll(T0, new Set());
  await collector.read(T0, 141.41882904412867);
  assert.ok(collector.current(T0), 'the reading captured');
  assert.deepEqual(JSON.stringify(verdictOnly(signal)), JSON.stringify(verdictOnly(baseline)), 'a fresh busy-looking reading (gpu 91%) vetoes NOTHING while D4 is off');
});

test('verdict byte-identical when the NEW FETCH FAILS (404, unreachable, malformed) — fresh and degraded', async () => {
  const cases: { name: string; transport: unknown }[] = [
    {
      name: '404',
      transport: async (url: string) => ({ status: 404, ok: false, text: async () => 'not found' }),
    },
    { name: 'unreachable', transport: async () => { throw new Error('ECONNREFUSED'); } },
    { name: 'malformed body', transport: async (url: string) => ({ status: 200, ok: true, text: async () => 'not-json' }) },
  ];

  for (const c of cases) {
    // --- fresh feed: the verdict must match the no-collector baseline ---
    const baseline = await detectorWith([entry(10)]).poll(T0, new Set());
    const d = detectorWith([entry(10)]);
    const sig = await d.poll(T0, new Set());
    const col = newLoadCollector(c.transport);
    assert.equal(await col.read(T0, null), null, `${c.name}: no reading`);
    assert.deepEqual(
      JSON.stringify(verdictOnly(sig)),
      JSON.stringify(verdictOnly(baseline)),
      `${c.name}: fresh verdict byte-identical with a failed load read`,
    );

    // --- degraded feed: the fail-closed verdict must match the no-collector baseline ---
    // Same detector shape for both: the feed answers once, then dies.
    const mkDead = (): IdleDetector => {
      let calls = 0;
      return new IdleDetector({
        fetchActivity: async () => {
          calls += 1;
          if (calls === 1) return [entry(10)];
          throw new Error('ECONNRESET');
        },
        logMtime: () => null,
        llama_swap_url: 'http://100.105.225.1:11434',
        activity_path: '/api/metrics/activity',
        log_glob: '',
        idle_seconds: 300,
      });
    };
    const seedDead = mkDead();
    await seedDead.poll(T0, new Set()); // first poll: healthy
    const degraded = await seedDead.poll(T0 + 60_000, new Set()); // feed dies → degraded
    const d2 = mkDead();
    await d2.poll(T0, new Set());
    const sig2 = await d2.poll(T0 + 60_000, new Set());
    await col.read(T0 + 60_000, null); // the load read fails too, same tick
    assert.equal(sig2.signal_degraded, true, 'the feed failure still degrades (unchanged)');
    assert.equal(sig2.idle, false, 'degraded ⇒ never idle (unchanged)');
    assert.deepEqual(
      JSON.stringify(verdictOnly(sig2)),
      JSON.stringify(verdictOnly(degraded)),
      `${c.name}: degraded verdict byte-identical with a failed load read`,
    );
  }
});

function newLoadCollector(transport: unknown) {
  return new LoadCollector({ url: 'http://100.105.225.1:11434', transport: transport as never });
}

test('the load keys are the ONLY additions to the signal shape: the pre-#52 fields are unchanged', () => {
  const sig: IdleSignal = {
    now: T0,
    idle: true,
    idle_for_s: 400,
    last_activity: null,
    last_log_write: null,
    signal_degraded: false,
    degraded_reason: null,
    feed_enabled: true,
  };
  const before = JSON.stringify(verdictOnly(sig));
  // A signal carrying a captured reading (what the collector plane adds).
  const withLoad: IdleSignal = {
    ...sig,
    load_source: 'llamaswap-metrics',
    load_age_s: 3,
    gpu_util_percent: 91,
    gpu_mem_used_bytes: 3.2656850944e10,
    gpu_mem_total_bytes: 3.4190917632e10,
    tokens_per_second: 141.41882904412867,
  };
  assert.equal(JSON.stringify(verdictOnly(withLoad)), before, 'the verdict fields are byte-identical with a reading present');
  // And the row that never read anything publishes NO load keys at all:
  const absentKeys = Object.keys(withLoad).filter((k) => !(k in sig));
  assert.deepEqual(absentKeys.sort(), [
    'gpu_mem_total_bytes',
    'gpu_mem_used_bytes',
    'gpu_util_percent',
    'load_age_s',
    'load_source',
    'tokens_per_second',
  ]);
});

// ---------------------------------------------------------------------------
// Config: metrics_load_stale_s.

test('config: metrics_load_stale_s defaults to 45 and parses like the other knobs', () => {
  assert.equal(DEFAULTS.metrics_load_stale_s, 45);
  assert.equal(applyDefaults({}).metrics_load_stale_s, 45);
  assert.equal(applyDefaults({ metrics_load_stale_s: 90 }).metrics_load_stale_s, 90);
  assert.equal(applyDefaults({ metrics_load_stale_s: -1 }).metrics_load_stale_s, 45, 'garbage falls back to the default');
  assert.equal(applyDefaults({ metrics_load_stale_s: 'x' }).metrics_load_stale_s, 45);
});

// ---------------------------------------------------------------------------
// The feed-entry parse path end-to-end: the real fetcher's body shape with
// the tokens block survives into the entries the detector consumes.

test('the feed body shape: the tokens block rides through as stored (wire → type → wire)', async () => {
  // The real fetcher parses {data: entries} — assert the ADD fields
  // survive a wire→type→wire round trip (what the stored sample sees).
  const wire = { data: [LLAMASWAP_ACTIVITY_ENTRY_FIXTURE] };
  const parsed: { data?: ActivityEntry[] } = JSON.parse(JSON.stringify(wire)) as { data?: ActivityEntry[] };
  const e = parsed.data?.[0]!;
  assert.equal(e.tokens?.tokens_per_second, 141.41882904412867);
  assert.equal(e.duration_ms, 102908);
  assert.equal(newestFeedTps([e]), 141.41882904412867, 'the tick picks the rate up from the stored entry');
});
