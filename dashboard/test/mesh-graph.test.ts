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
  frameResourceIds,
  framedAgentCards,
  hostEdgesFor,
  layoutMesh,
  machineShape,
  meshChildOffsets,
  meshFrameSize,
  profileCardH,
  profileNodeId,
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
