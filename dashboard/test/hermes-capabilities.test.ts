import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  HERMES_CAPABILITIES_LABEL,
  groupCapabilitiesByProfile,
  hasCapabilities,
} from "../src/lib/hermes-capabilities";
import type { HermesSkillRow, HermesToolsetRow } from "../src/lib/api";

// ---------------------------------------------------------------------------
// hermes-capabilities.test.ts — #85 slice B: the pure side of the Agents
// tab's per-profile capability rows. The label constant is THE copy (the
// "Hermes jobs" naming precedent: this is HERMES' capability inventory), and
// the Agents view must render it and keep the chip strip READ-ONLY (a source
// pin: the CapabilityChips region carries no Button/onClick — there is no
// enable/disable affordance in this plane).
// ---------------------------------------------------------------------------

test("the capability label is exactly 'Hermes capabilities' and the Agents chip strip is read-only", () => {
  assert.equal(HERMES_CAPABILITIES_LABEL, "Hermes capabilities");
  const here = dirname(fileURLToPath(import.meta.url));
  const agents = readFileSync(join(here, "..", "src", "views", "Agents.tsx"), "utf-8");
  assert.match(agents, /HERMES_CAPABILITIES_LABEL/, "the roster card renders the naming constant (one source for the copy)");
  const chips = agents.slice(
    agents.indexOf("function CapabilityChips"),
    agents.indexOf("function SessionSubRow"),
  );
  assert.ok(chips.length > 0, "the chip renderer exists");
  assert.ok(!/Button|onClick|onClick=/.test(chips), "the capability chips are read-only — no enable/disable affordance exists");
});

test("groupCapabilitiesByProfile: buckets by stamped profile; unstamped rows attribute to 'default'; absent/empty contribute nothing", () => {
  const skills: HermesSkillRow[] = [
    { profile: "default", name: "orchestration", category: "agents" },
    { name: "legacy-unstamped", description: "pre-stamp row" },
    { profile: "web-dev", name: "shadcn" },
  ];
  const toolsets: HermesToolsetRow[] = [
    { profile: "default", name: "web", enabled: true, configured: true },
    { profile: "default", name: "video_gen", enabled: false, configured: true },
    { profile: "web-dev", name: "terminal", enabled: true, configured: false },
  ];
  const caps = groupCapabilitiesByProfile(skills, toolsets);
  assert.deepEqual([...caps.keys()].sort(), ["default", "web-dev"]);
  assert.equal(caps.get("default")!.skills.length, 2, "the unstamped row lands on 'default' (the gateway's home store), never a name-guess");
  assert.equal(caps.get("default")!.toolsets.length, 2);
  assert.equal(caps.get("web-dev")!.skills.length, 1);
  assert.equal(caps.get("web-dev")!.toolsets.length, 1);
  assert.equal(caps.get("web-dev")!.toolsets[0]!.configured, false, "the gateway's configured verdict rides through untouched");
});

test("groupCapabilitiesByProfile: absent/empty blocks leave the map empty; hasCapabilities gates the exception-only chrome", () => {
  assert.equal(groupCapabilitiesByProfile(undefined, undefined).size, 0);
  assert.equal(groupCapabilitiesByProfile([], []).size, 0);
  assert.equal(hasCapabilities(new Map()), false);
  assert.equal(hasCapabilities(undefined), false);
  const withOne = groupCapabilitiesByProfile(undefined, [{ profile: "default", name: "web", enabled: true }]);
  assert.equal(hasCapabilities(withOne), true, "one toolset row is enough to show the strip (but a profile with NOTHING renders nothing)");
  const emptySlots = new Map([["p", { profile: "p", skills: [], toolsets: [] }]]);
  assert.equal(hasCapabilities(emptySlots), false, "empty slots never show the hint");
});
