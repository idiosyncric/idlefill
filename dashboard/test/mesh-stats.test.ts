// mesh-stats.test.ts — the Machines tab tiles (the Overview discipline
// over the mesh). Pure logic (no DOM), node:test + tsx. The rules under
// test: FRESH (online) peer snapshots only in the sums, partial coverage
// named, offline/never-pulled peers named, engines counted idle-vs-total
// with degraded named, the verdict word aggregates the peer's own engines
// and leases — never a fake zero.

import { test } from "node:test";
import assert from "node:assert/strict";
import { freshPeers, meshTiles, peerVerdict } from "../src/lib/mesh-stats.js";
import type { MeshPeer } from "../src/lib/api.js";

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
