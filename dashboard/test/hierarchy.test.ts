// hierarchy.test.ts — the resources hierarchy joins (owner ask 2026-10-12:
// "urza hosts BOTH strata-urza and llama-swap-urza — show both on urza's
// card"; "sessions are sub-items of the agents they belong to"). The
// discipline under test: every join is EXACT (url hostname to the
// character, group id/label to the character, provenance profile to the
// character); nothing fuzzy ever hosts or nests; an unnamed host renders
// nowhere in the Machines buckets (never guessed onto a card); with no
// peers declared every row rides This Machine (the single-arbiter truth).

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
