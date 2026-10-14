/**
 * remote-metrics.test.ts — the peer-row expand's pure row builder
 * (#79 D6, #86). Exception-only + the #62 token-gap honesty rule.
 * Metrics wave S3: the peer rows also carry the S2 utilization rows, with
 * the peer attribution and the pull's stale/truncated state in the label.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRemoteRows } from '../src/lib/remote-metrics';

test('engine rows: req/hour always; token row only when a counter-backed sample exists', () => {
  const { rows, absences } = buildRemoteRows(
    [
      { key: 'srv-a', points: [{ ts: 1, kind: 'engine_hour', req_total: 5, engine_tokens_out: 120 }, { ts: 2, kind: 'engine_hour', req_total: 3, engine_tokens_out: 40 }] },
      { key: 'srv-b', points: [{ ts: 1, kind: 'engine_hour', req_total: 9, engine_tokens_out: null }] },
    ],
    [],
  );
  const a = rows.filter((r) => r.key === 'srv-a');
  assert.equal(a.length, 2); // req row + token row
  assert.deepEqual(a[1]!.values, [120, 40]);
  const b = rows.filter((r) => r.key === 'srv-b');
  assert.equal(b.length, 1); // NO fake-zero token row for a feed-delta gap
  assert.deepEqual(b[0]!.values, [9]);
  // S3: an old-build peer's hour lines carry no load axis — the absence is
  // named, and no utilization row is invented.
  assert.equal(absences.length, 2);
  assert.ok(absences[0]!.includes('no load axis'));
});

test('S3: a peer whose rollup carries the S1 keys gets the exception-only utilization rows', () => {
  const { rows } = buildRemoteRows(
    [
      {
        key: 'srv-a',
        points: [
          { ts: 1, kind: 'engine_hour', req_total: 5, load_reads: 10, busy_reads: 4, peak_in_flight: 2, gpu_util_max: 71 },
          { ts: 2, kind: 'engine_hour', load_reads: 6, busy_reads: 1, gpu_power_max: 55 },
        ],
      },
    ],
    [],
  );
  const labels = rows.map((r) => r.label);
  assert.ok(labels.includes('srv-a busy %'));
  assert.ok(labels.includes('srv-a peak in-flight'));
  assert.ok(labels.includes('srv-a gpu util max'));
  assert.ok(labels.includes('srv-a gpu power max'));
  assert.ok(!labels.includes('srv-a peak queue')); // oMLX-only gauge: never seen, never zeroed
  assert.equal(rows.find((r) => r.label === 'srv-a busy %')!.valueText, '31% of 16 reads');
  assert.ok(rows.find((r) => r.label === 'srv-a busy %')!.title.includes("the peer's own rollup, attributed to this peer (never merged across peers)"));
});

test('S3: an older-build peer line renders byte-identically to today (no utilization rows)', () => {
  const old = [{ ts: 1, kind: 'engine_hour', server_id: 'srv-a', samples: 3, req_total: 2, idle_samples: 1, grants: 0, revoked: 0, tokens_out: 0, tokens_in: 0, engine_tokens_in: null, engine_tokens_out: null, engine_tokens_cached: null }];
  const nowShape = buildRemoteRows([{ key: 'srv-a', points: old }], []);
  assert.equal(nowShape.rows.length, 1); // the req/hour row only
  assert.deepEqual(nowShape.rows[0]!.values, [2]);
  assert.ok(nowShape.absences[0]!.includes('no load axis in this window'));
});

test('S3: stale/truncated rides the label, never the numbers', () => {
  const { rows, absences } = buildRemoteRows(
    [{ key: 'srv-a', points: [{ ts: 1, kind: 'engine_hour', load_reads: 4, busy_reads: 2, gpu_util_max: 80 }] }],
    [],
    { stale: true, truncated: true },
  );
  const busy = rows.find((r) => r.label === 'srv-a busy %')!;
  assert.ok(busy.title.includes('cached (stale) + truncated by the 2,000-point cap'));
  assert.ok(absences.length === 0);
});

test('garbage numbers read as zero on the req line, never NaN', () => {
  const { rows } = buildRemoteRows([{ key: 'srv-a', points: [{ ts: 1, kind: 'engine_hour', req_total: 'x', engine_tokens_out: -5 }] }], []);
  assert.deepEqual(rows[0]!.values, [0]);
});

test("session rows: key = the peer's derived token (often a model name), values = peak rpm", () => {
  const { rows } = buildRemoteRows([], [{ key: 'qwen3.8-flash-next-q2_0', points: [{ ts: 1, kind: 'session_hour', reqs_per_min_max: 4 }, { ts: 2, kind: 'session_hour', reqs_per_min_max: 7 }] }]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.series, 'session');
  assert.deepEqual(rows[0]!.values, [4, 7]);
  assert.equal(rows[0]!.valueText, '7');
});

test('empty series render as empty rows (the render gap, not a crash)', () => {
  assert.deepEqual(buildRemoteRows([], []), { rows: [], absences: [] });
  assert.deepEqual(buildRemoteRows([{ key: 'k', points: [] }], []).rows.map((r) => r.values), [[]]);
});
