// mesh-graph.test.ts — the pure graph model behind the Mesh tab. The
// discipline under test is the SAME honesty law as the joins it reuses:
// a frame contains only rows the EXACT hierarchy joins give it; a session
// with no client join or no engine row yields NO edge and is COUNTED, never
// silently dropped or guessed onto a machine; a peer's own numbers ride its
// frame attributed (never merged with the declared joins); control arrows
// follow the pairing direction (`from controls to`); the pipe on each flow
// is the Sessions vocabulary (a held gate is queued; a fresh phase streams;
// a stale session is no flow at all); and every layout mode is total —
// every frame gets a finite position, none overlaps the frame's own extent.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  agentNodeId,
  buildMeshGraph,
  engineNodeId,
  frameId,
  hostEdgesFor,
  layoutMesh,
  meshChildOffsets,
  meshFrameSize,
} from "../src/lib/mesh-graph.js";
import { LOCAL_MACHINE } from "../src/lib/hierarchy.js";
import type { StateSnapshot } from "../src/lib/api.js";

const NOW = 1_000_000_000_000;

const st = (patch: Partial<StateSnapshot>): StateSnapshot =>
  ({ now: NOW, servers: [], clients: [], sessions: [], ...(patch as object) }) as StateSnapshot;

const srv = (id: string, url: string, signal?: Record<string, unknown>) =>
  ({
    id,
    name: id,
    url,
    auth_set: false,
    watched: true,
    signal: signal ? ({ idle: true, degraded: false, ...signal } as never) : null,
    model_source: "probed",
    probed_at: 0,
    models: [],
  }) as never;

const client = (id: string, ip: string, lastSeen: number) =>
  ({ client_id: id, name: id, ip, last_seen: lastSeen, projects: [] }) as never;

const sess = (token: string, clientId: string | undefined, serverId: string | undefined, patch: Record<string, unknown> = {}) =>
  ({
    token,
    client_id: clientId,
    server_id: serverId,
    registered_at: NOW - 60_000,
    last_seen: NOW - 5_000,
    ...(patch as object),
  }) as never;

const peerUrza = {
  url: "http://100.105.225.1:8787",
  name: "urza",
  instance_id: "i-urza",
  online: true,
  fetch_age_s: 3,
  i_control: true,
  snapshot: {
    instance_id: "i-urza",
    name: "urza",
    ts: NOW,
    servers: [
      { name: "srv-remote", idle: false, idle_for_s: null, degraded: false },
      { name: "extra-engine", idle: true, idle_for_s: 90, degraded: false },
    ],
    queue_depth: 7,
    sessions: 4,
    active_leases: 1,
    version: "4",
  },
};
const peerScan = {
  url: "http://10.10.10.6:8787",
  name: "scanbot",
  instance_id: "i-scan",
  online: false,
  fetch_age_s: 600,
  controls_me: true,
  snapshot: null,
};

const base = st({
  mesh: { instance_id: "i-mac", peers: [peerUrza as never, peerScan as never] },
  servers: [
    srv("srv-omlx", "http://127.0.0.1:8000", { in_flight: 1, queue_depth: 0, load_age_s: 2, load_source: "strata" }),
    srv("srv-remote", "http://100.105.225.1:11434", { idle: false, gpu_util_percent: 91 }),
    srv("srv-orphan", "http://elsewhere.example:9"),
  ],
  clients: [client("cli-mac", "127.0.0.1", NOW - 5_000), client("cli-urza", "100.105.225.1", NOW - 5_000)],
  sessions: [
    sess("tok-aaaaaa", "cli-mac", "srv-remote", { gate: { state: "queued", waiting: 2 } }),
    sess("tok-bbbbbb", "cli-urza", "srv-omlx", { phase: { state: "output", at: NOW - 2_000 } }),
    sess("tok-cccccc", undefined, "srv-omlx"),
    sess("tok-dddddd", "cli-mac", "gone-engine"),
    sess("tok-eeeeee", "cli-mac", "srv-omlx", { last_seen: NOW - 600_000 }),
    sess("tok-ffffff", "cli-mac", "srv-omlx"),
  ],
});

const graph = buildMeshGraph(base, NOW);

test("frames: This Machine first, every configured peer gets one, unhosted rows count separately", () => {
  assert.deepEqual(
    graph.frames.map((f) => f.name),
    [LOCAL_MACHINE, "urza", "scanbot"],
  );
  assert.equal(graph.unhosted, 1); // srv-orphan names no machine
  assert.equal(graph.frames[0].local, true);
  assert.equal(graph.frames[2].online, false);
});

