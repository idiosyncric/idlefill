// hierarchy.test.ts — the resources hierarchy joins (owner ask 2026-10-12:
// "urza hosts BOTH strata-urza and llama-swap-urza — show both on urza's
// card"; "sessions are sub-items of the agents they belong to"). The
// discipline under test: every join is EXACT (url hostname to the
// character, group id/label to the character, provenance profile to the
// character); nothing fuzzy ever hosts or nests; an unnamed host renders
// nowhere in the Machines buckets (never guessed onto a card); with no
// peers declared every row rides This Machine (the single-arbiter truth).
// The row-summary pass (2026-10-13) adds the per-machine summary joins
// (machineClients / machineSummary): published counts only, the population
// complete for that machine — a 0 there is the honest truth (unlike the
// tiles), a client that names no host contributes to NO machine, and a
// client that publishes no roster contributes 0 agents, never a guess.
// The Servers-tab band projection (2026-10-13, fleet-hierarchy D3) adds
// serverBands: a pure partition of the declared rows (This Machine first,
// peers by name, unhosted LAST) — never-hide: every row lands in exactly
// one band; a single band is what the view uses to render its flat grid.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LOCAL_MACHINE,
  hostnameOf,
  isLoopbackHost,
  hostOfServer,
  hostOfClient,
  hostedServers,
  localClientIds,
  machineClients,
  machineSummary,
  serverBands,
  sessionsByProfile,
} from "../src/lib/hierarchy.js";
import type { StateSnapshot } from "../src/lib/api.js";

const st = (patch: Partial<StateSnapshot>): StateSnapshot =>
  ({ now: 0, servers: [], clients: [], sessions: [], ...(patch as object) }) as StateSnapshot;

const srv = (id: string, url: string, group?: string) =>
  ({ id, name: id, url, auth_set: false, watched: true, signal: null, model_source: "probed", probed_at: null, models: [], ...(group ? { group_id: group } : {}) });

// The live urza shape: strata-samwarth rides group "urza", llama-swap-urza
// shares urza's url host, oMLX is loopback, scanbot shares scanbot's host.
const urzaMesh = st({
  mesh: {
    instance_id: "i-mac",
    peers: [
      { url: "http://100.105.225.1:8787", name: "urza", instance_id: "i-urza", online: true, fetch_age_s: 3, snapshot: null },
      { url: "http://10.10.10.6:8787", name: "scanbot", instance_id: "i-scan", online: true, fetch_age_s: 3, snapshot: null },
    ],
  },
  engine_groups: [{ group_id: "urza", name: "urza", server_ids: ["srv-a", "srv-b"], max_concurrent: 1, updated_at: 0 }],
  servers: [
    srv("srv-omlx", "http://127.0.0.1:8000"),
    srv("srv-a", "https://strata.samwarth.com", "urza"),
    srv("srv-b", "http://100.105.225.1:11434", "urza"),
    srv("srv-c", "http://10.10.10.6:8080"),
  ],
});

test("hostnameOf/isLoopbackHost: parse-safe, port-less, loopback family", () => {
  assert.equal(hostnameOf("http://100.105.225.1:11434"), "100.105.225.1");
  assert.equal(hostnameOf("https://Strata.Samwarth.com/v1"), "strata.samwarth.com");
  assert.equal(hostnameOf("http://[::1]:8000"), "::1");
  assert.equal(hostnameOf("not a url"), "");
  assert.equal(hostnameOf(undefined), "");
  assert.ok(isLoopbackHost("localhost") && isLoopbackHost("::1") && isLoopbackHost("127.0.0.1"));
  assert.ok(!isLoopbackHost("100.105.225.1") && !isLoopbackHost("localhost.evil.example"));
});

