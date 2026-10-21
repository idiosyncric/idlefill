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
  AGENT_H,
  buildMeshGraph,
  engineNodeId,
  foldReanchorFor,
  frameId,
  frameResourceIds,
  framedAgentCards,
  hostEdgesFor,
  layoutMesh,
  machineShape,
  meshChildOffsets,
  meshFrameSize,
  meshProjectOffsets,
  profileCardH,
  PROFILE_ROW_H,
  profileNodeId,
  PROJECT_H,
  projectCardH,
  PROJECTS_BOX_ID,
  projectNodeId,
  projectsBoxSize,
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

// --- breakout (per-CARD break-out of resources; the ⌘-drag vocabulary) -----

test("slots carry their machine label (the floating card's on-<machine> chip)", () => {
  for (const f of graph.frames) {
    for (const e of f.engines) assert.equal(e.machine, f.name);
    for (const a of f.agents) assert.equal(a.machine, f.name);
  }
});

test("machineShape: chip only when EVERY resource floats; frame otherwise", () => {
  const urza = graph.frames.find((f) => f.name === "urza")!;
  const local = graph.frames.find((f) => f.local)!;
  const scan = graph.frames.find((f) => f.name === "scanbot")!;
  const all = new Set([...frameResourceIds(urza)]);
  assert.equal(machineShape(urza, new Set()), "frame"); // nothing out — a frame
  assert.equal(machineShape(urza, new Set([agentNodeId("cli-urza")])), "frame"); // partial — still a frame
  assert.equal(machineShape(urza, all), "chip"); // everything out — a chip
  assert.equal(machineShape(scan, new Set()), "frame"); // no resources — never a chip
  // the empty-detached-set default never chips a resource-bearing machine
  assert.equal(machineShape(local, new Set()), "frame");
});

test("hostEdgesFor: every detached resource gets a hosts edge from its machine box", () => {
  const det = new Set([agentNodeId("cli-urza"), engineNodeId("srv-remote")]);
  const edges = hostEdgesFor(graph, det);
  assert.deepEqual(
    edges.map((e) => `${e.from}>${e.to}`).sort(),
    [`mch:urza>${engineNodeId("srv-remote")}`, `mch:urza>${agentNodeId("cli-urza")}`].sort(),
  );
  assert.ok(edges.every((e) => e.machine === "urza"));
  assert.deepEqual(hostEdgesFor(graph, new Set()), []); // framed: containment says it
});

test("hostEdgesFor: a partially broken machine edges ONLY for the card that floated", () => {
  const local = graph.frames.find((f) => f.local)!;
  const det = new Set([engineNodeId("srv-omlx")]); // the agent stays framed
  const edges = hostEdgesFor(graph, det);
  assert.deepEqual(edges.map((e) => `${e.from}>${e.to}`), [`${local.id}>${engineNodeId("srv-omlx")}`]);
});

test("a broken frame closes the gap: size and offsets track the cards still inside", () => {
  const local = graph.frames.find((f) => f.local)!; // 1 agent + 1 engine
  const full = meshFrameSize(local);
  const noEngine = meshFrameSize(local, new Set([engineNodeId("srv-omlx")]));
  const none = meshFrameSize(local, new Set(frameResourceIds(local)));
  assert.ok(noEngine.h < full.h && none.h < noEngine.h, "the frame shrinks as cards leave");
  const offs = meshChildOffsets(local, new Set([engineNodeId("srv-omlx")]));
  assert.ok(offs.has(agentNodeId("cli-mac")));
  assert.ok(!offs.has(engineNodeId("srv-omlx")), "a floating card has no framed slot");
});

test("layout honors per-card break-out: chip + cards, or frame + the floater", () => {
  const full = new Set([agentNodeId("cli-urza"), engineNodeId("srv-remote")]);
  const partial = new Set([engineNodeId("srv-omlx")]);
  for (const mode of ["rank", "row"] as const) {
    const pos = layoutMesh(graph, mode, new Set([...full, ...partial]));
    // the fully broken machine: chip keeps the machine box id, cards are their own
    assert.ok(pos.has(frameId("urza")), `${mode}: urza chip missing`);
    assert.ok(pos.has(agentNodeId("cli-urza")), `${mode}: broken agent not placed`);
    assert.ok(pos.has(engineNodeId("srv-remote")), `${mode}: broken engine not placed`);
    // the partially broken machine: still ONE frame box, plus the floater only
    assert.ok(pos.has(frameId(LOCAL_MACHINE)), `${mode}: local machine box missing`);
    assert.ok(pos.has(engineNodeId("srv-omlx")), `${mode}: the floater was not placed`);
    assert.ok(!pos.has(agentNodeId("cli-mac")), `${mode}: framed child leaked top-level`);
    // offline scanbot (framed, empty) still gets a box
    assert.ok(pos.has(frameId("scanbot")));
  }
});

