// mesh-view.test.ts — the pure visibility lens behind the Mesh sidebar.
// The discipline under test: the lens DROPS what the operator hides and
// COUNTS it (tally) — never a silent gap; a hidden machine takes its
// subtree AND its edge ends with it; a hidden card drops the flows that
// touched it but never touches the JOIN honesty counts (`unflowed`,
// `unhosted` say what the DATA lacks, the tally says what the OPERATOR
// hid); the glance lines never name a machine that is no longer drawn
// (and headerH follows the lines that remain); and everything that reads
// persisted JSON sanitizes instead of trusting.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  agentNodeId,
  buildMeshGraph,
  engineNodeId,
  frameId,
  meshFrameSize,
  profileNodeId,
  projectNodeId,
} from "../src/lib/mesh-graph.js";
import {
  applyMeshView,
  defaultMeshPrefs,
  sanitizeMeshPrefs,
  sanitizeMeshViews,
  type MeshViewPrefs,
} from "../src/lib/mesh-view.js";
import { LOCAL_MACHINE } from "../src/lib/hierarchy.js";
import type { StateSnapshot } from "../src/lib/api.js";

const NOW = 1_000_000_000_000;

const st = (patch: Partial<StateSnapshot>): StateSnapshot =>
  ({ now: NOW, servers: [], clients: [], sessions: [], ...(patch as object) }) as StateSnapshot;

const srv = (id: string, url: string) =>
  ({
    id,
    name: id,
    url,
    auth_set: false,
    watched: true,
    signal: { idle: true, degraded: false, load_age_s: 2 } as never,
    model_source: "probed",
    probed_at: 0,
    models: [],
  }) as never;

const client = (id: string, ip: string) =>
  ({ client_id: id, name: id, ip, last_seen: NOW - 5_000, projects: [] }) as never;

const sess = (token: string, clientId: string | undefined, serverId: string | undefined, patch: Record<string, unknown> = {}) =>
  ({
    token,
    client_id: clientId,
    server_id: serverId,
    registered_at: NOW - 60_000,
    last_seen: NOW - 5_000,
    ...(patch as object),
  }) as never;

const base = st({
  mesh: {
    instance_id: "i-mac",
    peers: [
      {
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
          servers: [{ name: "srv-remote", idle: true, idle_for_s: 9, degraded: false }],
          queue_depth: 7,
          sessions: 1,
          active_leases: 1,
          version: "4",
        },
      },
    ],
  },
  servers: [srv("srv-omlx", "http://127.0.0.1:8000"), srv("srv-remote", "http://100.105.225.1:11434")],
  clients: [client("cli-mac", "127.0.0.1"), client("cli-urza", "100.105.225.1")],
  sessions: [
    sess("tok-aaaaaa", "cli-mac", "srv-remote"),
    sess("tok-bbbbbb", "cli-urza", "srv-omlx"),
    sess("tok-gggggg", "cli-mac", "srv-omlx"),
  ],
});

const graph = buildMeshGraph(base, NOW);

const prefs = (
  patch: Partial<MeshViewPrefs> & { layers?: Partial<MeshViewPrefs["layers"]> } = {},
): MeshViewPrefs => ({
  layers: { ...defaultMeshPrefs().layers, ...(patch.layers ?? {}) },
  hidden: patch.hidden ?? [],
  isolated: patch.isolated ?? null,
});

test("the default lens is the identity — same reference, nothing counted", () => {
  const { graph: out, tally } = applyMeshView(graph, defaultMeshPrefs());
  assert.equal(out, graph);
  assert.deepEqual(tally, { machines: 0, agents: 0, engines: 0, flows: 0, drains: 0, controls: 0 });
});

