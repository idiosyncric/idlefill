// mesh-stats.test.ts — the Machines tab tiles (the Overview discipline
// over the mesh). Pure logic (no DOM), node:test + tsx. The rules under
// test: FRESH (online) peer snapshots only in the sums, partial coverage
// named, offline/never-pulled peers named, engines counted idle-vs-total
// with degraded named, the verdict word aggregates the peer's own engines
// and leases — never a fake zero.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGapLine, freshPeers, hostLine, intentWord, meshTiles, peerVerdict, relayOutcome } from "../src/lib/mesh-stats.js";
import type { MeshPeer, UpdateIntent } from "../src/lib/api.js";

function peer(over: Record<string, unknown> = {}): MeshPeer {
  return {
    url: "http://peer/",
    name: "peer",
    instance_id: "inst",
    online: true,
    fetch_age_s: 4,
    snapshot: {
      instance_id: "inst",
      name: "peer",
      ts: 0,
      servers: [{ name: "srv", idle: true, idle_for_s: 120, degraded: false }],
      queue_depth: 10,
      sessions: 3,
      active_leases: 1,
    },
    ...over,
  } as unknown as MeshPeer;
}

// Fresh snapshots sum; an offline peer (stale window lapsed) never counts.
test("mesh tiles sum the FRESH snapshots and name the coverage", () => {
  const peers = [
    peer({ snapshot: { servers: [{ name: "a", idle: true, idle_for_s: 5, degraded: false }], queue_depth: 1_200, sessions: 4, active_leases: 2 } }),
    peer({ snapshot: { servers: [{ name: "b", idle: false, idle_for_s: null, degraded: false }], queue_depth: 300, sessions: 1, active_leases: 0 } }),
    peer({ name: "down", online: false, fetch_age_s: 300, snapshot: { servers: [], queue_depth: 9_999, sessions: 0, active_leases: 9 } }),
  ];
  const [presence, queue, running, engines] = meshTiles(peers);
  assert.equal(presence.value, "2 of 3");
  assert.match(presence.sub, /last pull \d+s ago/);
  assert.equal(queue.value, "1,500");
  assert.equal(queue.sub, "2 of 3 peers reporting");
  assert.equal(running.value, "2");
  assert.equal(engines.value, "1 of 2");
  assert.equal(freshPeers(peers).length, 2, "the offline peer is not fresh");
});

// Peers configured but none answering: em-dashes with the reason named —
// never the "0" that would claim an empty mesh.
test("no fresh snapshot → em-dash tiles with the reason named, never a fake zero", () => {
  const peers = [peer({ online: false, fetch_age_s: 300 }), peer({ online: false, fetch_age_s: null, snapshot: null, error: "ECONNREFUSED" })];
  const [, queue, running, engines] = meshTiles(peers);
  assert.deepEqual([queue.value, running.value, engines.value], ["—", "—", "—"]);
  assert.equal(queue.sub, "no fresh peer snapshot — offline or failing pulls");
  const [presence] = meshTiles(peers);
  assert.equal(presence.value, "0 of 2");
  assert.equal(presence.sub, "last pull 5m 0s ago");
});

// A fresh peer that reports no engines is a named gap, not "0 of 0".
test("fresh peers with no engine rows name the gap on the engines tile", () => {
  const tiles = meshTiles([peer({ snapshot: { servers: [], queue_depth: 0, sessions: 0, active_leases: 0 } })]);
  assert.equal(tiles[1].value, "0", "queue_depth is a real reported zero");
  assert.equal(tiles[3].value, "—");
  assert.equal(tiles[3].sub, "no peer reports engines");
});

// Degraded engines are counted (not idle) and named in the sub.
test("degraded engines are named on the engines tile", () => {
  const tiles = meshTiles([
    peer({
      snapshot: {
        servers: [
          { name: "a", idle: true, idle_for_s: 10, degraded: false },
          { name: "b", idle: false, idle_for_s: null, degraded: true },
        ],
        queue_depth: 1,
        sessions: 0,
        active_leases: 0,
      },
    }),
  ]);
  assert.equal(tiles[3].value, "1 of 2");
  assert.equal(tiles[3].sub, "1 of 1 peer reporting · 1 degraded");
});

// The verdict word: the peer's engines + leases aggregate through the
// shared liveWord — degraded beats running beats idle/busy.
test("peerVerdict aggregates the peer's own state", () => {
  assert.equal(peerVerdict(null).label, "no data");
  const v = (servers: unknown[], leases: number) =>
    peerVerdict({ servers, active_leases: leases, queue_depth: 0, sessions: 0, ts: 0, instance_id: "i", name: "p" } as never);
  assert.equal(v([{ idle: true, degraded: false }], 0).label, "Idle");
  assert.equal(v([{ idle: false, degraded: false }], 0).label, "Busy");
  assert.equal(v([{ idle: false, degraded: false }], 2).label, "Running Idle Tasks");
  assert.equal(v([{ idle: true, degraded: true }], 0).label, "Degraded");
  assert.equal(v([], 1).label, "Running Idle Tasks", "no engines: the lease count still carries the word");
});