test("urza's card hosts BOTH engines — the group-label row and the url-host row (the owner example)", () => {
  const { byMachine, unhosted } = hostedServers(urzaMesh);
  assert.deepEqual((byMachine.get("urza") ?? []).map((s) => s.id).sort(), ["srv-a", "srv-b"]);
  assert.equal(hostOfServer(urzaMesh, urzaMesh.servers![1])?.via, "group-label", "strata-urza: group label EXACTLY = machine name");
  assert.equal(hostOfServer(urzaMesh, urzaMesh.servers![2])?.via, "url-host", "llama-swap-urza: url host = peer host");
  assert.deepEqual((byMachine.get(LOCAL_MACHINE) ?? []).map((s) => s.id), ["srv-omlx"], "loopback rides This Machine");
  assert.deepEqual((byMachine.get("scanbot") ?? []).map((s) => s.id), ["srv-c"]);
  assert.deepEqual(unhosted, []);
});

test("no fuzzy hosts: a subdomain/substring never joins; an unnamed host stays UNHOSTED", () => {
  const s = st({
    mesh: { instance_id: "i", peers: [{ url: "http://100.105.225.1:8787", name: "urza", instance_id: "u", online: true, fetch_age_s: 1, snapshot: null }] },
    servers: [srv("near", "http://100.105.225.10:11434"), srv("named", "http://engine.urza.internal:9")],
  });
  const { byMachine, unhosted } = hostedServers(s);
  assert.equal(byMachine.size, 0, "100.105.225.10 ≠ 100.105.225.1 to the character; no name rule fires");
  assert.deepEqual(unhosted.map((x) => x.id), ["near", "named"], "unhosted rows are named, never guessed onto a card");
});

test("group label matches only EXACTLY (a renamed group hosting nothing)", () => {
  const s = st({
    mesh: { instance_id: "i", peers: [{ url: "http://10.0.0.5:8787", name: "urza", instance_id: "u", online: true, fetch_age_s: 1, snapshot: null }] },
    engine_groups: [{ group_id: "g1", name: "urza-ish", server_ids: ["x"], max_concurrent: 1, updated_at: 0 }],
    servers: [srv("x", "http://10.0.0.9:8080", "g1")],
  });
  assert.equal(hostOfServer(s, s.servers![0]), null, "'urza-ish' is not 'urza' — no verdict, no host");
});

test("no peers declared: every row rides This Machine (the single-arbiter truth, no rows vanish)", () => {
  const s = st({ servers: [srv("a", "http://127.0.0.1:8000"), srv("b", "http://192.168.1.9:11434")] });
  const { byMachine, unhosted } = hostedServers(s);
  assert.deepEqual((byMachine.get(LOCAL_MACHINE) ?? []).map((x) => x.id), ["a", "b"]);
  assert.equal(hostOfServer(s, s.servers![1])?.via, "local-only");
  assert.deepEqual(unhosted, []);
});

test("hostOfClient: loopback ip, exact peer ip, and an unnamed client (null, never a guess)", () => {
  const s = st({
    mesh: { instance_id: "i", peers: [{ url: "http://100.105.225.1:8787", name: "urza", instance_id: "u", online: true, fetch_age_s: 1, snapshot: null }] },
    clients: [
      { client_id: "c-local", name: "mac-sam", ip: "127.0.0.1", last_seen: 0 },
      { client_id: "c-urza", name: "urza-box", ip: "100.105.225.1", last_seen: 0 },
      { client_id: "c-obs", name: "observed", ip: "10.0.0.9", observed_ip: "100.105.225.1", last_seen: 0 },
      { client_id: "c-none", name: "elsewhere", ip: "10.20.30.40", last_seen: 0 },
    ],
  });
  assert.equal(hostOfClient(s, s.clients![0])?.machine, LOCAL_MACHINE);
  assert.equal(hostOfClient(s, s.clients![1])?.machine, "urza");
  assert.equal(hostOfClient(s, s.clients![2])?.machine, "urza", "observed_ip counts — exact host either way");
  assert.equal(hostOfClient(s, s.clients![3]), null);
  assert.deepEqual(localClientIds(s), ["c-local"]);
});

