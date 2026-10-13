// ---------------------------------------------------------------------------
// Hermes model access (#85 slice C) — pure display helpers for the Models
// tab's read-only cross-check. The rows arrive from the register heartbeat's
// `hermes_models` + `hermes_model_options` ADD-keys (the client's connector
// harvested `GET /v1/models` + `GET /api/model/options?include_unconfigured=
// false` at most once per connector round, sanitized client-side; the arbiter
// re-sanitized) and ride /api/state's client rows.
//
// The cross-check is HONEST and low-noise by construction: the only
// diff-style statement made is per SERVED model id — a model the gateway
// answers as that idlefill never wires (no alias names it, no engine
// inventory carries it) is named as a gap. The provider catalog (what the
// profile could SWITCH to) is rendered as counts/names, NEVER diffed name-
// by-name against GGUF inventory ids — different vocabularies, and a 100-
// name wall would be noise pretending to be signal.
//
// Read-only: NOTHING here (or in the view) addresses a model set/switch
// verb. Absent rows render nothing — never an empty list claiming truth.
// ---------------------------------------------------------------------------
import type { HermesModelRow, HermesModelProviderRow, ServerRow, StateSnapshot } from "./api";

/** The section label (pinned by test). */
export const HERMES_MODEL_ACCESS_LABEL = "Hermes model access";

/** Attribute rows to their STAMPED profile; an unstamped row belongs to the
 *  gateway's home store ⇒ 'default' (never a name-guess). */
export function groupModelsByProfile(rows: HermesModelRow[] | undefined): Map<string, HermesModelRow[]> {
  return group(rows);
}

export function groupProvidersByProfile(rows: HermesModelProviderRow[] | undefined): Map<string, HermesModelProviderRow[]> {
  return group(rows);
}

function group<T extends { profile?: string }>(rows: T[] | undefined): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of rows ?? []) {
    const p = r.profile ?? "default";
    const list = out.get(p);
    if (list) list.push(r);
    else out.set(p, [r]);
  }
  return out;
}

/** The names idlefill actually WIRES this tick: every published alias name
 *  + every engine inventory model name (probed or declared — the pair-list
 *  vocabulary the router answers to). Lower-cased for the comparison; the
 *  display keeps the original spelling. */
export function idlefillWiredNames(st: StateSnapshot | null): Set<string> {
  const out = new Set<string>();
  for (const a of st?.model_aliases ?? []) out.add(a.name.toLowerCase());
  const servers: ServerRow[] = st?.servers ?? [];
  for (const s of servers) for (const m of s.models ?? []) if (m.name) out.add(m.name.toLowerCase());
  return out;
}

/** A client row is worth a card only when it carried at least one slice-C
 *  block this tick (exception-only chrome). */
export function hasModelAccess(row: { hermes_models?: HermesModelRow[]; hermes_model_options?: HermesModelProviderRow[] }): boolean {
  return (row.hermes_models?.length ?? 0) > 0 || (row.hermes_model_options?.length ?? 0) > 0;
}

/** The served-model gap: ids the gateway ANSWERS AS that idlefill never
 *  wires. Exact (lower-cased) membership only — never a fuzzy match (the
 *  #66 D5 posture). Returns the original spellings, deduped, capped
 *  (MAX_GAP_CHIPS) so a pathological list stays a hint, not a wall. */
export const MAX_GAP_CHIPS = 12;

export function servedModelGaps(served: HermesModelRow[] | undefined, wired: Set<string>): string[] {
  const seen = new Set<string>();
  const gaps: string[] = [];
  for (const m of served ?? []) {
    const key = m.id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (!wired.has(key)) {
      if (gaps.length >= MAX_GAP_CHIPS) break;
      gaps.push(m.id);
    }
  }
  return gaps;
}

/** The profile's ACTIVE provider slug, when exactly one row says `current`.
 *  Zero or several currents ⇒ undefined (never a guess). */
export function currentProviderOf(providers: HermesModelProviderRow[] | undefined): HermesModelProviderRow | undefined {
  const cur = (providers ?? []).filter((p) => p.current === true);
  return cur.length === 1 ? cur[0] : undefined;
}
