import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  HERMES_MODEL_ACCESS_LABEL,
  MAX_GAP_CHIPS,
  currentProviderOf,
  groupModelsByProfile,
  groupProvidersByProfile,
  hasModelAccess,
  idlefillWiredNames,
  servedModelGaps,
} from "../src/lib/hermes-model-access";
import type { HermesModelProviderRow, HermesModelRow, StateSnapshot } from "../src/lib/api";

// ---------------------------------------------------------------------------
// hermes-model-access.test.ts — #85 slice C: the pure side of the Models
// tab's read-only cross-check. The label constant is THE copy (the "Hermes
// jobs"/"Hermes capabilities" naming precedent: this is HERMES' model
// access, not idlefill's own catalog), and the Models view must render it and
// keep the strip READ-ONLY (a source pin: the HermesModelAccess region carries
// no Button/onClick — there is no model set/switch affordance in this plane).
// ---------------------------------------------------------------------------

test("the label is exactly 'Hermes model access' and the Models chip strip is read-only", () => {
  assert.equal(HERMES_MODEL_ACCESS_LABEL, "Hermes model access");
  const here = dirname(fileURLToPath(import.meta.url));
  const models = readFileSync(join(here, "..", "src", "views", "Models.tsx"), "utf-8");
  assert.match(models, /HERMES_MODEL_ACCESS_LABEL/, "the section renders the naming constant (one source for the copy)");
  const region = models.slice(
    models.indexOf("function HermesModelAccess"),
    models.indexOf("function ClientModelCard"),
  );
  assert.ok(region.length > 0, "the section renderer exists");
  assert.ok(!/Button|onClick|onClick=/.test(region), "the model-access chips are read-only — no switch/set-model affordance exists");
});

test("grouping: by stamped profile; an unstamped row lands on 'default'; absent/empty ⇒ empty maps", () => {
  const served: HermesModelRow[] = [
    { profile: "default", id: "hermes-agent" },
    { id: "legacy-unstamped" },
    { profile: "web-dev", id: "hermes-agent-ft", root: "hermes-agent" },
  ];
  const providers: HermesModelProviderRow[] = [
    { profile: "default", slug: "openrouter", current: true },
    { profile: "web-dev", slug: "openai", current: true },
  ];
  const s = groupModelsByProfile(served);
  const p = groupProvidersByProfile(providers);
  assert.deepEqual([...s.keys()].sort(), ["default", "web-dev"]);
  assert.equal(s.get("default")!.length, 2, "the unstamped row lands on 'default' (the home store), never a name-guess");
  assert.equal(p.get("web-dev")![0]!.current, true);
  assert.equal(groupModelsByProfile(undefined).size, 0);
  assert.equal(groupProvidersByProfile([]).size, 0);
});

test("hasModelAccess: the exception-only gate — one block is enough, empty/absent renders nothing", () => {
  assert.equal(hasModelAccess({}), false);
  assert.equal(hasModelAccess({ hermes_models: [], hermes_model_options: [] }), false, "an empty block never shows the strip");
  assert.equal(hasModelAccess({ hermes_models: [{ id: "hermes-agent" }] }), true);
  assert.equal(hasModelAccess({ hermes_model_options: [{ slug: "openrouter" }] }), true);
});

test("idlefillWiredNames: alias names ∪ engine inventory names (the vocabulary the router answers to)", () => {
  const st = {
    model_aliases: [{ name: "big" }, { name: "fast" }],
    servers: [
      { id: "s1", models: [{ name: "qwen3-32b-q4", running: false, queued: 0 }, { name: "GLM-4.7-AWQ", running: false, queued: 0 }] },
      { id: "s2", models: [] },
    ],
  } as unknown as StateSnapshot;
  const names = idlefillWiredNames(st);
  assert.ok(names.has("big") && names.has("fast"), "alias names are wired names");
  assert.ok(names.has("qwen3-32b-q4") && names.has("glm-4.7-awq"), "engine inventory ids are wired names, compared case-insensitively");
  assert.equal(idlefillWiredNames(null).size, 0);
});

test("servedModelGaps: EXACT membership only (the #66 D5 posture) — a served id no alias/engine names is the gap; deduped + capped", () => {
  const wired = new Set(["hermes-agent", "big"]);
  const served: HermesModelRow[] = [
    { id: "hermes-agent" }, // wired (exact)
    { id: "HERMES-AGENT" }, // wired case-insensitively, and deduped
    { id: "hermes-agent-lite" }, // NOT wired — a real gap (no fuzzy match rescues it)
    { id: "biggish" }, // NOT wired ('big' being a prefix is NOT a match)
  ];
  assert.deepEqual(servedModelGaps(served, wired), ["hermes-agent-lite", "biggish"]);
  assert.deepEqual(servedModelGaps(undefined, wired), []);
  const flood = servedModelGaps(
    Array.from({ length: 40 }, (_, i) => ({ id: `m${i}` })),
    new Set<string>(),
  );
  assert.equal(flood.length, MAX_GAP_CHIPS, "a pathological list stays a capped hint, never a wall");
});

test("currentProviderOf: the single exact-current row wins; zero or several currents ⇒ undefined (never a guess)", () => {
  const one = currentProviderOf([
    { slug: "openrouter", current: true },
    { slug: "anthropic", authenticated: true },
  ]);
  assert.equal(one?.slug, "openrouter");
  assert.equal(currentProviderOf([{ slug: "a" }, { slug: "b" }]), undefined, "no exact current ⇒ no claim");
  assert.equal(currentProviderOf([{ slug: "a", current: true }, { slug: "b", current: true }]), undefined, "several currents ⇒ no guess");
  assert.equal(currentProviderOf(undefined), undefined);
});
