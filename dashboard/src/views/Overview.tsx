import * as React from "react";
import { toast } from "sonner";
import {
  Card,
  CardHeader,
  CardTitle,
  CardAction,
  CardContent,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  apiToken,
  unthrottleJob,
  type CycleStatusRow,
  type HermesJobRow,
  type LeaseRow,
  type StateSnapshot,
  type ThrottledJob,
} from "@/lib/api";
import { ago, cycleTone, durFmt, fmt, liveWord, minSec } from "@/lib/format";
import { HERMES_JOBS_LABEL, collectHermesJobGroups, type HermesJobGroup } from "@/lib/hermes-jobs";

const TONE: Record<string, string> = {
  ok: "text-ok",
  warn: "text-warn",
  err: "text-err",
  accent: "text-accent",
  dim: "text-dim",
};

// ---------------------------------------------------------------------------
// Overview — the system glance. The header carries the one-word state;
// this view adds the context: the idle detail, the dev-cycle strip (the
// worker-published rows, rendered verbatim), the throttled jobs (the
// anti-thrash backstop, each with its operator recovery), the recent
// events, and the recent leases. Cycles + throttled are exception-only:
// the card stands in only while it has rows.
// ---------------------------------------------------------------------------

export function Overview({ st }: { st: StateSnapshot | null }) {
  if (!st) return <OverviewSkeleton />;
  const cycleGroups = collectCycleGroups(st);
  const jobGroups = collectHermesJobGroups(st);
  const throttled = st.throttled_jobs ?? [];

  return (
    <section className="flex flex-col gap-3">
      <SystemCard st={st} />
      {cycleGroups.length === 0 && throttled.length === 0 && jobGroups.length === 0 ? (
        <Card className="py-4 shadow-none">
          <CardContent className="px-4 text-[12px] text-dim">
            nothing needs attention — no dev cycles published, no jobs throttled, no Hermes jobs reported.
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {cycleGroups.length > 0 && <CycleStrip groups={cycleGroups} />}
          {jobGroups.length > 0 && <HermesJobsCard st={st} groups={jobGroups} />}
          {throttled.length > 0 && <ThrottledCard st={st} jobs={throttled} />}
        </div>
      )}
      <EventsCard st={st} />
      <LeasesCard st={st} />
    </section>
  );
}

function OverviewSkeleton() {
  return (
    <section className="flex flex-col gap-3">
      <Skeleton className="h-24 rounded-lg" />
      <div className="grid gap-3 lg:grid-cols-2">
        <Skeleton className="h-32 rounded-lg" />
        <Skeleton className="h-32 rounded-lg" />
      </div>
      <Skeleton className="h-40 rounded-lg" />
    </section>
  );
}

