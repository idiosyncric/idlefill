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

const sess = (token: string, clientId: string | undefined, serverId: string | undefined) =>
  ({
    token,
    client_id: clientId,
    server_id: serverId,
    registered_at: NOW - 60_000,
    last_seen: NOW - 5_000,
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
  sessions: [sess("tok-aaaaaa", "cli-mac", "srv-remote"), sess("tok-bbbbbb", "cli-urza", "srv-omlx")],
});

const graph = buildMeshGraph(base, NOW);

const prefs = (patch: Partial<MeshViewPrefs> & { layers?: Partial<MeshViewPrefs["layers"]> } = {}): MeshViewPrefs => ({
  layers: { ...defaultMeshPrefs().layers, ...(patch.layers ?? {}) },
  hidden: patch.hidden ?? [],
});

test("the default lens is the identity — same reference, nothing counted", () => {
  const { graph: out, tally } = applyMeshView(graph, defaultMeshPrefs());
  assert.equal(out, graph);
  assert.deepEqual(tally, { machines: 0, agents: 0, engines: 0, flows: 0, controls: 0 });
});

test("agents layer off: agent cards and every flow pipe drop, engines and controls stay", () => {
  const { graph: out, tally } = applyMeshView(graph, prefs({ layers: { agents: false } }));
  for (const f of out.frames) assert.deepEqual(f.agents, []);
  assert.deepEqual(out.flows, []);
  assert.equal(tally.agents, 2);
  assert.equal(tally.flows, 2);
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
  // the cross-machine flow into srv-omlx drops, the one into srv-remote stands
  assert.deepEqual(out.flows.map((f) => f.id), ["flow:tok-aaaaaa"]);
  assert.equal(tally.engines, 1);
  assert.equal(tally.flows, 1);
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
  assert.equal(tally.flows, 2); // both pipes touched the hidden subtree
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

test("prefs sanitize: junk yields the default, partial layers merge, hidden dedupes", () => {
  assert.deepEqual(sanitizeMeshPrefs(undefined), defaultMeshPrefs());
  assert.deepEqual(sanitizeMeshPrefs("nope"), defaultMeshPrefs());
  const merged = sanitizeMeshPrefs({ layers: { agents: false, bogus: 1 }, hidden: ["eng:a", "eng:a", 7, "mch:b"] });
  assert.equal(merged.layers.agents, false);
  assert.equal(merged.layers.engines, true); // untouched keys keep the default
  assert.deepEqual(merged.hidden, ["eng:a", "mch:b"]);
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
