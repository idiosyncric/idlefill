// ---------------------------------------------------------------------------
// hash-nav.ts — the PURE grammar behind the navigable Resources hierarchy.
// The hash holds one of four forms (lowercase chrome, no state elsewhere):
//   ""                       → nothing claimed; the stored tabs decide (App)
//   "<view-id>"              → a top-level view (tab null — bare "overview"
//                              resolves here: the top level wins, the exact
//                              precedence readView has always had)
//   "<res-subtab>"           → a Resources sub-tab, no focus
//   "<res-subtab>/focus/<k>" → that sub-tab AND one focus key, where the key
//      rides ONE scheme: machineKey = "machine/<name>" for a Machines row,
//      serverKey = "server/<id>" for one server card. Mint/parse HERE only —
//      a view never invents its own spelling.
// UNTRUSTED-input law: the hash is hand-editable, so parse NEVER throws,
// decodeURIComponent rides a try/catch, the decoded focus is CAPPED (an
// over-long key is dropped whole — never truncated-and-kept, it would name
// nothing and flash a stale row), and a malformed focus segment DEGRADES to
// (tab, null): the tab is navigable even when the focus is garbage.
// Layout-only: zero wire keys, zero server change.
// ---------------------------------------------------------------------------

import { NAV_IDS, RES_SUBTABS, type ResTab } from "../nav";

/** Decoded focus keys longer than this are dropped (null), never truncated. */
export const FOCUS_MAX = 120;

/** The one key scheme, spelled once: a Machines row (name = LOCAL_MACHINE or
 *  a peer name — the same label the hierarchy joins use). */
export const MACHINE_PREFIX = "machine/";
/** The one key scheme, spelled once: one declared server row's card. */
export const SERVER_PREFIX = "server/";

export const machineKey = (name: string): string => `${MACHINE_PREFIX}${name}`;
export const serverKey = (id: string): string => `${SERVER_PREFIX}${id}`;

/** tab + optional focus → the hash payload (no leading '#'). */
export function encodeTabFocus(tab: ResTab, focus?: string): string {
  return focus ? `${tab}/focus/${encodeURIComponent(focus)}` : tab;
}

function subTabOf(head: string): ResTab | null {
  return RES_SUBTABS.find((t) => t.id === head)?.id ?? null;
}

/** Parse one raw hash (a leading '#' is tolerated — location.hash arrives
 *  with one). Total and honest: every input yields a verdict, never a throw. */
export function parseHash(raw: string): { tab: ResTab | null; focus: string | null } {
  const h = raw.startsWith("#") ? raw.slice(1) : raw;
  if (!h) return { tab: null, focus: null };
  const [head, ...rest] = h.split("/");
  if (rest.length === 0) {
    // bare token: a top-level view id claims it FIRST (so "overview" stays
    // the top-level view, never the Resources sub-tab — readView precedence),
    // otherwise it may name a Resources sub-tab.
    if ((NAV_IDS as readonly string[]).includes(head)) return { tab: null, focus: null };
    return { tab: subTabOf(head), focus: null };
  }
  const tab = subTabOf(head);
  if (tab === null) return { tab: null, focus: null }; // unknown head: nothing to claim
  if (rest[0] !== "focus") return { tab, focus: null }; // junk segment: the tab stands, the junk does not
  const enc = rest.slice(1).join("/"); // re-join: a hand-typed UNencoded slash inside the key survives whole
  // pre-decode length guard: never hand an unbounded string to the decoder
  if (enc.length === 0 || enc.length > FOCUS_MAX * 12) return { tab, focus: null };
  let focus: string | null = null;
  try {
    const dec = decodeURIComponent(enc);
    // empty or over-cap after decoding: null — the tab opens without a focus
    if (dec.length > 0 && dec.length <= FOCUS_MAX) focus = dec;
  } catch {
    focus = null; // malformed escape sequence: the tab stands, the focus is dropped
  }
  return { tab, focus };
}