test("agents layer off: agent cards and every flow pipe drop, engines and controls stay", () => {
  const { graph: out, tally } = applyMeshView(graph, prefs({ layers: { agents: false } }));
  for (const f of out.frames) assert.deepEqual(f.agents, []);
  assert.deepEqual(out.flows, []);
  assert.equal(tally.agents, 2);
  assert.equal(tally.flows, 3);
  assert.equal(out.controls.length, graph.controls.length);
  assert.deepEqual(
    out.frames.flatMap((f) => f.engines.map((e) => e.id)),
    [engineNodeId("srv-omlx"), engineNodeId("srv-remote")],
  );
});

test("hiding one engine: its card is gone, its frame shrinks, its flows count in the TALLY, not in unflowed", () => {
  const { graph: out, tally } = applyMeshView(graph, prefs({ hidden: [engineNodeId("srv-omlx")] }));
  const local = out.frames.find((f) => f.name === LOCAL_MACHINE)!;
  assert.deepEqual(local.engines, []);
  const urza = out.frames.find((f) => f.name === "urza")!;
  assert.deepEqual(urza.engines.map((e) => e.id), [engineNodeId("srv-remote")]);
  // the two pipes into srv-omlx drop, the one into srv-remote stands
  assert.deepEqual(out.flows.map((f) => f.id), ["flow:tok-aaaaaa"]);
  assert.equal(tally.engines, 1);
  assert.equal(tally.flows, 2);
  // JOIN honesty is untouched: the lens hid it, the data never lacked it.
  assert.deepEqual(out.unflowed, graph.unflowed);
  assert.equal(out.unhosted, graph.unhosted);
  // and the frame sized to the cards still inside shrinks
  assert.ok(meshFrameSize(local).h < meshFrameSize(graph.frames.find((f) => f.name === LOCAL_MACHINE)!).h);
});

test("hiding a machine takes the subtree, its control edges, and drops its name from every glance line", () => {
  const { graph: out, tally } = applyMeshView(graph, prefs({ hidden: [frameId("urza")] }));
  assert.deepEqual(out.frames.map((f) => f.name), [LOCAL_MACHINE]);
  assert.equal(tally.machines, 1);
  assert.equal(tally.agents, 1); // cli-urza went with its machine
  assert.equal(tally.engines, 1);
  assert.equal(tally.flows, 2); // the two pipes touching urza drop; the local-only one stands
  assert.deepEqual(out.flows.map((f) => f.id), ["flow:tok-gggggg"]);
  assert.equal(tally.controls, 1); // the local→urza control edge is gone
  assert.deepEqual(out.controls, []);
  const local = out.frames[0];
  assert.deepEqual(local.controls, []); // never names a machine that is not drawn
  assert.equal(local.headerH < graph.frames[0].headerH, true); // the dropped glance line frees the header
});

test("controls layer off: the edges drop, the glance lines (facts) stay", () => {
  const { graph: out, tally } = applyMeshView(graph, prefs({ layers: { controls: false } }));
  assert.deepEqual(out.controls, []);
  assert.equal(tally.controls, graph.controls.length);
  const local = out.frames.find((f) => f.name === LOCAL_MACHINE)!;
  assert.deepEqual(local.controls, ["urza"]); // the control is still a fact, just not an edge
  assert.deepEqual(
    out.frames.map((f) => f.id),
    graph.frames.map((f) => f.id),
  );
});

test("hiding one pipe: a flow:<token> entry in `hidden` drops exactly that pipe", () => {
  const { graph: out, tally } = applyMeshView(graph, prefs({ hidden: ["flow:tok-bbbbbb"] }));
  assert.deepEqual(out.flows.map((f) => f.id).sort(), ["flow:tok-aaaaaa", "flow:tok-gggggg"]);
  assert.equal(tally.flows, 1);
  assert.equal(tally.agents, 0); // the cards stand; only the pipe is hidden
  assert.equal(tally.engines, 0);
});

