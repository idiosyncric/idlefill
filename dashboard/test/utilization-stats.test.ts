/**
 * utilization-stats.test.ts — the metrics wave S2 read (dashboard-only).
 * Exception-only rows from the hour buckets' bounded aggregates, the named
 * absence for an engine with no load axis, and the card's raw drill built
 * from peaks — never means, never a fake zero.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { utilizationRowsFor, rawLoadDrill } from '../src/lib/utilization-stats';
import type { MetricPoint, RawLoadLine } from '../src/lib/api';

const HOUR = 3_600_000;

test('exception-only: an engine whose hour lines carry no load keys gets NO row — the absence is named', () => {
  const points: MetricPoint[] = [
    { hour: '2026-10-12T00:00:00Z', req_total: 5, tokens_out: 1000, samples: 240, idle_samples: 100 },
    { hour: '2026-10-12T01:00:00Z', req_total: 2, tokens_out: 500, samples: 240, idle_samples: 120 },
  ];
  const { rows, absence } = utilizationRowsFor('srv-a', points);
  assert.deepEqual(rows, []);
  assert.match(absence!, /no load axis/);
  assert.match(absence!, /srv-a/);
});

test('busy % is a ratio of COUNTS, and the value names the denominator', () => {
  const points: MetricPoint[] = [
    { hour: 'a', req_total: 0, tokens_out: 0, load_reads: 100, busy_reads: 25, peak_in_flight: 2 },
    { hour: 'b', req_total: 0, tokens_out: 0, load_reads: 100, busy_reads: 5, peak_in_flight: 1 },
  ];
  const { rows, absence } = utilizationRowsFor('srv-a', points);
  assert.equal(absence, null);
  const busy = rows.find((r) => r.label === 'srv-a busy %')!;
  assert.deepEqual(busy.values, [25, 5]);
  assert.equal(busy.valueText, '15% of 200 reads', 'the window total, not an average of per-hour percentages');
  assert.match(busy.title, /counts, not a gauge mean/);
});

test('peaks render only for gauges the kind reported; an unreported gauge never appears', () => {
  const points: MetricPoint[] = [
    { hour: 'a', req_total: 0, tokens_out: 0, load_reads: 10, busy_reads: 1, peak_in_flight: 3, gpu_util_max: 91 },
    { hour: 'b', req_total: 0, tokens_out: 0, load_reads: 10, busy_reads: 0, peak_in_flight: 0 },
  ];
  const { rows } = utilizationRowsFor('srv-swap', points);
  const labels = rows.map((r) => r.label);
  assert.ok(labels.includes('srv-swap peak in-flight'));
  assert.ok(!labels.includes('srv-swap peak queue'), 'no queue key in the data → no queue row');
  assert.ok(!labels.includes('srv-swap gpu power max'), 'no power gauge → no row, never a 0 row');
  const inflight = rows.find((r) => r.label === 'srv-swap peak in-flight')!;
  assert.deepEqual(inflight.values, [3, 0]);
  assert.equal(inflight.valueText, '3');
  assert.match(inflight.title, /gap, not a zero/);
});

test('a gauge whose only values are zero renders nothing (a peak of 0 is not a claim)', () => {
  const points: MetricPoint[] = [{ hour: 'a', req_total: 0, tokens_out: 0, load_reads: 5, busy_reads: 0, gpu_util_max: 0 }];
  const { rows } = utilizationRowsFor('srv-idle', points);
  assert.equal(rows.length, 1, 'only the busy % row, and it is a true 0% of real reads');
  assert.equal(rows[0]!.valueText, '0% of 5 reads');
});

test('garbage in an aggregate reads as absent, never as a number', () => {
  const points: MetricPoint[] = [
    { hour: 'a', req_total: 0, tokens_out: 0, load_reads: 4, busy_reads: -3, peak_in_flight: 'two', gpu_util_max: Number.NaN },
  ];
  const { rows } = utilizationRowsFor('srv-x', points);
  const busy = rows.find((r) => r.label === 'srv-x busy %')!;
  assert.deepEqual(busy.values, [0], 'the negative busy count drops to zero in the ratio, never to -75%');
  assert.equal(rows.find((r) => r.label.includes('peak in-flight')), undefined);
  assert.equal(rows.find((r) => r.label.includes('gpu util max')), undefined);
});

test('raw drill: peak per hour over the raw lines; hours with no reading are gaps', () => {
  const now = 1_791_900_000_000;
  const lines: RawLoadLine[] = [
    { ts: now - 60_000, kind: 'engine', server_id: 'srv-a', load_source: 'strata-metrics', in_flight: 1, gpu_util_percent: 88 },
    { ts: now - 120_000, kind: 'engine', server_id: 'srv-a', load_source: 'strata-metrics', in_flight: 0, gpu_util_percent: 4 },
    { ts: now - HOUR - 60_000, kind: 'engine', server_id: 'srv-a', load_source: 'strata-metrics', in_flight: 1, gpu_util_percent: 99 },
    { ts: now - 2 * HOUR - 60_000, kind: 'engine', server_id: 'srv-a', load_source: 'strata-metrics', in_flight: 0 },
  ];
  const drill = rawLoadDrill(lines, 48 * HOUR, now)!;
  assert.ok(drill.rows.length >= 2, 'in-flight and gpu util rows, both from peaks');
  const inflight = drill.rows.find((r) => r.label === 'in-flight · raw peak/hr')!;
  assert.equal(inflight.valueText, '1');
  assert.equal(inflight.values.reduce((a, b) => a + b, 0), 2, 'two hours had a generation in flight, the others are gaps');
  const gpu = drill.rows.find((r) => r.label === 'gpu util · raw peak/hr')!;
  assert.equal(gpu.valueText, '99%', 'the peak, never the mean of the two readings');
  assert.match(drill.coverage, /raw samples/);
  assert.ok(!drill.rows.some((r) => r.label.includes('queue')), 'no queue depth in the payload → no queue row');
});

test('raw drill returns null when the window has no load axis at all', () => {
  const now = 1_791_900_000_000;
  const lines: RawLoadLine[] = [
    { ts: now - 60_000, kind: 'engine', server_id: 'srv-a' },
    { ts: now - 120_000, kind: 'engine', server_id: 'srv-a', load_fail_reason: 'no credential' },
  ];
  assert.equal(rawLoadDrill(lines, 48 * HOUR, now), null);
  assert.equal(rawLoadDrill([], 48 * HOUR, now), null);
});
