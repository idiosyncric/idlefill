import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { HERMES_JOBS_LABEL, collectHermesJobGroups } from "../src/lib/hermes-jobs";
import type { HermesJobRow, StateSnapshot } from "../src/lib/api";

// ---------------------------------------------------------------------------
// hermes-jobs.test.ts — #85 slice D: the pure side of the dashboard's
// "Hermes jobs" strip. NAMING is the issue's hard rule: the constant is
// exactly "Hermes jobs" (idlefill has its own job concept — the collision
// is the named hazard), and the Overview view must render THAT constant
// (source-pinned: the header uses the label, so a rename of the copy would
// break this test).
// ---------------------------------------------------------------------------

test("the strip's label is exactly 'Hermes jobs' (the collision naming rule)", () => {
  assert.equal(HERMES_JOBS_LABEL, "Hermes jobs");
  const here = dirname(fileURLToPath(import.meta.url));
  const overview = readFileSync(join(here, "..", "src", "views", "Overview.tsx"), "utf-8");
  assert.match(overview, /HERMES_JOBS_LABEL/, "the Overview card renders the naming constant (one source for the copy)");
  // Read-only: the Hermes-jobs card carries no interactive affordance —
  // there is no onClick/button in the HermesJobsCard region of the view.
  const card = overview.slice(overview.indexOf("function HermesJobsCard"), overview.indexOf("function HermesJobRowView"));
  assert.ok(!/Button|onClick/.test(card), "the Hermes jobs card is read-only — no pause/resume/run affordance exists");
});

function stWith(clients: Array<{ name: string; last_seen: number; hermes_jobs?: HermesJobRow[] }>): StateSnapshot {
  return {
    now: Date.parse("2026-10-09T12:00:00Z"),
    clients: clients.map((c) => ({ client_id: c.name, name: c.name, ip: "", last_seen: c.last_seen, projects: [], ...c })) as StateSnapshot["clients"],
  } as StateSnapshot;
}

test("collectHermesJobGroups: groups per client, skips absent/empty, online-first then name", () => {
  const now = Date.parse("2026-10-09T12:00:00Z");
  const st = stWith([
    { name: "m3-mac", last_seen: now - 10_000, hermes_jobs: [{ id: "a1" }, { id: "a2" }] },
    { name: "legacy-box", last_seen: now - 5_000_000, hermes_jobs: [{ id: "b1" }] }, // offline
    { name: "no-jobs-client", last_seen: now - 5_000 }, // key ABSENT ⇒ no group
    { name: "empty-client", last_seen: now - 5_000, hermes_jobs: [] }, // empty ⇒ no group
    { name: "also-online", last_seen: now - 5_000, hermes_jobs: [{ id: "c1" }] },
  ]);
  const groups = collectHermesJobGroups(st);
  assert.deepEqual(groups.map((g) => g.client), ["also-online", "m3-mac", "legacy-box"], "online-first, then name");
  assert.equal(groups[0].online, true);
  assert.equal(groups[1].online, true);
  assert.equal(groups[2].online, false, "90s heartbeat rule (the projectView parity)");
  assert.equal(groups[0].jobs.length, 1);
  assert.equal(groups[1].jobs.length, 2);
});