test("ISOLATE a session pipe: exactly its two cards, the two machines and the one hop", () => {
  const { graph: out, tally } = applyMeshView(graph, prefs({ isolated: "flow:tok-aaaaaa" }));
  // tok-aaaaaa = cli-mac (local) → srv-remote (urza): the cross-machine hop.
  assert.deepEqual(out.flows.map((f) => f.id), ["flow:tok-aaaaaa"]);
  const [local, urza] = out.frames;
  assert.deepEqual(local.agents.map((a) => a.id), [agentNodeId("cli-mac")]);
  assert.deepEqual(local.engines, []); // srv-omlx is not part of THIS hop
  assert.deepEqual(urza.agents, []);
  assert.deepEqual(urza.engines.map((e) => e.id), [engineNodeId("srv-remote")]);
  assert.equal(tally.agents, 1);
  assert.equal(tally.engines, 1);
  assert.equal(tally.flows, 2); // the other two pipes counted away
  assert.equal(tally.machines, 0); // both machines are the hop's context
  assert.equal(tally.controls, 0); // local→urza stands: both endpoints drawn
  assert.equal(out.controls.length, 1);
});

test("ISOLATE an engine: every pipe feeding it, back to the daemons and their machines", () => {
  const { graph: out, tally } = applyMeshView(graph, prefs({ isolated: engineNodeId("srv-omlx") }));
  assert.deepEqual(out.flows.map((f) => f.id).sort(), ["flow:tok-bbbbbb", "flow:tok-gggggg"]);
  const [local, urza] = out.frames;
  assert.deepEqual(local.agents.map((a) => a.id), [agentNodeId("cli-mac")]);
  assert.deepEqual(local.engines.map((e) => e.id), [engineNodeId("srv-omlx")]);
  assert.deepEqual(urza.agents.map((a) => a.id), [agentNodeId("cli-urza")]);
  assert.deepEqual(urza.engines, []); // srv-remote feeds nothing into this isolate
  assert.equal(tally.flows, 1); // tok-aaaaaa (into srv-remote) counted away
  assert.equal(tally.engines, 1);
});

test("ISOLATE a machine: its whole interior, only the pipes BETWEEN its own cards", () => {
  const { graph: out, tally } = applyMeshView(graph, prefs({ isolated: frameId(LOCAL_MACHINE) }));
  assert.deepEqual(out.frames.map((f) => f.name), [LOCAL_MACHINE]);
  assert.deepEqual(out.flows.map((f) => f.id), ["flow:tok-gggggg"]); // internal hop only
  assert.deepEqual(out.controls, []); // the cross-machine control edge is not interior
  assert.equal(tally.machines, 1);
  assert.equal(tally.flows, 2);
  assert.equal(tally.controls, 1);
});

test("ISOLATE a vanished element degrades honestly: full view back, named lost", () => {
  const { graph: out, tally, isolatedLost } = applyMeshView(graph, prefs({ isolated: "flow:tok-zzzzzz" }));
  assert.equal(isolatedLost, true);
  assert.equal(out.frames.length, graph.frames.length);
  assert.equal(out.flows.length, graph.flows.length);
  assert.deepEqual(tally, { machines: 0, agents: 0, engines: 0, flows: 0, drains: 0, controls: 0 });
});

test("prefs sanitize: junk yields the default, partial layers merge, hidden dedupes", () => {
  assert.deepEqual(sanitizeMeshPrefs(undefined), defaultMeshPrefs());
  assert.deepEqual(sanitizeMeshPrefs("nope"), defaultMeshPrefs());
  const merged = sanitizeMeshPrefs({ layers: { agents: false, bogus: 1 }, hidden: ["eng:a", "eng:a", 7, "mch:b"] });
  assert.equal(merged.layers.agents, false);
  assert.equal(merged.layers.engines, true); // untouched keys keep the default
  assert.deepEqual(merged.hidden, ["eng:a", "mch:b"]);
  assert.equal(merged.isolated, null); // absent stays null
  assert.equal(sanitizeMeshPrefs({ isolated: "flow:tok-a" }).isolated, "flow:tok-a");
  assert.equal(sanitizeMeshPrefs({ isolated: 7 }).isolated, null);
});

