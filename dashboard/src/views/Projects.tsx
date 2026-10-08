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
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  apiToken,
  setClientOverride,
  setProjectPaused,
  setProjectSettings,
  readLocalProjects,
  writeLocalProjects,
  type ProjectRow,
  type WorkerRow,
  type StateSnapshot,
} from "@/lib/api";
import { durFmt, fmt, gateLabelText, minSec, projGateLabelText } from "@/lib/format";

// ---------------------------------------------------------------------------
// Projects — the queue side of the two-pane rethink. One card per configured
// project: the running jobs (its active leases), today's budget bar, the
// connected workers (each with its own gate + published stats), the blocking
// notes, the effective schedule line, and the grant-knob editor. Above the
// cards: the queue search (a client-side filter over the per-worker PUBLISHED
// previews — the arbiter never reads queue files, so the search is only as
// deep as the preview: the first 100 queued per worker). Below: the local
// client config editor (loopback page origin only).
// ---------------------------------------------------------------------------

export function Projects({ st }: { st: StateSnapshot | null }) {
  const [query, setQuery] = React.useState("");

  if (!st) {
    return (
      <section>
        <h2 className="text-[12px] font-semibold uppercase tracking-wide text-dim mb-3">Projects</h2>
        <Card className="py-4 shadow-none">
          <CardContent className="px-4 text-[12px] text-dim">waiting for state…</CardContent>
        </Card>
      </section>
    );
  }

  const projects = st.projects ?? [];

  return (
    <section>
      <div className="flex items-center gap-3 mb-3">
        <h2 className="text-[12px] font-semibold uppercase tracking-wide text-dim">Projects</h2>
        <Input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="search queued jobs — job_id / company / title"
          spellCheck={false}
          autoComplete="off"
          className="ml-auto h-6 w-72 text-[12px]"
          title="substring match across every worker's published queue preview (first 100 queued per worker) — read-only, no API call"
        />
      </div>

      {query.trim() !== "" && (
        <QueueSearchResults projects={projects} query={query.trim()} />
      )}

      {projects.length === 0 ? (
        <Card className="py-4 shadow-none">
          <CardContent className="px-4 text-[12px] text-dim">
            no projects configured — add one to the arbiter's <code>projects</code> config
          </CardContent>
        </Card>
      ) : (
        <div className="flex flex-col gap-2.5">
          {projects.map((p) => (
            <ProjectCard key={p.name} p={p} st={st} />
          ))}
        </div>
      )}

      <LocalClientConfig st={st} />
    </section>
  );
}

// ---------------------------------------------------------------------------
// Queue search — the filter over the published previews.
// ---------------------------------------------------------------------------

type Match = { project: string; worker: string; job_id: string; title: string; company: string; score: number | null; attempts: number };

function queueSearch(projects: ProjectRow[], q: string): Match[] {
  const needle = q.toLowerCase();
  const out: Match[] = [];
  for (const p of projects) {
    for (const w of p.workers ?? []) {
      for (const r of w.queue_preview ?? []) {
        const hay = [r.job_id, r.company, r.title].map((x) => String(x ?? "").toLowerCase());
        if (hay.some((h) => h.includes(needle))) {
          out.push({ project: p.name, worker: w.client, job_id: r.job_id, title: r.title, company: r.company, score: r.score, attempts: r.attempts });
        }
      }
    }
  }
  return out;
}