test("sessionsByProfile: nests ONLY on the provenance profile + the machine's client (exact join, never fuzzy)", () => {
  const s = st({
    clients: [{ client_id: "c-local", name: "mac", ip: "127.0.0.1", last_seen: 0 }],
    sessions: [
      { token: "t1", client_id: "c-local", hermes_meta: { profile: "web-dev" } },
      { token: "t2", client_id: "c-local", hermes_meta: { profile: "web-dev-orca" } },
      { token: "t3", client_id: "c-local", hermes_meta: { title: "no profile stamp" } },
      { token: "t4", client_id: "c-remote", hermes_meta: { profile: "web-dev" } },
      { token: "t5", hermes_meta: { profile: "web-dev" } },
    ] as never,
  });
  const byProfile = sessionsByProfile(s, localClientIds(s));
  assert.deepEqual([...byProfile.keys()].sort(), ["web-dev", "web-dev-orca"], "exact profile names — web-dev never nests web-dev-orca");
  assert.deepEqual(byProfile.get("web-dev")?.map((x) => x.token), ["t1"], "the remote client's and the client-less rows never nest here");
  assert.ok(!byProfile.has("no profile stamp"));
});

// The row-summary shape: the same urza mesh + the client/session plane. Two
// daemons on urza (ONE publishes a roster, one never reports the key), a
// local daemon with a roster, and a daemon no machine names (its roster
// belongs to no summary). Sessions attribute by exact client_id.
const urzaCounted = st({
  mesh: urzaMesh.mesh,
  engine_groups: urzaMesh.engine_groups,
  servers: urzaMesh.servers,
  clients: [
    { client_id: "c-urza", name: "urza-box", ip: "100.105.225.1", last_seen: 0, agent_roster: [{ profile: "web-dev", posture: "adopted" }] },
    { client_id: "c-urza2", name: "no-roster", ip: "100.105.225.1", last_seen: 0 },
    { client_id: "c-local", name: "mac", ip: "127.0.0.1", last_seen: 0, agent_roster: [{ profile: "pr-agent", posture: "adopted" }] },
    { client_id: "c-none", name: "elsewhere", ip: "10.20.30.40", last_seen: 0, agent_roster: [{ profile: "ghost", posture: "unset" }] },
  ],
  sessions: [
    { token: "t1", client_id: "c-urza" },
    { token: "t2", client_id: "c-urza2" },
    { token: "t3", client_id: "c-local" },
    { token: "t4", client_id: "c-none" },
  ] as never,
});

test("machineClients: the exact hostOfClient join per machine — an unnamed client belongs to NO machine", () => {
  assert.deepEqual(machineClients(urzaCounted, "urza").map((c) => c.client_id), ["c-urza", "c-urza2"]);
  assert.deepEqual(machineClients(urzaCounted, LOCAL_MACHINE).map((c) => c.client_id), ["c-local"]);
  assert.deepEqual(machineClients(urzaCounted, "scanbot"), []);
  for (const m of ["urza", "scanbot", LOCAL_MACHINE]) {
    assert.ok(!machineClients(urzaCounted, m).some((c) => c.client_id === "c-none"), "10.20.30.40 names no machine — it never rides a summary");
  }
});

test("machineSummary on the urza shape: 2 hosted engines, the roster-less client contributes an honest 0 agents, sessions by exact client_id", () => {
  assert.deepEqual(machineSummary(urzaCounted, "urza"), { engines: 2, agents: 1, sessions: 2 });
  assert.equal(
    machineSummary(urzaCounted, "urza").agents,
    urzaCounted.clients!.filter((c) => c.client_id.startsWith("c-urza")).reduce((a, c) => a + (c.agent_roster?.length ?? 0), 0),
    "rosters are what clients report — no roster is 0, never a guess",
  );
});