test("saved views sanitize: junk entries drop, a repeated name keeps the last write", () => {
  const out = sanitizeMeshViews([
    null,
    { name: "  ", mode: "rank", prefs: {} },
    { name: "engines-only", mode: "nonsense", prefs: {} },
    { name: "ops", mode: "row", prefs: { layers: { engines: false } } },
    { name: "ops", mode: "free", prefs: {} },
  ]);
  assert.deepEqual(
    out.map((v) => [v.name, v.mode]),
    [["ops", "free"]],
  );
  assert.equal(sanitizeMeshViews("nope").length, 0);
});

// --- profile cards under the lens (per-profile cards, owner ask 2026-10-19):
// one card hides alone; the daemon hides as a SUBTREE; a profile isolate
// keeps its host daemon; the tally counts cards AND daemons as agents. ------

const rosterGraph = buildMeshGraph(
  st({
    servers: [srv("eng1", "http://127.0.0.1:8000")],
    clients: [
      {
        client_id: "cli-a",
        name: "cli-a",
        ip: "127.0.0.1",
        last_seen: NOW - 5_000,
        projects: [],
        agent_roster: [
          { profile: "web-dev", posture: "adopted" },
          { profile: "pr-agent", posture: "external" },
        ],
      } as never,
    ],
    sessions: [sess("tok-p1", "cli-a", "eng1", { hermes_meta: { profile: "web-dev" } }), sess("tok-d1", "cli-a", "eng1")],
  }),
  NOW,
);

test("the default lens over profile cards is still the identity", () => {
  const { graph: out, tally } = applyMeshView(rosterGraph, defaultMeshPrefs());
  assert.equal(out, rosterGraph);
  assert.deepEqual(tally, { machines: 0, agents: 0, engines: 0, flows: 0, drains: 0, controls: 0 });
});

test("hiding one profile card drops exactly that card and the pipe starting on it", () => {
  const { graph: out, tally } = applyMeshView(rosterGraph, prefs({ hidden: [profileNodeId("cli-a", "web-dev")] }));
  const agent = out.frames[0].agents[0];
  assert.equal(agent.id, agentNodeId("cli-a")); // the daemon stands
  assert.deepEqual(agent.profiles.map((p) => p.name), ["pr-agent"]);
  assert.deepEqual(out.flows.map((f) => f.id), ["flow:tok-d1"]); // the daemon-held pipe stands
  assert.equal(tally.agents, 1); // one card counted
  assert.equal(tally.flows, 1);
  // the frame shrinks with the card (size follows the DRAWN stack)
  assert.ok(meshFrameSize(out.frames[0]).h < meshFrameSize(rosterGraph.frames[0]).h);
});

test("hiding a daemon takes its profile cards as a subtree, and every pipe anchored in the subtree", () => {
  const { graph: out, tally } = applyMeshView(rosterGraph, prefs({ hidden: [agentNodeId("cli-a")] }));
  assert.deepEqual(out.frames[0].agents, []);
  assert.deepEqual(out.flows, []);
  assert.equal(tally.agents, 3); // daemon + both profile cards counted — never a silent gap
  assert.equal(tally.flows, 2);
});

test("ISOLATE a profile card: the hop keeps its host daemon, its own pipes, and the far ends", () => {
  const { graph: out, tally } = applyMeshView(rosterGraph, prefs({ isolated: profileNodeId("cli-a", "web-dev") }));
  const agent = out.frames[0].agents[0];
  assert.equal(agent.id, agentNodeId("cli-a")); // host daemon drawn (containment)
  assert.deepEqual(agent.profiles.map((p) => p.id), [profileNodeId("cli-a", "web-dev")]); // sibling card away
  assert.deepEqual(out.flows.map((f) => f.id), ["flow:tok-p1"]); // the daemon-held pipe is not this hop
  assert.deepEqual(out.frames[0].engines.map((e) => e.id), [engineNodeId("eng1")]); // far end drawn
  assert.equal(tally.agents, 1); // pr-agent counted away
  assert.equal(tally.flows, 1);
  assert.equal(tally.engines, 0);
});

