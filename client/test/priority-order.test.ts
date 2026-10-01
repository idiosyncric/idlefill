/**
 * priority-order.test.ts — issue #2 gap 1: score-ordered dispatch.
 *
 * priorityOrder is the daemon's selection order: highest payload.score
 * first, ties keep file order (FIFO tiebreak), null/missing/garbage
 * scores sort last (treated as -Infinity). It is PURE — the queue file's
 * on-disk order is never rewritten (writeQueue keeps file order; no
 * re-sort-on-disk). nextJob selects through it, so a freshly-appended
 * high-score job is dispatched before older low-score lines.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { priorityOrder, readQueue, writeQueue, nextJob, type QueueJob } from '../src/index.js';

function job(id: string, score?: unknown): QueueJob {
  // The payload type is career-ops-conventional; this test deliberately
  // feeds null/garbage scores, so the payload is assembled loosely.
  const payload: Record<string, unknown> = { url: `https://example.com/${id}`, company: 'C', title: 'T' };
  if (score !== undefined) payload.score = score;
  return { job_id: id, payload } as QueueJob;
}
const ids = (jobs: QueueJob[]): string[] => jobs.map((j) => j.job_id);

test('priorityOrder sorts by score DESC', () => {
  const jobs = [job('a', 5), job('b', 90), job('c', 11), job('d', 1)];
  assert.deepEqual(ids(priorityOrder(jobs)), ['b', 'c', 'a', 'd']);
});

test('null / missing / non-number scores sort last (as -Infinity)', () => {
  const jobs = [
    job('null-score', null),
    job('missing-score'),
    job('garbage-score', 'high'),
    job('nan-score', Number.NaN),
    job('low-real', -5),
    job('high-real', 3),
  ];
  const ordered = ids(priorityOrder(jobs));
  assert.deepEqual(ordered.slice(0, 2), ['high-real', 'low-real'], 'real numbers first, desc');
  // The four score-less jobs all tie at -Infinity; stability keeps their
  // relative file order.
  assert.deepEqual(ordered.slice(2), ['null-score', 'missing-score', 'garbage-score', 'nan-score']);
});

test('ties keep file order (stable FIFO tiebreak)', () => {
  const jobs = [job('t1', 7), job('t2', 7), job('mid', 9), job('t3', 7), job('t4', 7)];
  assert.deepEqual(ids(priorityOrder(jobs)), ['mid', 't1', 't2', 't3', 't4']);
});

test('priorityOrder is pure: input array and its order are untouched', () => {
  const jobs = [job('x', 1), job('y', 2)];
  const ordered = priorityOrder(jobs);
  assert.notStrictEqual(ordered, jobs, 'returns a NEW array');
  assert.deepEqual(ids(jobs), ['x', 'y'], 'input order unchanged');
});

test('nextJob selects the highest-score job even when the file head is lower', () => {
  const dir = mkdtempSync(join(tmpdir(), 'idlefill-prio-'));
  try {
    const file = join(dir, 'queue.jsonl');
    // The add_jobs shape: older low-score lines first, fresh high-score line
    // appended at the tail.
    writeQueue(file, [job('old-low', 12), job('old-mid', 40), job('fresh-high', 95)]);
    assert.equal(nextJob(file)?.job_id, 'fresh-high', 'dispatch picks the highest score, not the file head');
    // Selection-only: the ON-DISK order is untouched (no re-sort-on-disk).
    assert.deepEqual(ids(readQueue(file)), ['old-low', 'old-mid', 'fresh-high'], 'file order preserved on disk');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
