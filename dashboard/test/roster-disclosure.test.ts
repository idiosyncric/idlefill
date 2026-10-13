// roster-disclosure.test.ts — the pure decision behind the roster's session
// disclosure (2026-10-13, interaction only): profiles WITH sessions are open
// by default (from first observation on, no toggle to wait for); the user's
// toggle is the only stickiness — collapsed stays collapsed across
// session-count changes, expanded stays open even once the children vanish
// (the honest empty line's slot); a childless profile nobody toggled is
// never open. The toggle is a copy, never an in-place mutation.

import { test } from "node:test";
import assert from "node:assert/strict";
import { disclosureOpen, toggleDisclosure } from "../src/lib/roster-disclosure.js";

test("default: open while the profile owns sessions, closed while childless", () => {
  assert.equal(disclosureOpen(new Map(), "coder", true), true, "children are visible from first sight on");
  assert.equal(disclosureOpen(new Map(), "writer", false), false, "a never-toggled childless profile is not a disclosure");
});

test("collapsed stays collapsed even when the session count changes", () => {
  const folded = toggleDisclosure(new Map(), "coder", true);
  assert.equal(folded.get("coder"), false);
  assert.equal(disclosureOpen(folded, "coder", false), false, "count drop never re-opens");
  assert.equal(disclosureOpen(folded, "coder", true), false, "count rise never re-opens");
});

test("expanded stays open with no children — the honest empty line's slot", () => {
  const folded = toggleDisclosure(new Map(), "coder", true);
  const reopened = toggleDisclosure(folded, "coder", true);
  assert.equal(disclosureOpen(reopened, "coder", false), true, "childless-but-expanded keeps its slot open");
});

test("untouched default follows the live count: sessions arrive -> open, vanish -> plain row", () => {
  assert.equal(disclosureOpen(new Map(), "coder", true), true, "sessions arrive: the default opens");
  assert.equal(disclosureOpen(new Map(), "coder", false), false, "untouched profile whose sessions vanished is a plain row again");
});

test("toggleDisclosure copies: the old map untouched, other keys kept", () => {
  const base = new Map<string, boolean>([["a", true], ["b", false]]);
  const next = toggleDisclosure(base, "a", true);
  assert.equal(base.get("a"), true, "no in-place mutation");
  assert.equal(next.get("a"), false);
  assert.equal(next.get("b"), false);
});
