// project-stats.test.ts — the Projects tab tiles. The discipline under
// test: these are DIRECT counts over arbiter truth (published queue
// depth, held leases, throttled gates, worker day counters) — 0 renders
// 0 with the reason; coverage (workers online) rides the Queued sub.

import { test } from "node:test";
import assert from "node:assert/strict";
import { projectTiles } from "../src/lib/project-stats.js";
import type { StateSnapshot } from "../src/lib/api.js";

function st(over: Record<string, unknown> = {}): StateSnapshot {
  return over as unknown as StateSnapshot;
}

// Workers publish queue depth + online; leases stand for running; today
// counters sum across projects.
test("project tiles count queue, leases, throttles and today's counters", () => {
  const s = st({
    projects: [
      {
        name: "p1",
        workers: [
          { name: "w1", online: true, queue_depth: 5 },
          { name: "w2", online: false, queue_depth: 3 },
        ],
        today: { finished: 7, failed: 2 },
      },
      { name: "p2", workers: [{ name: "w3", online: true, queue_depth: 0 }], today: { finished: 3 } },
    ],
    active_leases: [{ lease_id: "1" }, { lease_id: "2" }],
    throttled_jobs: [{ job: "x" }],
  });
  const [queued, running, throttled, today] = projectTiles(s);
  assert.equal(queued.value, "8");
  assert.equal(queued.sub, "2 of 3 workers online");
  assert.equal(running.value, "2");
  assert.equal(running.sub, "leases running now");
  assert.equal(throttled.value, "1");
  assert.equal(throttled.sub, "no new grants while throttled — unthrottle from the Overview");
  assert.equal(today.value, "10");
  assert.equal(today.sub, "2 failed today");
});

// Nothing configured/running: every tile reads a true 0, each sub naming
// why — a working queue behind zero online workers is the named hazard.
test("empty queue side is direct zeros with named reasons", () => {
  const [queued, running, throttled, today] = projectTiles(st({ projects: [], active_leases: [], throttled_jobs: [] }));
  assert.deepEqual([queued.value, running.value, throttled.value, today.value], ["0", "0", "0", "0"]);
  assert.equal(queued.sub, "no workers connected for any project");
  assert.equal(running.sub, "nothing running");
  assert.equal(throttled.sub, "nothing throttled");
  assert.equal(today.sub, "no failures today");
});