test("engine + agent membership rides the EXACT joins, never a guess", () => {
  const [local, urza] = graph.frames;
  assert.deepEqual(local.engines.map((e) => e.id), [engineNodeId("srv-omlx")]);
  assert.deepEqual(urza.engines.map((e) => e.id), [engineNodeId("srv-remote")]);
  assert.deepEqual(local.agents.map((a) => a.id), [agentNodeId("cli-mac")]);
  assert.deepEqual(urza.agents.map((a) => a.id), [agentNodeId("cli-urza")]);
});

test("peer numbers ride the frame ATTRIBUTED; the peer's unwatched engine dedupes by name", () => {
  const urza = graph.frames.find((f) => f.name === "urza")!;
  assert.deepEqual(urza.reported, { queued: 7, sessions: 4, leases: 1 });
  assert.deepEqual(urza.reportedEngines.map((e) => e.name), ["extra-engine"]); // srv-remote is a declared row
  assert.equal(graph.frames[0].reported, null); // the local frame never borrows peer numbers
});

test("control edges follow the pairing direction (from controls to)", () => {
  const localFrame = frameId(LOCAL_MACHINE);
  assert.deepEqual(graph.controls, [
    { id: `ctl:${localFrame}>${frameId("urza")}`, from: localFrame, to: frameId("urza") },
    { id: `ctl:${frameId("scanbot")}>${localFrame}`, from: frameId("scanbot"), to: localFrame },
  ]);
  const [local, urza, scan] = graph.frames;
  assert.deepEqual(urza.controlledBy, [LOCAL_MACHINE]);
  assert.deepEqual(local.controls, ["urza"]);
  assert.deepEqual(scan.controls, [LOCAL_MACHINE]);
});

test("flow edges: exact client+engine joins only; every omission is COUNTED", () => {
  const ids = graph.flows.map((f) => f.id);
  assert.deepEqual(ids, ["flow:tok-aaaaaa", "flow:tok-bbbbbb", "flow:tok-ffffff"]);
  const [crossQ, crossS, same] = graph.flows;
  assert.equal(crossQ.from, agentNodeId("cli-mac"));
  assert.equal(crossQ.to, engineNodeId("srv-remote"));
  assert.equal(crossQ.cross, true);
  assert.equal(crossS.cross, true);
  assert.equal(same.cross, false); // cli-mac → srv-omlx both on This Machine
  assert.equal(crossQ.pipe.phase, "queued"); // a held gate outranks everything
  assert.equal(crossQ.pipe.animated, false);
  assert.equal(crossS.pipe.phase, "output"); // fresh phase report streams
  assert.equal(crossS.pipe.animated, true);
  assert.deepEqual(graph.unflowed, { noClient: 1, noEngine: 1, stale: 1 });
});

test("parallel flows between one pair fan out (offsets centered on zero)", () => {
  const g = buildMeshGraph(
    st({
      servers: [srv("s", "http://127.0.0.1:1")],
      clients: [client("c", "127.0.0.1", NOW - 1_000)],
      sessions: [sess("t1", "c", "s"), sess("t2", "c", "s"), sess("t3", "c", "s")],
    }),
    NOW,
  );
  assert.deepEqual(g.flows.map((f) => f.offset), [-28, 0, 28]);
});

test("layout is TOTAL: every frame gets a finite position in every mode", () => {
  for (const mode of ["rank", "row"] as const) {
    const pos = layoutMesh(graph, mode);
    assert.equal(pos.size, graph.frames.length);
    for (const [, p] of pos) {
      assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y), `${mode}: ${p.x},${p.y}`);
      assert.ok(p.x >= 0 && p.y >= 0);
    }
    // no two frames overlap (boxes stay disjoint with the layout's gaps)
    const boxes = graph.frames.map((f) => {
      const p = pos.get(f.id)!;
      const s = meshFrameSize(f);
      return { x1: p.x, y1: p.y, x2: p.x + s.w, y2: p.y + s.h };
    });
    for (let i = 0; i < boxes.length; i++)
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i];
        const b = boxes[j];
        const disjoint = a.x2 <= b.x1 || b.x2 <= a.x1 || a.y2 <= b.y1 || b.y2 <= a.y1;
        assert.ok(disjoint, `${mode}: frames ${i}/${j} overlap`);
      }
  }
});

test("children stay inside their frame: offsets sit flush within the computed height", () => {
  for (const f of graph.frames) {
    const { h } = meshFrameSize(f);
    const offs = meshChildOffsets(f);
    for (const [id, o] of offs) {
      assert.ok(o.x >= 0, id);
      assert.ok(o.y >= 0, id);
    }
    const last = [...offs.values()].sort((a, b) => b.y - a.y)[0];
    if (last) {
      const isEngine = f.engines.some((e) => offs.get(e.id) === last);
      assert.ok(last.y + (isEngine ? 100 : 78) <= h, `${f.name}: child overflows the frame`);
    }
  }
});

