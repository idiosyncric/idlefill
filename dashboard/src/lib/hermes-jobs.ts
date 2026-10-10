import type { HermesJobRow, StateSnapshot } from "./api";

// ---------------------------------------------------------------------------
// Hermes jobs (#85 slice D): the pure collection step behind the Overview's
// "Hermes jobs" strip — the read-plane sibling of the #53 dev-cycle strip,
// so the operator sees Hermes' OWN cron BESIDE idlefill's cycles. The
// NAMING rule is the issue's hard requirement: these are "Hermes jobs"
// everywhere (the label constant below is THE copy, and the wire key is
// `hermes_jobs`) — idlefill has its own job concept and the collision is
// the named hazard.
//
// The rows arrive client-sanitized (safe display members only) and
// arbiter-re-sanitized; the grouping here adds nothing to the payload.
// Exception-only like every sibling strip: a client without the key (old
// client, gateway outage, connector off) yields no group, and the card
// hides rather than showing an empty list. READ-ONLY: nothing here can
// address the gateway's job verbs.
// ---------------------------------------------------------------------------

/** The single UI label for the strip — pinned here so the naming rule
 *  ("Hermes jobs", never a bare "jobs") has one source and one test. */
export const HERMES_JOBS_LABEL = "Hermes jobs";

/** One client's Hermes-job group (the strip renders one block per group). */
export type HermesJobGroup = {
  client: string;
  online: boolean;
  jobs: HermesJobRow[];
};

/** Online rule shared with projectView's workers (heartbeat within 90s). */
const ONLINE_MS = 90_000;

/**
 * Collect the strip's groups from the state snapshot: one per CLIENT row
 * that published a non-empty `hermes_jobs` block (the strip is per-client
 * detail — like the #73 host-facts block it reads the client row, and a
 * client with no projects still gets its strip). Sorted online-first, then
 * by name (the projectView workers' order rule).
 */
export function collectHermesJobGroups(st: StateSnapshot): HermesJobGroup[] {
  const groups: HermesJobGroup[] = [];
  for (const c of st.clients ?? []) {
    const jobs = c.hermes_jobs ?? [];
    if (jobs.length === 0) continue;
    groups.push({
      client: c.name,
      online: st.now - (c.last_seen ?? 0) < ONLINE_MS,
      jobs,
    });
  }
  groups.sort((a, b) => Number(b.online) - Number(a.online) || a.client.localeCompare(b.client));
  return groups;
}
