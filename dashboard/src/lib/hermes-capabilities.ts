import type { HermesSkillRow, HermesToolsetRow } from "./api";

// ---------------------------------------------------------------------------
// Hermes capabilities (#85 slice B): the pure grouping step behind the Agents
// tab's per-profile capability rows. The rows arrive from GET /api/agent-roster
// (the local client's `hermes_skills` / `hermes_toolsets` register blocks,
// client-sanitized + arbiter-re-sanitized) — this step adds NOTHING to the
// payload: it only buckets rows by their stamped owning profile so the roster
// rows can render their chips.
//
// Exception-only like every sibling: a profile with no skills and no toolsets
// gets no entry (its roster row renders exactly as before the slice); an old
// client publishes neither key and the chips simply never appear. READ-ONLY:
// there is no enable/disable affordance in this plane anywhere — the gateway
// owns the enabled/configured verdicts, the dashboard only shows them.
// ---------------------------------------------------------------------------

/** The one UI label for the capability chrome — pinned here so the copy has
 *  one source and one test (the "Hermes jobs" naming precedent applies: this
 *  is HERMES' capability inventory, not an idlefill concept). */
export const HERMES_CAPABILITIES_LABEL = "Hermes capabilities";

export type ProfileCapabilities = {
  profile: string;
  skills: HermesSkillRow[];
  toolsets: HermesToolsetRow[];
};

/**
 * Bucket the two blocks by their stamped owning profile. The connector stamps
 * every row (it knows the profile whose gateway answered); an unstamped row
 * attributes to `default` (the gateway's home store) — never a guess from
 * the name. An empty/absent block contributes nothing; the map is built ONLY
 * from rows that actually arrived.
 */
export function groupCapabilitiesByProfile(
  skills: HermesSkillRow[] | undefined,
  toolsets: HermesToolsetRow[] | undefined,
): Map<string, ProfileCapabilities> {
  const out = new Map<string, ProfileCapabilities>();
  const slot = (profile: string): ProfileCapabilities => {
    let s = out.get(profile);
    if (!s) {
      s = { profile, skills: [], toolsets: [] };
      out.set(profile, s);
    }
    return s;
  };
  for (const r of skills ?? []) slot((r.profile ?? "").trim() !== "" ? r.profile!.trim() : "default").skills.push(r);
  for (const r of toolsets ?? []) slot((r.profile ?? "").trim() !== "" ? r.profile!.trim() : "default").toolsets.push(r);
  return out;
}

/** True when the strip would render NOTHING (absent/empty both ways) — the
 *  exception-only gate: then the roster rows are byte-for-byte their
 *  pre-slice shape. */
export function hasCapabilities(caps: Map<string, ProfileCapabilities> | undefined): boolean {
  if (!caps) return false;
  for (const c of caps.values()) {
    if (c.skills.length > 0 || c.toolsets.length > 0) return true;
  }
  return false;
}