test("ISOLATE a machine keeps the profile cards inside it and the pipes between its own cards", () => {
  const { graph: out, tally } = applyMeshView(rosterGraph, prefs({ isolated: frameId(LOCAL_MACHINE) }));
  assert.deepEqual(out.frames[0].agents[0].profiles.map((p) => p.name), ["web-dev", "pr-agent"]);
  assert.deepEqual(out.flows.map((f) => f.id).sort(), ["flow:tok-d1", "flow:tok-p1"]);
  assert.equal(tally.agents, 0);
  assert.equal(tally.flows, 0);
});

// The fleet-side Projects stack (owner ask 2026-10-21) belongs to NO machine:
// no lens hides it and the tally never counts it — machine hides, the agents
// layer and even an isolate all leave it exactly as the join drew it.
test("the Projects stack rides EVERY lens untouched — it belongs to no machine", () => {
  const g = buildMeshGraph(
    st({
      clients: [client("c", "127.0.0.1")],
      projects: [
        {
          name: "p1",
          paused: false,
          daily_token_cap: 0,
          budget_today: { tokens_out: 0, tokens_in: 0, cap: 0 },
          workers: [],
          today: { finished: 0, failed: 0 },
          scheduling: {},
        },
      ] as never,
    }),
    NOW,
  );
  assert.deepEqual(g.projects.map((p) => p.id), ["prj:p1"]);
  for (const p of [
    defaultMeshPrefs(),
    prefs({ isolated: frameId(LOCAL_MACHINE) }),
    prefs({ hidden: [frameId(LOCAL_MACHINE)] }),
    prefs({ layers: { ...defaultMeshPrefs().layers, agents: false } }),
  ]) {
    const lens = applyMeshView(g, p);
    assert.deepEqual(lens.graph.projects.map((x) => x.id), ["prj:p1"]);
    assert.equal(lens.graph.projects[0].id, "prj:p1");
  }
});

// --- the DRAIN chains under the lens (owner ask 2026-10-21): the lens drops
// chains and COUNTS them (tally.drains), never silently; a chain needs its
// gateway AND (when the lease names one) its engine drawn; the CARD's listed
// rows are the slot's own truth and ride the pipe lens untouched (the
// profile-card posture); isolates follow chains as hops — and the mch hop
// discipline keeps fleet-side chains OUT of a machine's interior. ----------

const leaseRow = (id: string, project: string, clientId: string | undefined, serverId: string | undefined) =>
  ({
    lease_id: id,
    client_id: clientId,
    client_name: clientId ?? "ghost",
    server_id: serverId,
    project,
    job_id: `job-${id}`,
    estimated_seconds: 60,
    status: "active",
    granted_at: NOW - 30_000,
    expires_at: NOW + 60_000,
    tokens_out: 10,
    tokens_in: 20,
  }) as never;

const projLite = (name: string, paused = false) =>
  ({
    name,
    paused,
    daily_token_cap: 0,
    budget_today: { tokens_out: 0, tokens_in: 0, cap: 0 },
    workers: [],
    today: { finished: 0, failed: 0 },
    scheduling: {},
  }) as never;

const drainView = buildMeshGraph(
  st({
    servers: [srv("eng1", "http://127.0.0.1:1"), srv("eng2", "http://127.0.0.1:2")],
    clients: [client("c", "127.0.0.1")],
    projects: [projLite("p1"), projLite("p2", true)] as never,
    active_leases: [leaseRow("D1", "p1", "c", "eng1"), leaseRow("D2", "p1", "c", undefined), leaseRow("D3", "p2", "c", "eng2")] as never,
  }),
  NOW,
);

