/**
 * remote-metrics.test.ts — the peer-row expand's pure row builder
 * (#79 D6, #86). Exception-only + the #62 token-gap honesty rule.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRemoteRows } from '../src/lib/remote-metrics';

test('engine rows: req/hour always; token row only when a counter-backed sample exists', () => {
  const rows = buildRemoteRows(
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
});

test('garbage numbers read as zero on the req line, never NaN', () => {
  const rows = buildRemoteRows([{ key: 'srv-a', points: [{ ts: 1, kind: 'engine_hour', req_total: 'x', engine_tokens_out: -5 }] }], []);
  assert.deepEqual(rows[0]!.values, [0]);
});

test("session rows: key = the peer's derived token (often a model name), values = peak rpm", () => {
  const rows = buildRemoteRows([], [{ key: 'qwen3.8-flash-next-q2_0', points: [{ ts: 1, kind: 'session_hour', reqs_per_min_max: 4 }, { ts: 2, kind: 'session_hour', reqs_per_min_max: 7 }] }]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.series, 'session');
  assert.deepEqual(rows[0]!.values, [4, 7]);
  assert.equal(rows[0]!.valueText, '7');
});

test('empty series render as empty rows (the render gap, not a crash)', () => {
  assert.deepEqual(buildRemoteRows([], []), []);
  assert.deepEqual(buildRemoteRows([{ key: 'k', points: [] }], []).map((r) => r.values), [[]]);
});