// The system card: the global idle verdict with its context.
function SystemCard({ st }: { st: StateSnapshot }) {
  const running = (st.active_leases ?? []).length > 0;
  const word = liveWord(st.idle, running);
  const activeCount = (st.active_leases ?? []).length;
  const idleFor = st.idle.idle_for_s;
  const last = st.idle.last_activity;
  const detail = (
    <div className="flex flex-col gap-1 text-[12px]">
      {st.idle.degraded && st.idle.degraded_reason && (
        <div className="text-err" title="signal degraded — grants blocked">
          {st.idle.degraded_reason}
        </div>
      )}
      {!st.idle.degraded && st.idle.idle && (
        <div className="text-dim">
          idle for {idleFor != null ? durFmt(idleFor).replace("~", "") : "—"}
          {st.idle.reidle_gated ? " · reidle gate armed (a lease just ended)" : ""}
        </div>
      )}
      {!st.idle.degraded && !st.idle.idle && (
        <div className="text-dim">
          {running
            ? `running ${activeCount} idle ${activeCount === 1 ? "task" : "tasks"} — grants blocked while work runs`
            : "interactive traffic — grants blocked"}
        </div>
      )}
      {last && (
        <div className="text-dim" title="the newest request the arbiter saw">
          last activity: {last.model} · {ago(st.now - last.ts)}
        </div>
      )}
      {st.idle.last_log_write_age_s != null && (
        <div className="text-dim" title="the newest engine log write">
          last log write {ago(st.now - (st.idle.last_log_write ?? st.now))}
        </div>
      )}
    </div>
  );

  return (
    <Card className="py-0 shadow-none">
      <CardHeader className="flex-row items-center gap-2 px-4 py-2 pb-0">
        <CardTitle className="text-[12px] font-semibold uppercase tracking-wide text-dim">System</CardTitle>
        <CardAction>
          <span className={`text-[15px] font-semibold ${TONE[word.tone]}`} title={word.note}>
            {word.label}
          </span>
        </CardAction>
      </CardHeader>
      <CardContent className="px-4 py-2">{detail}</CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// The dev-cycle strip (#53 D9.3): one row per (worker, project, cycle).
// The rows arrive on the worker's published allocation and render verbatim.
// The only arithmetic anywhere is the +1 that turns the 0-based cursor into
// the human "item 3 of 7" — no rollups, no merged progress line.
// ---------------------------------------------------------------------------

type CycleGroup = {
  project: string;
  worker: string;
  online: boolean;
  cap?: number;
  rows: CycleStatusRow[];
};

function collectCycleGroups(st: StateSnapshot): CycleGroup[] {
  const groups: CycleGroup[] = [];
  for (const p of st.projects ?? []) {
    for (const w of p.workers ?? []) {
      const rows = w.cycles ?? [];
      if (rows.length === 0) continue;
      groups.push({
        project: p.name,
        worker: w.client,
        online: w.online,
        ...(w.cycle_cap !== undefined ? { cap: w.cycle_cap } : {}),
        rows,
      });
    }
  }
  return groups;
}

function CycleStrip({ groups }: { groups: CycleGroup[] }) {
  return (
    <Card className="py-0 shadow-none">
      <CardHeader className="flex-row items-center gap-2 px-4 py-2 pb-0">
        <CardTitle className="text-[12px] font-semibold uppercase tracking-wide text-dim">Cycles</CardTitle>
        <CardAction>
          <span className="text-[11px] text-dim">{groups.length} {groups.length === 1 ? "worker" : "workers"} publishing</span>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-2.5 px-4 py-2.5">
        {groups.map((g) => (
          <div key={`${g.project}/${g.worker}`} className="flex flex-col gap-1">
            <div className="flex items-center gap-2 text-[12px]">
              <span
                className={`size-1.5 rounded-full ${g.online ? "bg-ok" : "bg-border"}`}
                title={g.online ? "worker online" : "worker offline"}
              />
              <span className="font-semibold">{g.project}</span>
              <span className="text-dim">{g.worker}</span>
              {g.cap !== undefined && (
                <Badge
                  variant="outline"
                  className="rounded-pill px-1.5 py-0 text-[10px] font-normal text-dim"
                  title="cycle_max_in_flight the worker's driver runs with — admission cap, stages still run one at a time"
                >
                  cap {g.cap}
                </Badge>
              )}
            </div>
            <div className="flex flex-col gap-0.5">
              {g.rows.map((c) => (
                <CycleRow key={c.cycle_id} c={c} />
              ))}
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function CycleRow({ c }: { c: CycleStatusRow }) {
  const tallies: string[] = [];
  if (c.passed) tallies.push(`${c.passed} passed`);
  if (c.quarantined) tallies.push(`${c.quarantined} quarantined`);
  return (
    <div className="flex items-baseline gap-2 pl-3.5 text-[12px]">
      <span className="min-w-[90px] shrink-0 font-mono text-[11px]" title="cycle id (published by the worker)">
        {c.cycle_id}
      </span>
      <span className={`w-14 shrink-0 ${TONE[cycleTone(c.status)]}`}>{c.status}</span>
      <span className="text-dim" title="current item (the worker's stored cursor, shown 1-based) · current stage">
        item {((c.item_index || 0) + 1)}/{c.items_total || 0} · {c.stage}
        {tallies.length > 0 && (
          <>
            {" · "}
            {tallies.map((t, i) => (
              <React.Fragment key={i}>
                {i > 0 && " · "}
                <span className={t.includes("quarantined") ? "text-err" : undefined}>{t}</span>
              </React.Fragment>
            ))}
          </>
        )}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// HERMES JOBS (#85 slice D): Hermes' OWN cron, published by each client's
// gateway connector (sanitized, fetched at most once per connector round).
// The strip sits BESIDE the dev-cycle strip on purpose — the operator sees
// Hermes' schedule next to idlefill's cycles. The NAMING is the issue's
// hard rule ("Hermes jobs" everywhere — idlefill has its own job concept
// and the collision is the named hazard; the header uses the single label
// constant from lib/hermes-jobs). READ-ONLY by construction: rendered rows
// only — the gateway's pause/resume/run/create verbs are deliberately NOT
// exposed in this issue, so there is no button here to mis-click.
// Exception-only: no client reported the block ⇒ no card (never an empty
// list pretending to be truth).
// ---------------------------------------------------------------------------

function HermesJobsCard({ st, groups }: { st: StateSnapshot; groups: HermesJobGroup[] }) {
  return (
    <Card className="py-0 shadow-none">
      <CardHeader className="flex-row items-center gap-2 px-4 py-2 pb-0">
        <CardTitle className="text-[12px] font-semibold uppercase tracking-wide text-dim">{HERMES_JOBS_LABEL}</CardTitle>
        <CardAction>
          <span
            className="text-[11px] text-dim"
            title="Hermes' own cron on each worker's machine — read-only visibility; idlefill's own jobs are the queue/lease rows elsewhere"
          >
            {groups.length} {groups.length === 1 ? "client" : "clients"} reporting · read-only
          </span>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-2.5 px-4 py-2.5">
        {groups.map((g) => (
          <div key={g.client} className="flex flex-col gap-1">
            <div className="flex items-center gap-2 text-[12px]">
              <span
                className={`size-1.5 rounded-full ${g.online ? "bg-ok" : "bg-border"}`}
                title={g.online ? "client online" : "client offline"}
              />
              <span className="font-semibold">{g.client}</span>
              <Badge
                variant="outline"
                className="rounded-pill px-1.5 py-0 text-[10px] font-normal text-dim"
                title="Hermes' own cron jobs reported by this machine's gateway connector"
              >
                {g.jobs.length} Hermes {g.jobs.length === 1 ? "job" : "jobs"}
              </Badge>
            </div>
            <div className="flex flex-col gap-0.5">
              {g.jobs.map((j) => (
                <HermesJobRowView key={`${g.client}/${j.profile ?? "default"}/${j.id}`} j={j} now={st.now} />
              ))}
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function HermesJobRowView({ j, now }: { j: HermesJobRow; now: number }) {
  const paused = j.enabled === false || j.state === "paused";
  const dueIn = j.next_run !== undefined && j.next_run > now ? minSec((j.next_run - now) / 1000) : null;
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 pl-3.5 text-[12px]">
      <code className="text-[11px] text-dim" title="the Hermes job id (gateway cron, not an idlefill job id)">{j.id}</code>
      {j.profile && <span className="text-[11px] text-dim" title="the Hermes profile that owns this job">{j.profile}</span>}
      <span className="min-w-0" title="the job name (display member — the Hermes prompt is never published)">
        {j.name ?? j.id}
      </span>
      {j.schedule && <span className="text-dim">{j.schedule}</span>}
      {paused && (
        <Badge
          variant="outline"
          className="h-4 rounded-pill border-warn/50 px-1.5 py-0 text-[10px] font-normal text-warn"
          title="this Hermes job is paused/disabled on its machine — the strip is read-only (control verbs are out of this issue)"
        >
          paused
        </Badge>
      )}
      {j.state && !paused && j.state !== "scheduled" && (
        <span className="text-[11px] text-dim" title="the gateway's own state word for the job">{j.state}</span>
      )}
      <span className="ml-auto text-[11px] text-dim" title="last run · next scheduled run (the client's clock)">
        {j.last_run !== undefined ? `ran ${ago(now - j.last_run)}` : "never ran"}
        {dueIn ? ` · due in ${dueIn}` : j.next_run !== undefined ? " · due passed" : ""}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Throttled jobs — the anti-thrash backstop. Each row is a job whose
// failures crossed the threshold; while it stands, no new grant for it.
// The unthrottle button is the operator's recovery (token-gated).
// ---------------------------------------------------------------------------

function ThrottledCard({ st, jobs }: { st: StateSnapshot; jobs: ThrottledJob[] }) {
  const [pending, setPending] = React.useState<string | null>(null);
  const unthrottle = async (t: ThrottledJob) => {
    if (!apiToken()) {
      toast.error("needs the arbiter API token — paste it in the header first");
      return;
    }
    const key = `${t.project}/${t.job_id}`;
    setPending(key);
    try {
      const r = await unthrottleJob(t.project, t.job_id);
      toast.success(r.was_throttled === false ? "job was not throttled — nothing cleared" : `unthrottled ${t.job_id}`);
    } catch (e) {
      toast.error(`unthrottle refused: ${(e as Error).message}`);
    } finally {
      setPending(null);
    }
  };
  return (
    <Card className="py-0 shadow-none">
      <CardHeader className="flex-row items-center gap-2 px-4 py-2 pb-0">
        <CardTitle className="text-[12px] font-semibold uppercase tracking-wide text-dim">Throttled jobs</CardTitle>
        <CardAction>
          <span className="text-[11px] text-dim">no new grants while throttled</span>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 px-4 py-2.5">
        {jobs.map((t) => (
          <div key={`${t.project}/${t.job_id}`} className="flex flex-col gap-1 text-[12px]">
            <div className="flex items-center gap-2">
              <code className="min-w-0 truncate text-err" title="job id">{t.job_id}</code>
              <span className="text-dim">{t.project}</span>
              <span className="text-dim" title="failure count when the threshold was crossed">
                {t.count ?? "—"} failures
              </span>
              <span className="text-dim" title="last failure time">since {ago(st.now - t.last_failed_at)}</span>
              <Button
                size="xs"
                variant="outline"
                className="ml-auto h-6 px-2 text-[11px]"
                disabled={pending !== null}
                onClick={() => void unthrottle(t)}
                title="clear the throttle + failure count + grant cooldown — the job can be granted again"
              >
                {pending === `${t.project}/${t.job_id}` ? "clearing…" : "unthrottle"}
              </Button>
            </div>
            <div className="text-[11px] text-dim" title="last error">{t.last_error}</div>
            {t.last_error_detail && (
              <div
                className="max-h-24 overflow-auto rounded-sm border border-border bg-background/60 px-2 py-1 font-mono text-[11px] text-dim"
                title="last failure detail (client output tail, ≤1000 chars)"
              >
                {t.last_error_detail}
              </div>
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Events + leases — the dock's records, now cards. The same records the
// legacy bottom dock showed (the limit rides /api/state?limit=10).
// ---------------------------------------------------------------------------

function EventsCard({ st }: { st: StateSnapshot }) {
  const events = st.events ?? [];
  return (
    <Card className="py-0 shadow-none">
      <CardHeader className="flex-row items-center gap-2 px-4 py-2 pb-0">
        <CardTitle className="text-[12px] font-semibold uppercase tracking-wide text-dim">Recent events</CardTitle>
        <CardAction>
          <span className="text-[11px] text-dim">{events.length} most recent</span>
        </CardAction>
      </CardHeader>
      <CardContent className="px-4 py-2">
        {events.length === 0 ? (
          <div className="py-2 text-center text-[12px] text-dim">no events yet</div>
        ) : (
          <div className="flex flex-col">
            {events.map((e, i) => (
              <div key={`${e.ts}-${i}`} className="flex items-baseline gap-2 border-b border-border/50 py-1 text-[12px] last:border-0">
                <span className="w-[72px] shrink-0 font-mono text-[11px] text-dim" title={new Date(e.ts).toISOString()}>
                  {new Date(e.ts).toISOString().slice(11, 19)}Z
                </span>
                <span className="shrink-0 text-accent">{e.kind}</span>
                <span className="shrink-0 text-dim">{e.project ?? ""}</span>
                <span className="min-w-0 truncate text-foreground/90" title={e.detail}>
                  {e.detail ?? ""}
                </span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function LeasesCard({ st }: { st: StateSnapshot }) {
  const leases = st.leases ?? [];
  const STATUS_TONE: Record<string, string> = {
    active: "text-accent",
    finished: "text-ok",
    revoked: "text-warn",
    expired: "text-warn",
  };
  return (
    <Card className="py-0 shadow-none">
      <CardHeader className="flex-row items-center gap-2 px-4 py-2 pb-0">
        <CardTitle className="text-[12px] font-semibold uppercase tracking-wide text-dim">Recent leases</CardTitle>
        <CardAction>
          <span className="text-[11px] text-dim">{(st.active_leases ?? []).length} active</span>
        </CardAction>
      </CardHeader>
      <CardContent className="px-4 py-2">
        {leases.length === 0 ? (
          <div className="py-2 text-center text-[12px] text-dim">no leases yet</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[12px]">
              <thead>
                <tr className="text-left text-[11px] text-dim">
                  <th className="py-1 pr-3 font-medium">job</th>
                  <th className="py-1 pr-3 font-medium">project</th>
                  <th className="py-1 pr-3 font-medium">worker</th>
                  <th className="py-1 pr-3 font-medium">status</th>
                  <th className="py-1 pr-3 font-medium">granted</th>
                  <th className="py-1 pr-3 font-medium">running / ttl</th>
                  <th className="py-1 pr-3 font-medium">tokens out</th>
                  <th className="py-1 font-medium">end</th>
                </tr>
              </thead>
              <tbody>
                {leases.map((l) => (
                  <LeaseRowView key={l.lease_id} l={l} now={st.now} tone={STATUS_TONE[l.status] ?? "text-dim"} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function LeaseRowView({ l, now, tone }: { l: LeaseRow; now: number; tone: string }) {
  const ageS = Math.max(0, Math.floor((now - (l.ended_at ?? l.granted_at)) / 1000));
  const ttlS = l.status === "active" ? Math.max(0, Math.floor((l.expires_at - now) / 1000)) : null;
  return (
    <tr className="border-t border-border/50">
      <td className="max-w-[220px] truncate py-1 pr-3" title={l.job_id}>
        {l.job_id}
      </td>
      <td className="py-1 pr-3 text-dim">{l.project}</td>
      <td className="py-1 pr-3 text-dim">{l.client_name}</td>
      <td className={`py-1 pr-3 ${tone}`}>{l.status}</td>
      <td className="py-1 pr-3 text-dim">{ago(now - l.granted_at)}</td>
      <td className="py-1 pr-3 text-dim">
        {l.status === "active" ? minSec((l.ended_at ?? now) - l.granted_at) : `${ageS}s`}
        {ttlS !== null && ` · ${minSec(ttlS)}`}
      </td>
      <td className="py-1 pr-3">{fmt(l.tokens_out)}</td>
      <td className="max-w-[160px] truncate py-1 text-dim" title={l.end_reason}>
        {l.end_reason ?? (l.partial ? "partial" : "")}
      </td>
    </tr>
  );
}