test("drains layer off drops every chain and COUNTS them; the card rows ride untouched", () => {
  assert.deepEqual(drainView.drains.map((d) => d.id), ["drain:D1", "drain:D2"]); // paused p2 lists, never pipes
  const { graph: out, tally } = applyMeshView(drainView, prefs({ layers: { drains: false } }));
  assert.deepEqual(out.drains, []);
  assert.equal(tally.drains, 2);
  // the honesty posture: the lens hid PIPES; the card still lists its jobs
  assert.deepEqual(out.projects.find((p) => p.name === "p1")!.running.map((r) => r.drainId), ["drain:D1", "drain:D2"]);
});

test("a chain needs its gateway AND its named engine drawn; each drop is counted", () => {
  const hidGateway = applyMeshView(drainView, prefs({ hidden: [agentNodeId("c")] }));
  assert.deepEqual(hidGateway.graph.drains, []);
  assert.equal(hidGateway.tally.drains, 2);
  // the engine-side drop takes ONLY the chain that names that engine
  const hidEngine = applyMeshView(drainView, prefs({ hidden: [engineNodeId("eng1")] }));
  assert.deepEqual(hidEngine.graph.drains.map((d) => d.id), ["drain:D2"]); // engine-not-named stops at the gateway
  assert.equal(hidEngine.tally.drains, 1);
  // a per-chain hide drops exactly one pipe (the flow:<token> posture)
  const hidOne = applyMeshView(drainView, prefs({ hidden: ["drain:D1"] }));
  assert.deepEqual(hidOne.graph.drains.map((d) => d.id), ["drain:D2"]);
  assert.equal(hidOne.tally.drains, 1);
});

test("ISOLATE a chain keeps exactly the job's gateway, engine and their machine", () => {
  const { graph: out, tally } = applyMeshView(drainView, prefs({ isolated: "drain:D1" }));
  assert.deepEqual(out.drains.map((d) => d.id), ["drain:D1"]);
  assert.deepEqual(out.frames[0].engines.map((e) => e.id), [engineNodeId("eng1")]); // eng2 is not this hop
  assert.equal(tally.drains, 1);
  assert.equal(tally.engines, 1);
});

test("ISOLATE a gateway keeps its flow pipes AND its running-job chains", () => {
  const { graph: out, tally } = applyMeshView(drainView, prefs({ isolated: agentNodeId("c") }));
  assert.deepEqual(out.drains.map((d) => d.id), ["drain:D1", "drain:D2"]);
  // only eng1 is at a far end of a DRAWN chain (eng2's only lease is parked)
  assert.deepEqual(out.frames[0].engines.map((e) => e.id), [engineNodeId("eng1")]);
  assert.equal(tally.drains, 0);
  assert.equal(tally.engines, 1);
});

test("ISOLATE a project keeps its chains; a paused project's chains (none) degrade honestly to full view", () => {
  const { graph: out } = applyMeshView(drainView, prefs({ isolated: projectNodeId("p1") }));
  assert.deepEqual(out.drains.map((d) => d.id), ["drain:D1", "drain:D2"]);
  const lost = applyMeshView(drainView, prefs({ isolated: projectNodeId("p2") })); // paused: it draws no chains
  assert.equal(lost.isolatedLost, true);
  assert.deepEqual(lost.graph.drains.map((d) => d.id), ["drain:D1", "drain:D2"]); // full view back
});

test("a machine's isolate keeps the pipes BETWEEN its own cards — fleet-side chains stay out", () => {
  const { graph: out, tally } = applyMeshView(drainView, prefs({ isolated: frameId(LOCAL_MACHINE) }));
  assert.deepEqual(out.drains, []); // the chains start at the Projects box, not inside the machine
  assert.equal(tally.drains, 2);
});