// hostLine — the htop-equivalent line renders ONLY the keys reported:
// partial blocks render partial lines, an empty/junk block renders NO line
// (the card omits it — never a bare "—", never a fake zero).
test("hostLine renders per-key and omits nothing-renders into a bare dash", () => {
  assert.equal(hostLine(null), null);
  assert.equal(hostLine({}), null);
  assert.equal(
    hostLine({ load1: 1.234, load5: 0.5, mem_total_bytes: 34_359_738_368, mem_free_bytes: 12_025_908_480, uptime_s: 275_000 }),
    "load 1.2/0.5 · mem 20.8/32.0 GiB · up 3d 4h",
  );
  assert.equal(hostLine({ cpus: 8 }), null, "cpu count alone is not a line — it lives in the tooltip");
  assert.equal(hostLine({ load1: 12.4 }), "load 12");
  assert.equal(hostLine({ uptime_s: 50 * 60 }), "up 50m");
  assert.equal(hostLine({ uptime_s: 4 * 3600 + 12 * 60 }), "up 4h 12m");
  assert.equal(hostLine({ mem_total_bytes: 34_359_738_368 }), "mem 32.0 GiB total", "free absent → total only, never an assumed usage");
  assert.equal(hostLine({ mem_total_bytes: 1000, mem_free_bytes: 9_999_999 }), "mem 0.0 GiB total", "a peer claiming free > total is not a fake negative usage");
});

// mesh-update.md D4 — the intent chips and the relayed answer's words.
// The words name the plane's truths: an unclaimed intent says WHY it went
// stale (no helper), a peer denial rides verbatim, no progress is invented.
test("intentWord names every state honestly", () => {
  const t0 = 1_000_000;
  const it = (over: Record<string, unknown>): UpdateIntent =>
    ({ id: "u-1", source_instance_id: "m-controller", requested_at: t0, state: "queued", ...over }) as UpdateIntent;
  assert.equal(intentWord(it({}), t0 + 60_000).label, "update queued");
  assert.match(intentWord(it({}), t0 + 60_000).note, /host updater helper/);
  assert.equal(intentWord(it({ state: "running", started_at: t0 + 5_000 }), t0 + 60_000).label, "update running");
  const done = intentWord(it({ state: "done", started_at: t0 + 5_000, finished_at: t0 + 40_000, detail: "image swapped" }), t0 + 60_000);
  assert.equal(done.label, "updated");
  assert.equal(done.tone, "ok");
  assert.match(done.note, /image swapped/);
  assert.equal(intentWord(it({ state: "failed", detail: "healthcheck failed" }), t0 + 60_000).tone, "err");
  const stale = intentWord(it({ state: "stale" }), t0 + 400_000);
  assert.equal(stale.label, "update stale");
  assert.match(stale.note, /can never execute/);
});

test("relayOutcome passes the peer's answer through named", () => {
  const q = relayOutcome({ status: 202, target: { ok: true, intent_id: "u-9", state: "queued" } });
  assert.equal(q.label, "update queued");
  assert.equal(q.tone, "ok");
  assert.match(q.note, /u-9/);
  const busy = relayOutcome({ status: 409, target: { error: "update_in_flight", intent_id: "u-1" } });
  assert.equal(busy.label, "update in flight");
  assert.equal(busy.tone, "warn");
  assert.match(busy.note, /u-1/);
  const denied = relayOutcome({ status: 403, target: { error: "bad_signature", hint: "the signature did not verify" } });
  assert.equal(denied.label, "bad_signature", "the peer's own named answer, verbatim");
  assert.equal(denied.tone, "err");
  assert.equal(denied.note, "the signature did not verify");
  const raw = relayOutcome({ status: 500, target: {} });
  assert.equal(raw.label, "HTTP 500", "a body-less answer is still a named status, never a silent success");
});

// ---------------------------------------------------------------------------
// The build gap (owner ask 2026-10-12) — the card's "how far behind is
// that machine?" line. The number is the LOCAL arbiter's git count; the
// words stay honest when no number is provable.
// ---------------------------------------------------------------------------

test("buildGapLine — the counter word, and the honest words when counting is impossible", () => {
  const withRev = (over: Record<string, unknown> = {}): MeshPeer =>
    peer({ snapshot: { ...(peer().snapshot as object), revision: "0f3a9c1e2b4d6a8c" }, ...over });
  assert.equal(buildGapLine(peer()), null, "no revision reported — no line, never a fake build");
  assert.equal(buildGapLine(withRev())?.text, "build 0f3a9c1", "sha alone — no local count, no gap word");
  assert.deepEqual(
    buildGapLine(withRev({ build: { relation: "behind", behind: 3 } })),
    { text: "build 0f3a9c1 · 3 behind", tone: "warn" },
    "the update word is warn — this is the whole point of the surface",
  );
  assert.deepEqual(buildGapLine(withRev({ build: { relation: "same" } })), { text: "build 0f3a9c1 · up to date", tone: "dim" });
  assert.deepEqual(
    buildGapLine(withRev({ build: { relation: "ahead", ahead: 1 } })),
    { text: "build 0f3a9c1 · 1 ahead of here", tone: "dim" },
    "the honest mirror: the viewer's machine is the stale one",
  );
  assert.deepEqual(buildGapLine(withRev({ build: { relation: "diverged", behind: 2, ahead: 5 } })), { text: "build 0f3a9c1 · builds diverged", tone: "warn" });
  assert.deepEqual(buildGapLine(withRev({ build: { relation: "unknown" } })), { text: "build 0f3a9c1 · builds differ", tone: "dim" }, "no number when none is provable");
});