test("broken layout boxes never overlap (full break-out on one machine, partial on another)", () => {
  const det = new Set([agentNodeId("cli-urza"), engineNodeId("srv-remote"), engineNodeId("srv-omlx")]);
  const pos = layoutMesh(graph, "rank", det);
  const boxOf = new Map<string, { w: number; h: number }>();
  for (const f of graph.frames) {
    boxOf.set(f.id, machineShape(f, det) === "chip" ? { w: 260, h: f.headerH } : meshFrameSize(f, det));
    for (const id of frameResourceIds(f))
      if (det.has(id)) boxOf.set(id, id.startsWith("agt:") ? { w: 306, h: 78 } : { w: 306, h: 100 });
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

// --- profile cards (owner ask 2026-10-19: one card per Hermes profile,
// its active sessions listed under it; the pipe starts on the card the
// gateway-ledger provenance stamp EXACTLY joins) -----------------------------

const rosterClient = (roster: { profile: string; posture: string }[]) =>
  ({ client_id: "cli-a", name: "cli-a", ip: "127.0.0.1", last_seen: NOW - 1_000, projects: [], agent_roster: roster }) as never;

const rosterState = (roster: { profile: string; posture: string }[], sessions: never[]) =>
  st({
    servers: [srv("eng1", "http://127.0.0.1:8000")],
    clients: [rosterClient(roster)],
    sessions,
  });

const ROSTER = [
  { profile: "web-dev", posture: "adopted" },
  { profile: "pr-agent", posture: "external" },
];

const rosterGraph = buildMeshGraph(
  rosterState(
    ROSTER,
    [
      sess("tok-owned1", "cli-a", "eng1", { hermes_meta: { profile: "web-dev" } }),
      sess("tok-owned2", "cli-a", "eng1", { hermes_meta: { profile: "web-dev" }, gate: { state: "queued", waiting: 1 } }),
      sess("tok-nostamp", "cli-a", "eng1"),
      sess("tok-offroster", "cli-a", "eng1", { hermes_meta: { profile: "ghost" } }),
      sess("tok-dead", "cli-a", "eng1", { hermes_meta: { profile: "web-dev" }, last_seen: NOW - 600_000 }),
    ] as never[],
  ),
  NOW,
);

test("the published roster renders as one profile card per row under its daemon", () => {
  const daemon = rosterGraph.frames[0].agents[0];
  assert.equal(daemon.name, "cli-a");
  assert.deepEqual(
    daemon.profiles.map((p) => [p.id, p.name, p.posture, p.daemon, p.machine]),
    [
      [profileNodeId("cli-a", "web-dev"), "web-dev", "adopted", agentNodeId("cli-a"), LOCAL_MACHINE],
      [profileNodeId("cli-a", "pr-agent"), "pr-agent", "external", agentNodeId("cli-a"), LOCAL_MACHINE],
    ],
  );
  // a roster-less client stays exactly one card (old clients unchanged)
  assert.deepEqual(graph.frames[0].agents[0].profiles, []);
});

test("a stamped session's pipe starts on its profile card; no-stamp / off-roster / stale keep the daemon", () => {
  const webDev = profileNodeId("cli-a", "web-dev");
  const flows = new Map(rosterGraph.flows.map((f) => [f.id, f.from]));
  assert.equal(flows.get("flow:tok-owned1"), webDev);
  assert.equal(flows.get("flow:tok-owned2"), webDev);
  assert.equal(flows.get("flow:tok-nostamp"), agentNodeId("cli-a"));
  assert.equal(flows.get("flow:tok-offroster"), agentNodeId("cli-a"));
  assert.equal(flows.has("flow:tok-dead"), false); // stale: no flow at all (unchanged law)
  assert.deepEqual(rosterGraph.unflowed, { noClient: 0, noEngine: 0, stale: 1 });
  // the daemon card COUNTS the sessions it still anchors — never absorbs them
  assert.equal(rosterGraph.frames[0].agents[0].unprofiled, 2);
});

test("profile cards LIST their live sessions (shared pipe facts, card never contradicts the edge)", () => {
  const [webDev, prAgent] = rosterGraph.frames[0].agents[0].profiles;
  assert.deepEqual(
    webDev.sessions.map((s) => [s.shortToken, s.engineName, s.phase, s.flowId]),
    [
      ["tok-ow", "eng1", "base", "flow:tok-owned1"],
      ["tok-ow", "eng1", "queued", "flow:tok-owned2"],
    ],
  );
  assert.match(webDev.sessions[1].title, /queued at the router/); // the shared pipeTitle
  assert.deepEqual(prAgent.sessions, []); // no stamp names it — honest zero rows, no guess
  // card height: base + one row per session; stale never counted
  assert.equal(webDev.h, profileCardH(2));
  assert.equal(prAgent.h, profileCardH(0));
});

test("frame size and offsets include the profile cards under their daemon (no overflow)", () => {
  const f = rosterGraph.frames[0];
  const { h } = meshFrameSize(f);
  const offs = meshChildOffsets(f);
  const stack = framedAgentCards(f);
  assert.deepEqual(stack.map((c) => c.id), [agentNodeId("cli-a"), profileNodeId("cli-a", "web-dev"), profileNodeId("cli-a", "pr-agent")]);
  for (const c of stack) {
    const o = offs.get(c.id)!;
    assert.ok(o.y >= 0 && o.y + c.h <= h, `${c.id} overflows the frame`);
  }
  // stacked right below the daemon, the two profile cards follow in order
  assert.ok(offs.get(profileNodeId("cli-a", "web-dev"))!.y > offs.get(agentNodeId("cli-a"))!.y);
  assert.ok(offs.get(profileNodeId("cli-a", "pr-agent"))!.y > offs.get(profileNodeId("cli-a", "web-dev"))!.y);
});

test("profile cards ride the breakout vocabulary: resources, chip, hosts edges, layout", () => {
  const f = rosterGraph.frames[0];
  const webDev = profileNodeId("cli-a", "web-dev");
  assert.ok(frameResourceIds(f).includes(webDev));
  // a daemon out but its cards in: still a frame; everything out: a chip
  assert.equal(machineShape(f, new Set([agentNodeId("cli-a")])), "frame");
  const all = new Set(frameResourceIds(f));
  assert.equal(machineShape(f, all), "chip");
  // one card floating: hosts edge from the machine box only for it
  const edges = hostEdgesFor(rosterGraph, new Set([webDev]));
  assert.deepEqual(edges.map((e) => `${e.from}>${e.to}`), [`${frameId(LOCAL_MACHINE)}>${webDev}`]);
  assert.match(edges[0].label, /hosts web-dev \(cli-a\)/);
  for (const mode of ["rank", "row"] as const) {
    const pos = layoutMesh(rosterGraph, mode, new Set([webDev]));
    assert.ok(pos.has(webDev), `${mode}: the floating profile was not placed`);
    assert.ok(!pos.has(agentNodeId("cli-a")), `${mode}: framed daemon leaked top-level`);
    assert.ok(pos.has(f.id), `${mode}: machine box missing`);
    // every top-level box gets a finite position (layout stays TOTAL)
    for (const [, p] of pos) assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
  }
});

test("a capped profile card stays bounded: 8 sessions render 5 + a more line, never 8 rows", () => {
  const many = Array.from({ length: 8 }, (_, i) => sess(`tok-many-${i}`, "cli-a", "eng1", { hermes_meta: { profile: "web-dev" } }) as never);
  const g = buildMeshGraph(rosterState(ROSTER, many), NOW);
  const p = g.frames[0].agents[0].profiles[0];
  assert.equal(p.sessions.length, 8);
  assert.equal(p.h, profileCardH(8));
  assert.equal(p.h, 40 + 5 * 15 + 15); // the view's cap + one "+N more" row
  // and the frame still contains it
  const offs = meshChildOffsets(g.frames[0]);
  assert.ok(offs.get(p.id)!.y + p.h <= meshFrameSize(g.frames[0]).h);
});

test("two daemons' same-named profiles never share a card or steal each other's sessions", () => {
  const g = buildMeshGraph(
    st({
      servers: [srv("eng1", "http://127.0.0.1:8000")],
      clients: [
        rosterClient(ROSTER),
        { client_id: "cli-b", name: "cli-b", ip: "127.0.0.1", last_seen: NOW - 1_000, projects: [], agent_roster: [{ profile: "web-dev", posture: "adopted" }] },
      ] as never,
      sessions: [sess("tok-x", "cli-b", "eng1", { hermes_meta: { profile: "web-dev" } }) as never],
    }),
    NOW,
  );
  const flow = g.flows[0];
  assert.equal(flow.from, profileNodeId("cli-b", "web-dev")); // its OWN daemon's card
  const cliA = g.frames[0].agents.find((a) => a.name === "cli-a")!;
  assert.deepEqual(cliA.profiles[0].sessions, []); // cli-a's same-named card claims nothing
});

// --- the model hop (owner ask 2026-10-19: session ⇢ idlefill's abstraction
// ⇢ engine). The model NAME is the session row's own, first-named-wins; the
// alias joins ONLY on a model_aliases winner whose (server, engine_model) —
// or (server, name) — pair is named EXACTLY and UNIQUELY. ------------------

const alias = (name: string, serverId: string, engineModel: string) =>
  ({ name, server_id: serverId, url: "http://127.0.0.1:1", auth_set: true, engine_model: engineModel, catalog_source: "probed" }) as never;

const hopGraph = buildMeshGraph(
  st({
    servers: [srv("eng1", "http://127.0.0.1:8000")],
    clients: [client("c", "127.0.0.1", NOW - 1_000)],
    model_aliases: [
      alias("Flash", "eng1", "qwen-real"),
      alias("Flash-alt", "eng1", "qwen-real"), // SAME pair — ambiguity names nothing
      alias("Solo", "eng1", "other-real"),
      alias("Elsewhere", "other-engine", "other-real"), // another row — no join
    ],
    sessions: [
      sess("s-sniff", "c", "eng1", { history: { rpm: [], model: "other-real", reported_at: NOW - 1_000 } }),
      sess("s-ambig", "c", "eng1", { history: { rpm: [], model: "qwen-real", reported_at: NOW - 1_000 } }),
      sess("s-meta", "c", "eng1", { hermes_meta: { model: "Solo" } }),
      sess("s-pin", "c", "eng1", { engine_pin: { server_id: "eng1", url: "http://127.0.0.1:8000", engine_model: "other-real", set_at: 0 } }),
      sess("s-none", "c", "eng1"),
    ],
  }),
  NOW,
);

test("a pipe names the model its ROW names, sourced — ledger stamp first, then pin, then the router sniff", () => {
  const flow = (t: string) => hopGraph.flows.find((f) => f.token === t)!;
  assert.deepEqual([flow("s-sniff").model, flow("s-sniff").modelSource], ["other-real", "sniffed"]);
  assert.deepEqual([flow("s-meta").model, flow("s-meta").modelSource], ["Solo", "ledger"]);
  assert.deepEqual([flow("s-pin").model, flow("s-pin").modelSource], ["other-real", "pin"]);
  assert.deepEqual([flow("s-none").model, flow("s-none").modelSource], [null, null]);
  assert.doesNotMatch(flow("s-none").title, /model/); // honest absence, never a claim
  assert.match(flow("s-sniff").title, /model other-real \(the model the router last sniffed\)/);
});

test("idlefill's abstraction joins EXACTLY and uniquely: one winner names the alias, two name nothing", () => {
  const flow = (t: string) => hopGraph.flows.find((f) => f.token === t)!;
  // unique (row, engine_model) winner → the pipe reads session ⇢ alias ⇢ engine
  assert.equal(flow("s-sniff").alias, "Solo");
  assert.match(flow("s-sniff").title, /· via alias Solo on this engine/);
  // TWO winners for the same pair → no alias claimed, the raw model stands
  assert.equal(flow("s-ambig").alias, null);
  assert.equal(flow("s-ambig").model, "qwen-real");
  assert.doesNotMatch(flow("s-ambig").title, /via alias/);
  // the row's name IS an alias → it stays the name; the tooltip says what it LANDS as
  assert.equal(flow("s-meta").alias, null); // no separate alias hop (the name already is it)
  assert.match(flow("s-meta").title, /lands at this engine as other-real/);
  // a pin naming the engine_model rides the same unique join
  assert.equal(flow("s-pin").alias, "Solo");
});

test("a profile card's listed line spells the full chain (shared facts, card never outruns the row)", () => {
  const g = buildMeshGraph(
    st({
      servers: [srv("eng1", "http://127.0.0.1:8000")],
      clients: [rosterClient([{ profile: "flash", posture: "adopted" }])],
      model_aliases: [alias("Qwen3.8-Flash-Next", "eng1", "qwen3.8-flash-next-q2_0")],
      sessions: [
        sess("tok-hop", "cli-a", "eng1", {
          hermes_meta: { profile: "flash" },
          history: { rpm: [], model: "qwen3.8-flash-next-q2_0", reported_at: NOW - 1_000 },
        }),
      ],
    }),
    NOW,
  );
  const line = g.frames[0].agents[0].profiles[0].sessions[0];
  assert.deepEqual([line.shortToken, line.model, line.alias, line.engineName], ["tok-ho", "qwen3.8-flash-next-q2_0", "Qwen3.8-Flash-Next", "eng1"]);
  assert.match(line.title, /model qwen3\.8-flash-next-q2_0 .* via alias Qwen3\.8-Flash-Next/);
});

// --- the daemon card LISTENS its unprofiled sessions (owner ask 2026-10-19,
// second pass). A session whose provenance names no roster profile cannot
// nest on a profile card (exact-join law) — but it must not hide as an
// invisible count either: the daemon card lists the SAME session ⇢ alias ⇢
// engine lines, and grows to fit them (fixed math, layout-shared). ---------

test("unprofiled live sessions are LISTED on the daemon card, capped, card grown to fit", () => {
  const g = buildMeshGraph(
    st({
      servers: [srv("eng1", "http://127.0.0.1:8000")],
      clients: [client("c", "127.0.0.1", NOW - 1_000)],
      model_aliases: [alias("Solo", "eng1", "qwen-real")],
      sessions: [
        ...Array.from({ length: 7 }, (_, i) =>
          sess(`u-${i}`, "c", "eng1", { history: { rpm: [], model: "qwen-real", reported_at: NOW - 1_000 } }),
        ),
        sess("stamped", "c", "eng1", { hermes_meta: { profile: "ghost" } }), // no roster row matches — still the daemon's
      ],
    }),
    NOW,
  );
  const a = g.frames[0].agents[0];
  assert.equal(a.unprofiled, 8);
  assert.equal(a.unprofiledSessions.length, 8);
  const line = a.unprofiledSessions[0];
  assert.deepEqual([line.shortToken, line.model, line.alias, line.engineName], ["u-0", "qwen-real", "Solo", "eng1"]);
  // height: AGENT_H + the LISTED rows (capped) — the same fixed math the layout reads.
  assert.equal(a.h, AGENT_H + 5 * PROFILE_ROW_H);
  const cards = framedAgentCards(g.frames[0]);
  assert.equal(cards[0].h, a.h);
  const offs = meshChildOffsets(g.frames[0]);
  assert.ok(offs.get(engineNodeId("eng1"))!.y >= offs.get(a.id)!.y + a.h); // children shift, never overlap
  assert.deepEqual(a.profiles, []); // an unmatched stamp nests NOTHING
});

test("a stamped session lists on its profile card and is never duplicated on the daemon card", () => {
  const g = buildMeshGraph(
    st({
      servers: [srv("eng1", "http://127.0.0.1:8000")],
      clients: [rosterClient([{ profile: "flash", posture: "adopted" }])],
      sessions: [
        sess("tok-a", "cli-a", "eng1", { hermes_meta: { profile: "flash" } }),
        sess("tok-b", "cli-a", "eng1", {}),
      ],
    }),
    NOW,
  );
  const a = g.frames[0].agents[0];
  assert.deepEqual(a.unprofiledSessions.map((l) => l.shortToken), ["tok-b"]);
  assert.equal(a.h, AGENT_H + PROFILE_ROW_H);
  assert.deepEqual(a.profiles[0].sessions.map((l) => l.shortToken), ["tok-a"]);
});

// --- the gateway FOLD (owner ask 2026-10-21): folding a gateway card hides
// the profile cards DOCKED under it — a broken-out card is its own box and
// stays out, the docked pipes re-anchor onto the gateway card that contains
// them, and the frame closes the gap the hidden cards left. The fold hides
// CARDS, never sessions or counts (the glance keeps reading "profiles N"). --

const FOLD_DAEMON = agentNodeId("cli-a");

test("the fold hides the docked profile cards: stack, size and offsets follow", () => {
  const f = rosterGraph.frames[0];
  const folded = new Set([FOLD_DAEMON]);
  const stack = framedAgentCards(f, new Set(), folded);
  assert.deepEqual(stack.map((c) => c.id), [FOLD_DAEMON]); // the docked cards are away
  assert.ok(meshFrameSize(f, new Set(), folded).h < meshFrameSize(f).h, "the frame shrinks");
  const offs = meshChildOffsets(f, new Set(), folded);
  assert.ok(offs.has(FOLD_DAEMON));
  assert.ok(!offs.has(profileNodeId("cli-a", "web-dev")));
  assert.ok(!offs.has(profileNodeId("cli-a", "pr-agent")));
  // the engine card closes the gap the hidden cards left (the same posture
  // a break-out takes — never a hole in the frame)
  assert.ok(offs.get(engineNodeId("eng1"))!.y >= offs.get(FOLD_DAEMON)!.y + stack[0].h);
});

test("the fold hides DOCKED cards only: a broken-out profile keeps its box and its pipes", () => {
  const webDev = profileNodeId("cli-a", "web-dev");
  const prAgent = profileNodeId("cli-a", "pr-agent");
  const folded = new Set([FOLD_DAEMON]);
  const det = new Set([webDev]);
  for (const mode of ["rank", "row"] as const) {
    const pos = layoutMesh(rosterGraph, mode, det, folded);
    assert.ok(pos.has(webDev), `${mode}: a broken-out profile folded away`);
    assert.ok(!pos.has(prAgent), `${mode}: a folded docked card leaked top-level`);
    assert.ok(pos.has(frameId(LOCAL_MACHINE)), `${mode}: machine box missing`);
    for (const [, p] of pos) assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y)); // still TOTAL
  }
  const re = foldReanchorFor(rosterGraph, folded, det);
  assert.equal(re.get(prAgent), FOLD_DAEMON);
  assert.ok(!re.has(webDev), "a floating card owns its own pipes");
});

test("folded docked pipes start on the gateway card; an empty fold moves nothing", () => {
  const folded = new Set([FOLD_DAEMON]);
  const re = foldReanchorFor(rosterGraph, folded);
  assert.equal(re.get(profileNodeId("cli-a", "web-dev")), FOLD_DAEMON);
  const moved = rosterGraph.flows.filter((fl) => re.has(fl.from)).map((fl) => fl.token).sort();
  assert.deepEqual(moved, ["tok-owned1", "tok-owned2"]); // the two stamped sessions ride the fold
  assert.deepEqual([...foldReanchorFor(rosterGraph, new Set())], []);
});

// --- the fleet-side PROJECTS stack (owner ask 2026-10-21): one card per
// arbiter project row, the queue depth a DIRECT count (0 renders 0); which
// machines drain a queue is the EXACT join worker.client_id → client row →
// frame — no client_id names no machine, never a similarity guess. --------

const workerRow = (client: string, queueDepth: number, online = true, clientId?: string) =>
  ({
    client,
    client_id: clientId,
    model: "m",
    estimated_seconds: 60,
    queue_depth: queueDepth,
    queue_preview: [],
    online,
    stats: {},
  }) as never;

const projRow = (name: string, workers: never[], paused = false, failed = 0) =>
  ({
    name,
    paused,
    daily_token_cap: 0,
    budget_today: { tokens_out: 0, tokens_in: 0, cap: 0 },
    workers,
    today: { finished: 3, failed },
    scheduling: {},
  }) as never;

const projGraph = buildMeshGraph(
  st({
    mesh: {
      instance_id: "i-mac",
      peers: [{ url: "http://100.105.225.1:8787", name: "urza", instance_id: "i-urza", online: true, fetch_age_s: 3, snapshot: null }],
    } as never,
    servers: [srv("e1", "http://127.0.0.1:1")],
    clients: [client("cli-m", "127.0.0.1", NOW - 1_000), client("cli-u", "100.105.225.1", NOW - 1_000)],
    projects: [
      projRow("idlefill", [workerRow("cli-m", 400, true, "cli-m"), workerRow("cli-u", 45, false, "cli-u")]),
      projRow("solo", [workerRow("cli-ghost", 7, false)]),
      projRow("parked", [], true),
    ] as never,
  }),
  NOW,
);

test("one slot per arbiter project row: direct counts, EXACT drain joins only", () => {
  assert.deepEqual(
    projGraph.projects.map((p) => p.id),
    [projectNodeId("idlefill"), projectNodeId("solo"), projectNodeId("parked")],
  );
  const idle = projGraph.projects[0];
  assert.equal(idle.queued, 445); // the DIRECT sum of the workers' published depths
  assert.deepEqual([idle.workers, idle.online], [2, 1]);
  assert.deepEqual(idle.machines, [frameId(LOCAL_MACHINE), frameId("urza")]); // the exact joins, deduped
  // a worker with no client_id names NO machine — never a guess by name
  assert.deepEqual([projGraph.projects[1].queued, projGraph.projects[1].machines], [7, []]);
  // an empty project is an honest zero, its paused flag carried
  assert.deepEqual([projGraph.projects[2].queued, projGraph.projects[2].workers, projGraph.projects[2].paused], [0, 0, true]);
});

test("the Projects box sizes, offsets within itself, and rides both layout modes", () => {
  const ps = projGraph.projects;
  const { w, h } = projectsBoxSize(ps);
  assert.equal(w, 330); // FRAME_W — the machine-box width, the cards are CARD_W inside
  const offs = meshProjectOffsets(ps);
  for (const p of ps) {
    const o = offs.get(p.id)!;
    assert.ok(o.y >= 0 && o.y + PROJECT_H <= h, `${p.id} overflows the box`);
  }
  for (const mode of ["rank", "row"] as const) {
    const pos = layoutMesh(projGraph, mode);
    const pp = pos.get(PROJECTS_BOX_ID);
    assert.ok(pp, `${mode}: projects box not placed`);
    assert.ok(Number.isFinite(pp.x) && Number.isFinite(pp.y) && pp.x >= 0 && pp.y >= 0);
    for (const f of projGraph.frames) {
      const fp = pos.get(f.id)!;
      const s = meshFrameSize(f);
      const disjoint = pp.x + w <= fp.x || fp.x + s.w <= pp.x || pp.y + h <= fp.y || fp.y + s.h <= pp.y;
      assert.ok(disjoint, `${mode}: the projects box overlaps ${f.name}`);
    }
  }
  // rank places the stack UPSTREAM of the machines whose gateways drain it
  const rank = layoutMesh(projGraph, "rank");
  assert.ok(rank.get(PROJECTS_BOX_ID)!.x < rank.get(frameId(LOCAL_MACHINE))!.x);
});

test("no projects rows: no stack, in the graph or in either layout mode", () => {
  assert.deepEqual(graph.projects, []); // the base fixture names no project
  for (const mode of ["rank", "row"] as const) assert.ok(!layoutMesh(graph, mode).has(PROJECTS_BOX_ID));
  // ... and no leases, so no chains and nothing undrawn either
  assert.deepEqual(graph.drains, []);
  assert.deepEqual(graph.undrained, { noProject: 0, noGateway: 0, paused: 0 });
});

// --- the running-job chains (the DRAIN law, owner ask 2026-10-21): an
// UNPAUSED project running jobs shows its routing and progress the way an
// agent session does — project card ⇢ the gateway of the worker running the
// job ⇢ the engine the lease names, every hop an EXACT join; the pipe rides
// the engine-side published facts; a paused project lists its jobs but
// draws no chains; every undrawn job is COUNTED and NAMED. ----------------

const lease = (id: string, project: string, clientId: string | undefined, serverId: string | undefined) =>
  ({
    lease_id: id,
    client_id: clientId,
    client_name: clientId ?? "ghost",
    server_id: serverId,
    project,
    job_id: `job-${id}`,
    estimated_seconds: 120,
    status: "active",
    granted_at: NOW - 70_000,
    expires_at: NOW + 60_000,
    tokens_out: 250,
    tokens_in: 1_200,
  }) as never;

const drainGraph = buildMeshGraph(
  st({
    mesh: {
      instance_id: "i-mac",
      peers: [{ url: "http://100.105.225.1:8787", name: "urza", instance_id: "i-urza", online: true, fetch_age_s: 3, snapshot: null }],
    } as never,
    servers: [
      srv("e-live", "http://127.0.0.1:1", { in_flight: 1, tokens_per_second: 40, queue_depth: 0, load_age_s: 2 }),
      srv("e-queued", "http://127.0.0.1:2", { idle: false, queue_depth: 3, load_age_s: 1 }),
      srv("e-remote", "http://100.105.225.1:11434", { idle: false, gpu_util_percent: 91 }),
    ],
    clients: [client("cli-m", "127.0.0.1", NOW - 1_000)],
    projects: [
      projRow("idlefill", [workerRow("cli-m", 4, true, "cli-m")]),
      projRow("parked", [workerRow("cli-m", 2, true, "cli-m")], true),
    ] as never,
    active_leases: [
      lease("L1", "idlefill", "cli-m", "e-live"),
      lease("L1b", "idlefill", "cli-m", "e-live"), // same full chain — fan-out pair
      lease("L2", "idlefill", "cli-m", undefined), // engine not named
      lease("L3", "idlefill", "ghost", "e-live"), // no gateway join
      lease("L4", "parked", "cli-m", "e-queued"), // paused project
      lease("L5", "ghostproj", "cli-m", "e-live"), // no project row
      lease("L6", "idlefill", "cli-m", "e-remote"), // engine on another machine
      lease("L7", "idlefill", "cli-m", "e-queued"), // fresh queue depth
    ] as never,
  }),
  NOW,
);

test("unpaused project running jobs: one chain per lease, EXACT joins only, every undrawn job named", () => {
  assert.deepEqual(drainGraph.drains.map((d) => d.id).sort(), ["drain:L1", "drain:L1b", "drain:L2", "drain:L6", "drain:L7"]);
  // the three join failures are COUNTED, never silently absent
  assert.deepEqual(drainGraph.undrained, { noProject: 1, noGateway: 1, paused: 1 });
  const l1 = drainGraph.drains.find((d) => d.id === "drain:L1")!;
  assert.equal(l1.from, projectNodeId("idlefill"));
  assert.equal(l1.to, agentNodeId("cli-m"));
  assert.equal(l1.engineTo, engineNodeId("e-live"));
  assert.equal(l1.machine, LOCAL_MACHINE);
  assert.equal(l1.cross, false);
  // a FRESH live-load sample on the engine row animates the chain (the row
  // itself proves traffic is moving — the Sessions attribution posture)
  assert.equal(l1.pipe.phase, "output");
  assert.equal(l1.pipe.animated, true);
  assert.equal(l1.pipe.muted, false);
  assert.match(l1.title, /engine e-live/);
  assert.match(l1.title, /engine streaming/);
  assert.match(l1.title, /running 1m 10s/); // the lease's own granted_at
  assert.match(l1.title, /~2m estimate/);
  assert.match(l1.title, /in 1\.2K \/ out 250/i);
  // a lease naming no engine row: the chain STOPS at the gateway, muted, and
  // the tooltip says so — never a guessed engine
  const l2 = drainGraph.drains.find((d) => d.id === "drain:L2")!;
  assert.equal(l2.engineTo, null);
  assert.equal(l2.pipe.muted, true);
  assert.match(l2.title, /engine not named/);
  assert.ok(!/not named.*not named/.test(l2.title)); // the clause rides the pipe reason ONCE
  // the engine row's fresh queue depth warns dashed
  const l7 = drainGraph.drains.find((d) => d.id === "drain:L7")!;
  assert.equal(l7.pipe.phase, "queued");
  assert.equal(l7.pipe.dashed, true);
  assert.equal(l7.pipe.animated, false);
  // an engine hosted on ANOTHER machine than the gateway crosses
  const l6 = drainGraph.drains.find((d) => d.id === "drain:L6")!;
  assert.equal(l6.engineTo, engineNodeId("e-remote"));
  assert.equal(l6.cross, true);
  // chains sharing the WHOLE chain fan out, centered
  const pair = drainGraph.drains.filter((d) => d.id === "drain:L1" || d.id === "drain:L1b");
  assert.deepEqual(pair.map((d) => d.offset), [-14, 14]);
});

test("running jobs are LISTED on the project card, capped, the card height follows; paused lists but never pipes", () => {
  const idle = drainGraph.projects.find((p) => p.name === "idlefill")!;
  assert.deepEqual(idle.running.map((r) => r.drainId).sort(), ["drain:L1", "drain:L1b", "drain:L2", "drain:L6", "drain:L7"]);
  const line2 = idle.running.find((r) => r.drainId === "drain:L2")!;
  assert.equal(line2.engine, null);
  assert.equal(line2.title, drainGraph.drains.find((d) => d.id === "drain:L2")!.title); // shared tooltip
  assert.equal(idle.running.find((r) => r.drainId === "drain:L6")!.cross, true);
  // machine is the GATEWAY's label (cli-m runs the job on This Machine);
  // the engine riding on urza is what `cross` names, never the label
  assert.equal(idle.running.find((r) => r.drainId === "drain:L6")!.machine, LOCAL_MACHINE);
  assert.equal(idle.h, projectCardH(5)); // PROJECT_H + 5 capped rows, the profile-card posture
  // the no-gateway lease draws NOTHING on the card either — it is the
  // undrained.noGateway count that names it (asserted above), never a line
  assert.ok(!idle.running.some((r) => r.drainId === "drain:L3"));
  // a PAUSED project lists its running job (a published fact is a fact, the
  // engine-side pipe facts included) but draws no chains — the paused gate
  const parked = drainGraph.projects.find((p) => p.name === "parked")!;
  assert.deepEqual(parked.running.map((r) => r.drainId), ["drain:L4"]);
  assert.equal(parked.running[0].phase, "queued");
  assert.equal(parked.h, projectCardH(1));
  assert.ok(!drainGraph.drains.some((d) => d.id === "drain:L4"));
});

test("the Projects box sizes to the listed rows and the layouts still place every box", () => {
  const ps = drainGraph.projects;
  const { h } = projectsBoxSize(ps);
  const flat = ps.map((p) => ({ ...p, running: [], h: PROJECT_H }));
  assert.ok(h > projectsBoxSize(flat).h); // the listed rows grew the box
  const offs = meshProjectOffsets(ps);
  for (const p of ps) {
    const o = offs.get(p.id)!;
    assert.ok(o.y + p.h <= h, `${p.id} overflows the grown box`);
  }
  for (const mode of ["rank", "row"] as const) {
    const pos = layoutMesh(drainGraph, mode);
    assert.ok(pos.get(PROJECTS_BOX_ID), `${mode}: the projects box not placed`);
    assert.ok(pos.get(frameId(LOCAL_MACHINE)), `${mode}: the machine not placed`);
  }
  // rank: the stack still rides upstream of the machine whose gateway runs its jobs
  const rank = layoutMesh(drainGraph, "rank");
  assert.ok(rank.get(PROJECTS_BOX_ID)!.x < rank.get(frameId(LOCAL_MACHINE))!.x);
});