function QueueSearchResults({ projects, query }: { projects: ProjectRow[]; query: string }) {
  const matches = queueSearch(projects, query);
  return (
    <Card className="mb-3 py-0 shadow-none">
      <CardHeader className="flex-row items-center gap-2 px-4 py-2 pb-0">
        <CardTitle className="text-[12px] font-semibold uppercase tracking-wide text-dim">Queue search</CardTitle>
        <CardAction>
          <span className="text-[11px] text-dim">
            {matches.length} {matches.length === 1 ? "match" : "matches"} across the published previews
          </span>
        </CardAction>
      </CardHeader>
      <CardContent className="px-4 py-2">
        {matches.length === 0 ? (
          <div className="py-1 text-center text-[12px] text-dim">
            no queued job matches “{query}” in the published previews (first 100 queued per worker)
          </div>
        ) : (
          <div className="flex flex-col">
            {matches.map((m, i) => (
              <a
                key={`${m.project}/${m.worker}/${m.job_id}-${i}`}
                href={`/${encodeURIComponent(m.project)}/${encodeURIComponent(m.worker)}/queue`}
                className="flex items-baseline gap-2 rounded-sm px-1 py-1 text-[12px] hover:bg-accent-bg"
              >
                <b className="max-w-[320px] truncate" title={m.job_id}>{m.title}</b>
                <code className="min-w-0 truncate text-[11px] text-dim">{m.job_id}</code>
                <span className="text-dim">{m.company}</span>
                <span className="text-dim">{m.project} › {m.worker}</span>
              <span className="ml-auto shrink-0 text-dim">{m.score == null ? "—" : m.score}</span>
              {m.attempts > 0 && <span className="shrink-0 text-warn" title="retries used so far">{m.attempts} retries</span>}
            </a>
          ))}
        </div>
      )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// One project card.
// ---------------------------------------------------------------------------

function ProjectCard({ p, st }: { p: ProjectRow; st: StateSnapshot }) {
  const b = p.budget_today ?? { tokens_out: 0, tokens_in: 0, cap: p.daily_token_cap ?? 0 };
  const cap = b.cap ?? p.scheduling?.daily_token_cap ?? 0;
  const pct = cap > 0 ? Math.min(100, ((b.tokens_out ?? 0) / cap) * 100) : 0;
  const capTxt = cap >= Number.MAX_SAFE_INTEGER || cap === 0 ? "∞" : cap.toLocaleString();
  const sched = p.scheduling ?? {
    paused: p.paused,
    idle_seconds: 0,
    max_concurrent_leases: 0,
    lease_ttl_seconds: 0,
    daily_token_cap: cap,
    overrides: { idle_seconds: null, max_concurrent_leases: null, lease_ttl_seconds: null },
  };
  const workers = p.workers ?? [];
  const totalQueued = workers.reduce((s, w) => s + (w.queue_depth || 0), 0);
  const onlineCnt = workers.filter((w) => w.online).length;
  const tod = p.today ?? { finished: 0, failed: 0 };
  const myLeases = (st.active_leases ?? []).filter((l) => l.project === p.name);
  const done = tod.finished + tod.failed;
  const [settingsOpen, setSettingsOpen] = React.useState(false);

  const budgetFull = cap > 0 && (b.tokens_out ?? 0) >= cap;

  const setPaused = async (paused: boolean) => {
    if (!apiToken()) {
      toast.error("needs the arbiter API token — paste it in the header first");
      return;
    }
    try {
      await setProjectPaused(p.name, paused);
      toast.success(paused ? `project ${p.name} paused` : `project ${p.name} resumed`);
    } catch (e) {
      toast.error(`gate refused: ${(e as Error).message}`);
    }
  };

  // Exception notes: what is blocking this project's queue right now.
  const blocks: string[] = [];
  if (p.paused) blocks.push("project paused");
  else if (budgetFull) blocks.push("budget full");
  if (workers.length > 0 && onlineCnt === 0) blocks.push("no workers online");

  const ov = sched.overrides ?? { idle_seconds: null, max_concurrent_leases: null, lease_ttl_seconds: null };
  const hasOverride = [ov.idle_seconds, ov.max_concurrent_leases, ov.lease_ttl_seconds].some((v) => v != null);

  return (
    <Card className="gap-0 py-0 shadow-none">
      <CardHeader className="flex-row flex-wrap items-center gap-2 px-4 py-2 pb-0">
        <CardTitle className="text-[14px] font-semibold">{p.name}</CardTitle>
        {p.paused && <Badge variant="outline" className="rounded-pill border-warn/50 px-1.5 py-0 text-[10px] font-normal text-warn">paused</Badge>}
        {!p.paused && budgetFull && <Badge variant="outline" className="rounded-pill border-warn/50 px-1.5 py-0 text-[10px] font-normal text-warn">budget full</Badge>}
        {totalQueued > 0 && (
          <span className="text-[11px] text-dim">
            {totalQueued.toLocaleString()} job{totalQueued === 1 ? "" : "s"} waiting
          </span>
        )}
        <CardAction className="gap-1.5">
          <Select value={p.paused ? "paused" : "scheduled"} onValueChange={(v) => void setPaused(v === "paused")}>
            <SelectTrigger size="sm" className="h-6 w-[118px] text-[11px]" title={`set project gate for ${p.name}`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="paused" className="text-[11px]">{projGateLabelText("paused")}</SelectItem>
              <SelectItem value="scheduled" className="text-[11px]">{projGateLabelText("scheduled")}</SelectItem>
            </SelectContent>
          </Select>
          <Button size="xs" variant="ghost" className="h-6 px-2 text-[11px]" onClick={() => setSettingsOpen(true)}>
            settings
          </Button>
        </CardAction>
      </CardHeader>

      <CardContent className="flex flex-col gap-2 px-4 py-2.5">
        {/* Running jobs (this project's active leases — ALL of them). */}
        {myLeases.length > 0 && (
          <div className="flex flex-col gap-1">
            {myLeases.length > 1 && (
              <div className="text-[11px] text-dim">
                {myLeases.length} running · max {sched.max_concurrent_leases ?? "—"} at a time
              </div>
            )}
            {myLeases.map((l) => {
              const ageS = Math.max(0, Math.floor((st.now - l.granted_at) / 1000));
              const leftS = Math.max(0, Math.floor((l.expires_at - st.now) / 1000));
              return (
                <div key={l.lease_id} className="flex flex-wrap items-baseline gap-x-4 gap-y-0.5 text-[12px]">
                  <span className="min-w-0">
                    <span className="text-[11px] text-dim">job </span>
                    <code className="text-accent">{l.job_id}</code>
                  </span>
                  <span className="text-dim">
                    <span className="text-[11px]">worker </span>
                    {l.client_name}
                  </span>
                  <span className="text-dim">
                    <span className="text-[11px]">running </span>
                    {minSec(ageS)}
                  </span>
                  <span className={leftS < 120 ? "text-warn" : "text-dim"}>
                    <span className="text-[11px]">auto-cancels in </span>
                    {minSec(leftS)}
                  </span>
                </div>
              );
            })}
          </div>
        )}

        {/* Today's budget. */}
        <div>
          <div className="flex items-baseline gap-2 text-[12px]">
            <span className="text-[11px] text-dim">output tokens today (UTC)</span>
            <span className="ml-auto">
              {(b.tokens_out ?? 0).toLocaleString()} / {capTxt}
              {(b.tokens_in ?? 0) > 0 && <span className="text-dim"> · {(b.tokens_in ?? 0).toLocaleString()} input</span>}
            </span>
          </div>
          <div className="mt-1 h-1 overflow-hidden rounded-full bg-border">
            <div className={pct > 80 ? "h-full bg-warn" : "h-full bg-accent"} style={{ width: `${pct.toFixed(1)}%` }} />
          </div>
        </div>

        {workers.length > 0 ? (
          <div className="flex flex-col gap-1">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-dim">
              workers <span className="font-normal">({workers.length})</span>
            </div>
            {workers.map((w) => (
              <WorkerRowView key={w.client} w={w} projectName={p.name} />
            ))}
          </div>
        ) : (
          <div className="text-[12px] text-dim">no workers connected for this project</div>
        )}

        {blocks.length > 0 && (
          <div className="text-[11px] text-warn">not running: {blocks.join(" · ")}</div>
        )}
        {done > 0 && (
          <div className="text-[11px] text-dim">
            today: {tod.finished} finished
            {tod.failed > 0 && <span className="text-err"> · {tod.failed} failed</span>}
          </div>
        )}
        <div className="text-[11px] text-dim" title="the knobs that gate this project's grants">
          runs when idle ≥{sched.idle_seconds ?? "—"}s · max {sched.max_concurrent_leases ?? "—"}{" "}
          {sched.max_concurrent_leases === 1 ? "job" : "jobs"} at a time · auto-cancels after{" "}
          {durFmt(sched.lease_ttl_seconds).replace("~", "")}
          {hasOverride && <span> · <span className="text-dim/70">project-specific limits</span></span>}
        </div>
      </CardContent>

      <ProjectSettingsDialog p={p} open={settingsOpen} onOpenChange={setSettingsOpen} />
    </Card>
  );
}

// One worker row: liveness dot, name (+ exception tags), model + estimate,
// the queue depth (+ the queue page link), the per-worker gate, and the
// published stats (rendered verbatim, never computed).
function WorkerRowView({ w, projectName }: { w: WorkerRow; projectName: string }) {
  const paused = w.override?.override === "pause";

  const setGate = async (value: string) => {
    if (!apiToken()) {
      toast.error("needs the arbiter API token — paste it in the header first");
      return;
    }
    const ref = w.client_id ?? w.client;
    try {
      await setClientOverride(ref, value === "paused" ? "pause" : null);
      toast.success(value === "paused" ? `worker ${w.client} paused` : `worker ${w.client} scheduled`);
    } catch (e) {
      toast.error(`gate refused: ${(e as Error).message}`);
    }
  };

  const statKeys = Object.keys(w.stats ?? {});

  return (
    <div className="flex flex-col gap-0.5">
      <div
        className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px]"
        title={`reported by ${w.client}: model used · estimated time per job · jobs waiting in this worker's queue`}
      >
        <span className={`size-1.5 shrink-0 rounded-full ${w.online ? "bg-ok" : "bg-border"}`} title={w.online ? "online (saw a heartbeat within 90s)" : "offline (no recent heartbeat)"} />
        <span className="min-w-0 font-semibold">
          {w.client}
          {w.version && <span className="ml-1 text-[10px] font-normal text-dim" title="version reported by this worker at registration">{w.version}</span>}
          {!w.online && <span className="ml-1 text-[10px] font-normal text-dim">(offline)</span>}
        </span>
        {paused && (
          <Badge variant="outline" className="rounded-pill border-err/50 px-1.5 py-0 text-[10px] font-normal text-err" title="this worker is paused — no new grants (from any project)">
            paused
          </Badge>
        )}
        {w.gate_posture === "fail_open" && (
          <Badge variant="outline" className="rounded-pill border-warn/50 px-1.5 py-0 text-[10px] font-normal text-warn" title="this machine's arbiter link is down — its session gate is FAIL-OPEN: every session is admitted and the session slot cap is off until the link returns">
            gate fail-open
          </Badge>
        )}
        {w.daemon_behind === true && (
          <Badge variant="outline" className="rounded-pill border-warn/50 px-1.5 py-0 text-[10px] font-normal text-warn" title="this daemon runs code older than its own checkout — restart it (native toolbar, or launchctl kickstart) to pick up the current tree">
            daemon behind
          </Badge>
        )}
        <span className="text-[11px] text-dim">
          {w.model || "—"}
          {w.estimated_seconds ? ` · ${durFmt(w.estimated_seconds)}/job` : ""}
        </span>
        <span className="ml-auto flex items-center gap-2 text-[11px] text-dim">
          {(w.queue_depth || 0).toLocaleString()} queued
          {(w.queue_depth || 0) > 0 && (
            <a
              href={`/${encodeURIComponent(projectName)}/${encodeURIComponent(w.client)}/queue`}
              className="text-accent hover:underline"
              title="view this worker's queue (first 100, priority order)"
            >
              view
            </a>
          )}
          <Select value={paused ? "paused" : "scheduled"} onValueChange={(v) => void setGate(v)}>
            <SelectTrigger size="sm" className="h-6 w-[104px] text-[11px]" title={`set gate for ${w.client}`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="paused" className="text-[11px]">{gateLabelText("paused")}</SelectItem>
              <SelectItem value="scheduled" className="text-[11px]">{gateLabelText("scheduled")}</SelectItem>
            </SelectContent>
          </Select>
        </span>
      </div>
      {statKeys.length > 0 && (
        <div className="pl-3.5 text-[11px] text-dim" title="published by the worker — the arbiter shows it, it does not compute it">
          {statKeys.map((k) => (
            <span key={k}>
              {k !== "last_rebuild" && <>
                {k} <b className="text-foreground/80">{typeof w.stats[k] === "number" ? fmt(Number(w.stats[k])) : String(w.stats[k])}</b>{" "}
              </>}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The grant-knob editor (Dialog): idle_seconds, max_concurrent_leases,
// lease_ttl_seconds. A blank field CLEARS the override (inherits the global);
// a number sets the per-project value. The schedule line above stays the
// EFFECTIVE values — the editor is a control, not a second source of truth.
// ---------------------------------------------------------------------------

function ProjectSettingsDialog({ p, open, onOpenChange }: { p: ProjectRow; open: boolean; onOpenChange: (o: boolean) => void }) {
  const [idle, setIdle] = React.useState("");
  const [maxLeases, setMaxLeases] = React.useState("");
  const [ttl, setTtl] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) return;
    const ov = p.scheduling?.overrides ?? { idle_seconds: null, max_concurrent_leases: null, lease_ttl_seconds: null };
    setIdle(ov.idle_seconds != null ? String(ov.idle_seconds) : "");
    setMaxLeases(ov.max_concurrent_leases != null ? String(ov.max_concurrent_leases) : "");
    setTtl(ov.lease_ttl_seconds != null ? String(ov.lease_ttl_seconds) : "");
    setErr(null);
  }, [open, p]);

  const save = async () => {
    const body: { idle_seconds?: number | null; max_concurrent_leases?: number | null; lease_ttl_seconds?: number | null } = {};
    const parse = (v: string, key: keyof typeof body, label: string): string | null => {
      const t = v.trim();
      if (t === "") {
        body[key] = null; // blank = clear the override
        return null;
      }
      const n = Number(t);
      if (!Number.isFinite(n) || n <= 0) return `${label} must be a positive number (blank clears it)`;
      body[key] = n;
      return null;
    };
    for (const e of [parse(idle, "idle_seconds", "idle seconds"), parse(maxLeases, "max_concurrent_leases", "max leases"), parse(ttl, "lease_ttl_seconds", "ttl seconds")]) {
      if (e) {
        setErr(e);
        return;
      }
    }
    if (body.idle_seconds === undefined && body.max_concurrent_leases === undefined && body.lease_ttl_seconds === undefined) {
      setErr("nothing to save — every field is blank (blank = clear)");
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      await setProjectSettings(p.name, body);
      toast.success(`project ${p.name} settings saved`);
      onOpenChange(false);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const field = (label: string, value: string, set: (v: string) => void, placeholder: string, title: string) => (
    <label className="flex flex-col gap-1">
      <span className="text-dim">{label}</span>
      <Input
        className="h-7 text-[12px]"
        type="number"
        min={1}
        step="any"
        value={value}
        onChange={(e) => set(e.target.value)}
        placeholder={placeholder}
        title={title}
      />
    </label>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md font-mono text-[12px]">
        <DialogHeader>
          <DialogTitle className="text-[13px]">{p.name} · grant knobs</DialogTitle>
          <DialogDescription className="text-[11px]">
            per-project overrides of the global grant knobs. Blank clears the override — the project inherits the global again.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          {field("runs when idle ≥ (seconds)", idle, setIdle, String(p.scheduling?.idle_seconds ?? ""), "idle_seconds — blank inherits the global")}
          {field("max jobs at a time", maxLeases, setMaxLeases, String(p.scheduling?.max_concurrent_leases ?? ""), "max_concurrent_leases — blank inherits the global")}
          {field("auto-cancels after (seconds)", ttl, setTtl, String(p.scheduling?.lease_ttl_seconds ?? ""), "lease_ttl_seconds — blank inherits the global")}
          {err && <div className="border border-err/40 bg-err/10 px-2 py-1.5 text-[11px] text-err">{err}</div>}
        </div>
        <DialogFooter>
          <Button size="sm" variant="outline" className="h-7 text-[12px]" onClick={() => onOpenChange(false)}>
            cancel
          </Button>
          <Button size="sm" className="h-7 text-[12px]" disabled={saving} onClick={() => void save()}>
            {saving ? "saving…" : "save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Local client config (#61 step 3 A3): the LOCAL project entries of this
// machine's client/config.json. The page cannot write a local file — the
// LOCAL CLIENT can, and the page reaches it through the client's already-bound
// loopback proxy. Shown ONLY on a loopback page origin AND when an online
// client reports proxy_port. Restart stays native; this editor never
// restarts anything.
// ---------------------------------------------------------------------------

type LocalEntry = Record<string, unknown>;

function pageOriginLoopback(): boolean {
  const h = location.hostname;
  return h === "localhost" || h.startsWith("127.") || h === "[::1]" || h === "::1";
}

function LocalClientConfig({ st }: { st: StateSnapshot }) {
  const hosted = (st.clients ?? [])
    .filter((c) => c.proxy_port && st.now - (c.last_seen ?? 0) < 90_000)
    .sort((a, b) => a.name.localeCompare(b.name));
  if (!pageOriginLoopback() || hosted.length === 0) return null;
  return (
    <div className="mt-3 flex flex-col gap-2">
      <h3 className="text-[12px] font-semibold uppercase tracking-wide text-dim">Local client config</h3>
      {hosted.map((c) => (
        <LocalConfigEditor key={c.name} name={c.name} port={c.proxy_port!} />
      ))}
    </div>
  );
}

function LocalConfigEditor({ name, port }: { name: string; port: number }) {
  const [open, setOpen] = React.useState(false);
  const [projects, setProjects] = React.useState<LocalEntry[] | null>(null);
  const [raws, setRaws] = React.useState<LocalEntry[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [msg, setMsg] = React.useState<{ text: string; cls: string } | null>(null);

  const load = async () => {
    if (!apiToken()) {
      setMsg({ text: "the edit needs the arbiter token — paste it in the header first", cls: "text-err" });
      return;
    }
    setLoading(true);
    setMsg(null);
    try {
      const ps = await readLocalProjects(port);
      setProjects(ps);
      setRaws(ps.map((p) => ({ ...p })));
      if (ps.length === 0) setMsg({ text: "this client has no projects in its config", cls: "text-dim" });
    } catch (e) {
      setMsg({ text: `the local client at 127.0.0.1:${port} is unreachable: ${(e as Error).message}`, cls: "text-err" });
    } finally {
      setLoading(false);
    }
  };

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && projects === null) void load();
  };

  const setField = (i: number, key: string, value: string | number) => {
    const next = raws.map((p, j) => (j === i ? { ...p, [key]: value } : p));
    setRaws(next);
    setProjects(next.map((p) => ({ ...p })));
  };
  const clearField = (i: number, key: string) => {
    const next = raws.map((p, j) => {
      if (j !== i) return p;
      const c = { ...p };
      delete c[key];
      return c;
    });
    setRaws(next);
    setProjects(next.map((p) => ({ ...p })));
  };

  const save = async () => {
    if (!apiToken()) {
      setMsg({ text: "the edit needs the arbiter token — paste it in the header first", cls: "text-err" });
      return;
    }
    setSaving(true);
    setMsg({ text: "saving…", cls: "text-dim" });
    try {
      const restart = await writeLocalProjects(port, raws);
      setMsg({ text: restart ? "saved — restart the daemon to apply" : "saved", cls: "text-warn" });
    } catch (e) {
      setMsg({ text: `refused: ${(e as Error).message}`, cls: "text-err" });
    } finally {
      setSaving(false);
    }
  };

  const numField = (i: number, key: "estimated_seconds" | "timeout_seconds", label: string) => {
    const v = raws[i]?.[key];
    return (
      <label className="flex items-center gap-2">
        <span className="w-[130px] shrink-0 text-dim">{label}</span>
        <Input
          className="h-6 w-32 text-[12px]"
          type="number"
          min={1}
          step="any"
          value={typeof v === "number" ? v : ""}
          onChange={(e) => {
            const t = e.target.value.trim();
            if (t === "") clearField(i, key);
            else setField(i, key, Number(t));
          }}
        />
      </label>
    );
  };
  const strField = (i: number, key: "name" | "model" | "queue_file", label: string) => (
    <label className="flex items-center gap-2">
      <span className="w-[130px] shrink-0 text-dim">{label}</span>
      <Input
        className="h-6 w-full max-w-[360px] text-[12px]"
        type="text"
        value={typeof raws[i]?.[key] === "string" ? (raws[i][key] as string) : ""}
        onChange={(e) => setField(i, key, e.target.value)}
      />
    </label>
  );

  return (
    <Card className="py-0 shadow-none">
      <CardHeader className="flex-row items-center gap-2 px-4 py-2 pb-0">
        <CardTitle className="text-[12px] font-semibold">{name} · 127.0.0.1:{port}</CardTitle>
        <CardAction>
          <Button size="xs" variant="ghost" className="h-6 px-2 text-[11px]" onClick={toggle} title={`edit ${name}'s LOCAL project entries (client/config.json on this machine)`}>
            {open ? "close" : "edit"}
          </Button>
        </CardAction>
      </CardHeader>
      {open && (
        <CardContent className="flex flex-col gap-2 px-4 py-2.5">
          {loading && <div className="text-[12px] text-dim">reading client/config.json…</div>}
          {projects !== null && (
            <>
              {projects.map((p, i) => {
                const known = ["name", "model", "queue_file", "estimated_seconds", "timeout_seconds"];
                const extras = Object.keys(p).filter((k) => !known.includes(k));
                return (
                  <div key={i} className="flex flex-col gap-1.5">
                    <div className="text-[12px] font-semibold">{typeof p.name === "string" ? p.name : `project ${i + 1}`}</div>
                    <div className="flex flex-col gap-1.5">
                      {strField(i, "name", "name")}
                      {strField(i, "model", "model")}
                      {strField(i, "queue_file", "queue_file")}
                      {numField(i, "estimated_seconds", "estimated_seconds")}
                      {numField(i, "timeout_seconds", "timeout_seconds")}
                    </div>
                    {extras.length > 0 && (
                      <div className="text-[11px] text-dim" title={`these keys pass through untouched: ${extras.join(", ")}`}>
                        {extras.length} other key(s) preserved
                      </div>
                    )}
                    {i < projects.length - 1 && <Separator />}
                  </div>
                );
              })}
              <div className="flex items-center gap-2">
                <Button size="sm" className="h-6 text-[12px]" disabled={saving || projects.length === 0} onClick={() => void save()}>
                  {saving ? "saving…" : "save"}
                </Button>
                {msg && <span className={`text-[11px] ${msg.cls}`}>{msg.text}</span>}
              </div>
              <div className="text-[11px] text-dim">
                writes client/config.json on THIS machine through the local client (every other key, the token included, and the 0600 mode are preserved) — the daemon picks the changes up on its next start; restart it from the desktop app.
              </div>
            </>
          )}
        </CardContent>
      )}
    </Card>
  );
}
