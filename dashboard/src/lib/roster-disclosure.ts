// ---------------------------------------------------------------------------
// Roster disclosure (interaction law, dashboard-only, 2026-10-13): the
// session children under a profile row are EXPANDED BY DEFAULT while the
// profile owns sessions — from the profile's first observation on, the
// interesting children are simply visible (no toggle to wait for). A user
// toggle is the only stickiness: a collapsed profile stays collapsed even
// if its session count later changes; an expanded profile keeps its
// children slot open even once the children vanish (the view renders the
// honest empty line there). A childless profile the user never touched is
// never a disclosure at all — its row is exactly what it was. Pure: the
// view owns the overrides map, this decides the verdict. Zero wire change,
// zero join change.
// ---------------------------------------------------------------------------

/** The user's toggles, keyed by profile name (true = opened, false = folded). */
export type DisclosureOverrides = ReadonlyMap<string, boolean>;

/** Are this profile's session children currently visible? Override first,
 *  else the default: the live "has children" verdict. */
export function disclosureOpen(
  overrides: DisclosureOverrides,
  profile: string,
  hasChildren: boolean,
): boolean {
  return overrides.get(profile) ?? hasChildren;
}

/** Toggle copy: flip the effective state into a sticky override. */
export function toggleDisclosure(
  overrides: DisclosureOverrides,
  profile: string,
  hasChildren: boolean,
): Map<string, boolean> {
  const next = new Map<string, boolean>(overrides);
  next.set(profile, !disclosureOpen(overrides, profile, hasChildren));
  return next;
}
