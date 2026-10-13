// hash-nav.test.ts — the pure deep-link grammar behind the navigable
// hierarchy (layout-only, zero wire change). The discipline under test:
// the hash is UNTRUSTED hand-editable input — parse never throws, a
// malformed focus segment DEGRADES to (tab, null) instead of rejecting the
// tab, decodeURIComponent rides a guard, and an over-long focus is dropped
// whole (null) — never truncated-and-kept, which would name nothing and
// risk a stale row. The focus keys ride ONE scheme (machine/<name>,
// server/<id>, minted here); bare "overview" stays a top-level view id
// (the precedence readView has always had), and every navigable pairing
// round-trips through encodeTabFocus → parseHash.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FOCUS_MAX,
  MACHINE_PREFIX,
  SERVER_PREFIX,
  encodeTabFocus,
  machineKey,
  parseHash,
  serverKey,
} from "../src/lib/hash-nav.js";

test("encodeTabFocus: bare sub-tab id without a focus; focus percent-encoded (the scheme's slash rides as %2F)", () => {
  assert.equal(encodeTabFocus("machines"), "machines");
  assert.equal(encodeTabFocus("machines", undefined), "machines");
  assert.equal(encodeTabFocus("servers", serverKey("srv-a")), "servers/focus/server%2Fsrv-a");
  assert.equal(encodeTabFocus("machines", machineKey("This Machine")), "machines/focus/machine%2FThis%20Machine");
});

test("machineKey/serverKey: ONE key scheme — machine/<name> and server/<id>, prefixes exported", () => {
  assert.equal(machineKey("urza"), "machine/urza");
  assert.equal(serverKey("srv-a"), "server/srv-a");
  assert.ok(machineKey("urza").startsWith(MACHINE_PREFIX));
  assert.ok(serverKey("srv-a").startsWith(SERVER_PREFIX));
});

test("parseHash: '', '#', and every bare view id yield (null, null) — including 'overview', the top level wins", () => {
  for (const raw of ["", "#", "overview", "resources", "sessions", "usage", "settings"]) {
    assert.deepEqual(parseHash(raw), { tab: null, focus: null }, raw);
  }
});

test("parseHash: every bare sub-tab id except the reserved 'overview' names a Resources tab (with or without '#')", () => {
  for (const id of ["servers", "machines", "projects", "models", "agents"]) {
    assert.deepEqual(parseHash(id), { tab: id, focus: null }, id);
    assert.deepEqual(parseHash(`#${id}`), { tab: id, focus: null }, `#${id}`);
  }
});

test("round trip: encodeTabFocus → parseHash lands on the same tab + focus key (the urza example)", () => {
  const pairs = [
    ["machines", machineKey("urza")],
    ["machines", machineKey("This Machine")],
    ["servers", serverKey("srv-a")],
  ] as const;
  for (const [tab, key] of pairs) {
    assert.deepEqual(parseHash(encodeTabFocus(tab, key)), { tab, focus: key }, `${tab} focus ${key}`);
  }
});

test("a hand-typed UNencoded slash inside the focus re-joins whole (deep links typed by hand stay honest)", () => {
  assert.deepEqual(parseHash("machines/focus/machine/urza"), { tab: "machines", focus: "machine/urza" });
  assert.deepEqual(parseHash("#servers/focus/server/srv-a"), { tab: "servers", focus: "server/srv-a" });
});

test("malformed segments degrade to (tab, null), never throw and never reject the tab", () => {
  assert.deepEqual(parseHash("machines/focus/%E0%A4%A"), { tab: "machines", focus: null }, "broken escape sequence");
  assert.deepEqual(parseHash("machines/focus/%zz"), { tab: "machines", focus: null }, "not even hex");
  assert.deepEqual(parseHash("machines/focus/"), { tab: "machines", focus: null }, "empty focus");
  assert.deepEqual(parseHash("machines//focus/x"), { tab: "machines", focus: null }, "junk before the 'focus' word");
  assert.deepEqual(parseHash("machines/junk/x"), { tab: "machines", focus: null }, "a non-focus tail: the tab stands");
  assert.deepEqual(parseHash("bogus"), { tab: null, focus: null }, "an unknown bare head claims nothing");
  assert.deepEqual(parseHash("bogus/focus/x"), { tab: null, focus: null }, "an unknown head with a focus claims nothing");
  assert.deepEqual(parseHash("overview/focus/x"), { tab: "overview", focus: "x" }, "'overview' with a focus segment IS the sub-tab — the bare token alone is the view");
});

test("focus cap: ≤FOCUS_MAX chars stand, longer is dropped whole, an unbounded flood is guarded before decoding", () => {
  const ok = "m".repeat(FOCUS_MAX);
  assert.equal(parseHash(`machines/focus/${encodeURIComponent(ok)}`).focus, ok, "exactly the cap stands (encoded form)");
  assert.equal(parseHash(`machines/focus/${ok}`).focus, ok, "exactly the cap stands (bare form)");
  assert.equal(parseHash(`machines/focus/${"m".repeat(FOCUS_MAX + 1)}`).focus, null, "over-long: dropped, never truncated-and-kept");
  assert.equal(parseHash(`machines/focus/${encodeURIComponent("é".repeat(FOCUS_MAX + 1))}`).focus, null, "over-long after decoding");
  const flood = parseHash(`machines/focus/${"%".repeat(5000)}`); // never reaches decodeURIComponent
  assert.deepEqual(flood, { tab: "machines", focus: null }, "a 5k-char garbage focus: the tab stands, the focus is null");
});