test("machineSummary for the local machine: the loopback engine + the local client's roster + the local client's sessions", () => {
  assert.deepEqual(machineSummary(urzaCounted, LOCAL_MACHINE), { engines: 1, agents: 1, sessions: 1 });
});

test("machineSummary for machines without clients: hosted engines still counted, agents/sessions honest zeros; a machine with neither is all zeros", () => {
  assert.deepEqual(machineSummary(urzaCounted, "scanbot"), { engines: 1, agents: 0, sessions: 0 }, "srv-c rides scanbot's host; no client names it — two honest zeros, never hidden");
  const lonely = st({
    mesh: { instance_id: "i", peers: [{ url: "http://10.0.0.7:8787", name: "box2", instance_id: "b2", online: true, fetch_age_s: 1, snapshot: null }] },
    servers: [srv("srv-omlx", "http://127.0.0.1:8000")],
  });
  assert.deepEqual(machineSummary(lonely, "box2"), { engines: 0, agents: 0, sessions: 0 }, "nothing declared on box2 and no client on it — three honest zeros");
});

// The band projection (fleet-hierarchy D3): the Servers tab renders the
// declared rows BANNDED by machine — This Machine first, then peers by name,
// unhosted trailing. The partition law is the point: every row lands in
// exactly one band, and a single band (the flat case) is what tells the view
// to keep today's header-free grid.
test("serverBands on the urza fixture: [This Machine, scanbot, urza] — order fixed, urza carries BOTH srv-a and srv-b", () => {
  const bands = serverBands(urzaMesh);
  assert.deepEqual(bands.map((b) => b.machine), [LOCAL_MACHINE, "scanbot", "urza"], "local first, then peers by name (scanbot < urza)");
  assert.deepEqual(bands.map((b) => b.label), ["on this machine", "on scanbot", "on urza"]);
  assert.deepEqual(bands.map((b) => b.servers.map((s) => s.id)), [["srv-omlx"], ["srv-c"], ["srv-a", "srv-b"]], "the group-label row AND the url-host row ride urza");
});

test("serverBands with no peers: exactly ONE band (local, all rows) — the view's flat-render signal", () => {
  const s = st({ servers: [srv("a", "http://127.0.0.1:8000"), srv("b", "http://192.168.1.9:11434")] });
  const bands = serverBands(s);
  assert.equal(bands.length, 1, "one band = the single-machine case: the view keeps the flat grid, no header");
  assert.equal(bands[0].machine, LOCAL_MACHINE);
  assert.deepEqual(bands[0].servers.map((x) => x.id), ["a", "b"]);
});

test("serverBands: an unnamed-host row lands ONLY in the trailing unhosted band (machine null) — in no other band (never-hide partition)", () => {
  const s = st({
    mesh: { instance_id: "i", peers: [{ url: "http://100.105.225.1:8787", name: "urza", instance_id: "u", online: true, fetch_age_s: 1, snapshot: null }] },
    servers: [srv("home", "http://127.0.0.1:8000"), srv("hosted", "http://100.105.225.1:11434"), srv("near", "http://100.105.225.10:11434")],
  });
  const bands = serverBands(s);
  assert.deepEqual(bands.map((b) => b.machine), [LOCAL_MACHINE, "urza", null], "the unhosted band trails every machine band");
  const un = bands[2];
  assert.equal(un.label, "");
  assert.deepEqual(un.servers.map((x) => x.id), ["near"], "100.105.225.10 names no machine — it rides no host band, and it is never dropped");
  const seen = bands.flatMap((b) => b.servers.map((x) => x.id));
  assert.deepEqual(seen.slice().sort(), ["home", "hosted", "near"], "the bands PARTITION st.servers — each row in exactly one band");
});

test("serverBands on empty st.servers: []", () => {
  assert.deepEqual(serverBands(st({})), []);
  assert.deepEqual(serverBands(st({ servers: [] })), []);
});