test("no mesh at all: the single frame is This Machine and every row rides it", () => {
  const solo = buildMeshGraph(
    st({ servers: [srv("a", "http://127.0.0.1:1"), srv("b", "http://10.0.0.5:2")], clients: [], sessions: [] }),
    NOW,
  );
  assert.equal(solo.frames.length, 1);
  assert.equal(solo.frames[0].name, LOCAL_MACHINE);
  assert.equal(solo.frames[0].engines.length, 2); // the local-only rule
  assert.equal(solo.unhosted, 0);
});

test("a pinned session follows the pin, and the tooltip is the shared pipe text", () => {
  const g = buildMeshGraph(
    st({
      servers: [srv("s1", "http://127.0.0.1:1"), srv("s2", "http://127.0.0.1:2")],
      clients: [client("c", "127.0.0.1", NOW - 1_000)],
      sessions: [sess("tok1", "c", "s1", { engine_pin: { server_id: "s2", url: "http://127.0.0.1:2", set_at: 0 } })],
    }),
    NOW,
  );
  assert.equal(g.flows.length, 1);
  assert.equal(g.flows[0].to, engineNodeId("s2"));
  assert.equal(g.flows[0].pinned, true);
  assert.match(g.flows[0].title, /operator pin/);
});

// --- breakout (per-machine break-out of resources) ------------------------

test("slots carry their machine label (the floating card's on-<machine> chip)", () => {
  for (const f of graph.frames) {
    for (const e of f.engines) assert.equal(e.machine, f.name);
    for (const a of f.agents) assert.equal(a.machine, f.name);
  }
});

test("hostEdgesFor: only broken machines get hosts edges, chip → each resource", () => {
  const broken = new Set(["urza"]);
  const edges = hostEdgesFor(graph, broken);
  assert.deepEqual(
    edges.map((e) => `${e.from}>${e.to}`).sort(),
    [`mch:urza>${engineNodeId("srv-remote")}`, `mch:urza>${agentNodeId("cli-urza")}`].sort(),
  );
  assert.ok(edges.every((e) => e.machine === "urza"));
  assert.deepEqual(hostEdgesFor(graph, new Set()), []); // framed: containment says it
});

test("layout honors breakout: a broken machine contributes chip + card boxes; framed machines stay one box", () => {
  const broken = new Set(["urza"]);
  for (const mode of ["rank", "row"] as const) {
    const pos = layoutMesh(graph, mode, broken);
    // the broken machine's chip keeps the machine box id, cards appear as their own
    assert.ok(pos.has(frameId("urza")), `${mode}: urza chip missing`);
    assert.ok(pos.has(agentNodeId("cli-urza")), `${mode}: broken agent not placed`);
    assert.ok(pos.has(engineNodeId("srv-remote")), `${mode}: broken engine not placed`);
    // framed machines stay a single box — their children are NOT top-level
    assert.ok(pos.has(frameId(LOCAL_MACHINE)));
    assert.ok(!pos.has(agentNodeId("cli-mac")), `${mode}: framed child leaked top-level`);
    assert.ok(!pos.has(engineNodeId("srv-omlx")), `${mode}: framed child leaked top-level`);
    // offline scanbot (framed, empty) still gets a box
    assert.ok(pos.has(frameId("scanbot")));
  }
});

test("broken layout boxes never overlap", () => {
  const broken = new Set(["urza"]);
  const pos = layoutMesh(graph, "rank", broken);
  const boxOf = new Map<string, { w: number; h: number }>();
  for (const f of graph.frames) {
    if (broken.has(f.name)) {
      boxOf.set(f.id, { w: 260, h: f.headerH });
      for (const a of f.agents) boxOf.set(a.id, { w: 306, h: 78 });
      for (const e of f.engines) boxOf.set(e.id, { w: 306, h: 100 });
    } else {
      boxOf.set(f.id, meshFrameSize(f));
    }
  }
  const rects = [...pos.entries()].map(([id, p]) => {
    const s = boxOf.get(id)!;
    return { id, x1: p.x, y1: p.y, x2: p.x + s.w, y2: p.y + s.h };
  });
  for (let i = 0; i < rects.length; i++)
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i];
      const b = rects[j];
      const disjoint = a.x2 <= b.x1 || b.x2 <= a.x1 || a.y2 <= b.y1 || b.y2 <= a.y1;
      assert.ok(disjoint, `${a.id} overlaps ${b.id}`);
    }
});

test("header height grows with the glance lines a machine actually renders", () => {
  const [local, urza, scan] = graph.frames;
  assert.ok(urza.headerH > scan.headerH, "urza's report lines make it taller than the bare offline row");
  assert.ok(local.headerH >= 39 + 2 * 18, "the counts row always counts");
});
