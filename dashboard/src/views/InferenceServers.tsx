import * as React from "react";
import { toast } from "sonner";
import {
  Card,
  CardHeader,
  CardTitle,
  CardAction,
  CardContent,
  CardFooter,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
import { Sparkline } from "@/components/Sparkline";
import {
  getState,
  getEngineMetrics,
  postServer,
  removeServer,
  putEngineGroup,
  apiToken,
  type ServerRow,
  type StateSnapshot,
  type MetricPoint,
  type EngineGroup,
} from "@/lib/api";
import { ago, fmt, liveWord, probeWord, PROVIDER_CHOICES } from "@/lib/format";
import { loadRead, LOAD_FRESHNESS_DEFAULT_S } from "@/lib/load-read";

const METRICS_24H = 24 * 3600_000; // the card's sparkline window
const TONE: Record<string, string> = {
  ok: "text-ok",
  warn: "text-warn",
  err: "text-err",
  accent: "text-accent",
  dim: "text-dim",
};

// ---------------------------------------------------------------------------
// Resources → Inference servers (the React rethink): one CARD per declared
// engine on the real shadcn registry primitives. Header: name + live state
// word + the action cluster (edit opens a Dialog, remove arms inline).
// Content: the models the engine ADVERTISES (the arbiter's /v1/models probe;
// model_source names where the list came from) as Badge chips, and the
// metrics as sparklines. Footer: the base URL + the last-seen line. Empty
// states everywhere the data is missing. Flat by default: tonal panel +
// hairline, zero shadow (the DESIGN.md posture, carried by the token map).
// ---------------------------------------------------------------------------

export function InferenceServers({ st }: { st: StateSnapshot | null }) {
  const [editId, setEditId] = React.useState<string | null>(null);
  const [adding, setAdding] = React.useState(false);
  const [metrics, setMetrics] = React.useState<Record<string, MetricPoint[]>>({});

  const servers = st?.servers ?? [];
  const groups = st?.engine_groups ?? [];
  const srvName = React.useCallback(
    (id: string) => servers.find((s) => s.id === id)?.name ?? id,
    [servers],
  );
  const runningAnywhere = React.useMemo(() => {
    const active = new Set((st?.active_leases ?? []).map((l) => l.server_id ?? "srv-watched"));
    return active;
  }, [st]);

  // The group a row belongs to (D3), from the per-row ADD key the server
  // view publishes. null = the row is in no group.
  const groupOfRow = (s: ServerRow) =>
    s.group_id ? groups.find((g) => g.group_id === s.group_id) ?? null : null;

  // Per-card engine metrics, 60s cadence (hour buckets do not need the
  // 5s tick). Exception-only: a store without points leaves the empty
  // state standing.
  React.useEffect(() => {
    if (servers.length === 0) return;
    let alive = true;
    const pull = async () => {
      const now = Date.now();
      const from = now - METRICS_24H;
      try {
        const pulls = await Promise.all(servers.map((s) => getEngineMetrics(s.id, from, now)));
        if (!alive) return;
        const byId: Record<string, MetricPoint[]> = {};
        servers.forEach((s, i) => (byId[s.id] = pulls[i]));
        setMetrics(byId);
      } catch {
        /* store unreachable: the cards keep their empty state */
      }
    };
    pull();
    const id = setInterval(pull, 60_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
    // servers identity changes every poll tick; the pull itself is 60s.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [servers.map((s) => s.id).join(",")]);

  const requireToken = (): boolean => {
    if (apiToken()) return true;
    toast.error("needs the arbiter API token — paste it in the header first");
    return false;
  };

  // Move one row to a group (D3, one row per group). gid null = remove the
  // row from its group. A row already in ANOTHER group is refused by the
  // server at the second write, so: ungroup from the old group FIRST (if any),
  // then rewrite the new group with the row. A failure at either write toasts
  // the reason; the 5s tick re-renders from truth.
  const changeRowGroup = async (s: ServerRow, gid: string | null) => {
    if (!requireToken()) return;
    const current = s.group_id ?? null;
    if (gid === current) return; // no-op
    try {
      if (current) {
        const oldG = groups.find((g) => g.group_id === current);
        if (oldG) {
          const rest = oldG.server_ids.filter((x) => x !== s.id);
          // A non-empty remainder is a valid re-write (a one-member group is
          // legal; the remainder keeps the row's peers).
          if (rest.length > 0) await putEngineGroup({ group_id: current, server_ids: rest });
        }
      }
      if (gid) {
        const target = groups.find((g) => g.group_id === gid);
        const members = target ? target.server_ids : [];
        if (!members.includes(s.id)) await putEngineGroup({ group_id: gid, server_ids: [...members, s.id] });
      }
      toast.success(gid ? `${s.name} → group ${gid}` : `${s.name}: removed from its group`);
      void getState().catch(() => undefined);
    } catch (e) {
      toast.error(`group change refused: ${(e as Error).message}`);
    }
  };

  return (
    <section>
      <div className="flex items-center gap-3 mb-3">
        <h2 className="text-[12px] font-semibold uppercase tracking-wide text-dim">Inference servers</h2>
        <Button
          size="sm"
          variant="outline"
          className="ml-auto h-6 text-[12px]"
          onClick={() => {
            if (requireToken()) setAdding(true);
          }}
        >
          + add server
        </Button>
      </div>

      <GroupPanel
        groups={groups}
        servers={servers}
        srvName={srvName}
        requireToken={requireToken}
        onSaved={() => void getState().catch(() => undefined)}
      />

      {servers.length === 0 ? (
        <div className="border border-border bg-card px-4 py-8 text-center text-[12px] text-dim">
          no servers declared — add one
        </div>
      ) : (
        <div className="grid gap-2.5 [grid-template-columns:repeat(auto-fit,minmax(280px,1fr))]">
          {servers.map((s) => (
            <ServerCard
              key={s.id}
              s={s}
              now={st?.now ?? Date.now()}
              running={runningAnywhere.has(s.id)}
              points={metrics[s.id] ?? []}
              staleS={st?.metrics_load_stale_s ?? LOAD_FRESHNESS_DEFAULT_S}
              group={groupOfRow(s)}
              groups={groups}
              srvName={srvName}
              requireToken={requireToken}
              onGroupPick={(gid) => void changeRowGroup(s, gid)}
              onEdit={() => {
                if (requireToken()) setEditId(s.id);
              }}
            />
          ))}
        </div>
      )}

      <ServerFormDialog
        open={adding}
        onOpenChange={setAdding}
        server={null}
        onSaved={() => {
          toast.success("server added");
          void getState().catch(() => undefined); // the 5s tick refreshes anyway
        }}
      />
      <ServerFormDialog
        open={editId !== null}
        onOpenChange={(o) => !o && setEditId(null)}
        server={servers.find((x) => x.id === editId) ?? null}
        onSaved={() => toast.success("server updated")}
      />
    </section>
  );
}

// ---------------------------------------------------------------------------
// The engine-group plane (D3/D5): a named cross-row group = same-host mutual
// exclusion. Each group lists its members, its group-wide lease cap
// (max_concurrent, default 1), and a live delete. A row belongs to at most one
// group, so the "add" form offers each row a checkbox and a row already in
// another group is simply unavailable here (the per-row picker on the card is
// the move path). Writes go through POST /api/engine-groups (the alias
// authoring posture: 400 told, one event, 0600 save).
// ---------------------------------------------------------------------------

function GroupPanel({
  groups,
  servers,
  srvName,
  requireToken,
  onSaved,
}: {
  groups: EngineGroup[];
  servers: ServerRow[];
  srvName: (id: string) => string;
  requireToken: () => boolean;
  onSaved: () => void;
}) {
  const [adding, setAdding] = React.useState(false);
  const [newId, setNewId] = React.useState("");
  const [newName, setNewName] = React.useState("");
  const [picked, setPicked] = React.useState<string[]>([]);

  // A row already claimed by another group is unavailable in a NEW group
  // (one row per group; the per-row picker on the card is the move path).
  const available = servers.filter((s) => !s.group_id);

  const create = async () => {
    if (!requireToken()) return;
    const id = newId.trim();
    if (!id) {
      toast.error("a group id is required (a stable slug, printable, ≤128 chars)");
      return;
    }
    if (picked.length === 0) {
      toast.error("pick at least one member row");
      return;
    }
    try {
      await putEngineGroup({
        group_id: id,
        ...(newName.trim() ? { name: newName.trim() } : {}),
        server_ids: picked,
      });
      toast.success(`group ${id} created`);
      setAdding(false);
      setNewId("");
      setNewName("");
      setPicked([]);
      onSaved();
    } catch (e) {
      toast.error(`create refused: ${(e as Error).message}`);
    }
  };

  const togglePick = (id: string) =>
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  return (
    <section className="mb-3">
      <div className="flex items-center gap-3 mb-2">
        <h2 className="text-[12px] font-semibold uppercase tracking-wide text-dim">Engine groups</h2>
        <Button
          size="sm"
          variant="outline"
          className="ml-auto h-6 text-[12px]"
          onClick={() => {
            if (requireToken()) setAdding((a) => !a);
          }}
        >
          {adding ? "cancel" : "+ add group"}
        </Button>
      </div>

      <p className="mb-2 text-[11px] text-dim">
        a group = same-host mutual exclusion: the group-wide lease cap bounds background work across its
        members (cap 1 = at most one running at a time). A row belongs to at most one group.
      </p>

      {adding && (
        <Card className="mb-2 py-0 shadow-none">
          <CardContent className="flex flex-col gap-2 px-3 py-2">
            <div className="flex items-center gap-2">
              <span className="w-16 shrink-0 text-[11px] text-dim">id</span>
              <Input
                className="h-7 w-52 text-[12px]"
                value={newId}
                onChange={(e) => setNewId(e.target.value)}
                placeholder="host-urza"
                maxLength={128}
              />
              <span className="w-16 shrink-0 text-[11px] text-dim">label</span>
              <Input
                className="h-7 flex-1 text-[12px]"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="urza"
              />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {available.map((s) => (
                <label key={s.id} className="flex items-center gap-1.5 text-[11px]">
                  <input
                    type="checkbox"
                    checked={picked.includes(s.id)}
                    onChange={() => togglePick(s.id)}
                    title={s.url}
                  />
                  {s.name}
                </label>
              ))}
              {available.length === 0 && (
                <span className="text-[11px] text-dim">every row is already in a group</span>
              )}
              <Button size="sm" variant="outline" className="h-7 ml-auto text-[12px]" onClick={() => void create()}>
                create
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {groups.length === 0 && !adding ? (
        <div className="border border-border bg-card px-4 py-4 text-center text-[12px] text-dim">
          no groups — “+ add group” declares same-host mutual exclusion over one or more rows
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {groups.map((g) => (
            <GroupRow key={g.group_id} g={g} srvName={srvName} requireToken={requireToken} onSaved={onSaved} />
          ))}
        </div>
      )}
    </section>
  );
}

// One group row: label (rename on a click), members, the live cap, and delete.
function GroupRow({
  g,
  srvName,
  requireToken,
  onSaved,
}: {
  g: EngineGroup;
  srvName: (id: string) => string;
  requireToken: () => boolean;
  onSaved: () => void;
}) {
  const [cap, setCap] = React.useState(String(g.max_concurrent));
  const [label, setLabel] = React.useState(g.name ?? "");

  const writeCap = async () => {
    const n = parseInt(cap, 10);
    if (!Number.isInteger(n) || n < 1) {
      toast.error("cap must be a positive integer (1 = at most one at a time)");
      setCap(String(g.max_concurrent));
      return;
    }
    if (n === g.max_concurrent) return;
    if (!requireToken()) return;
    try {
      await putEngineGroup({ group_id: g.group_id, max_concurrent: n });
      toast.success(`${g.name ?? g.group_id}: cap → ${n}`);
      onSaved();
    } catch (e) {
      toast.error(`cap write refused: ${(e as Error).message}`);
    }
  };

  const writeLabel = async () => {
    if (label.trim() === (g.name ?? "")) return;
    if (!requireToken()) return;
    try {
      await putEngineGroup({ group_id: g.group_id, name: label.trim() });
      onSaved();
    } catch (e) {
      toast.error(`label write refused: ${(e as Error).message}`);
    }
  };

  const del = async () => {
    if (!requireToken()) return;
    if (!window.confirm(`delete the group ${g.name ?? g.group_id}? its rows stay declared and ungrouped`)) return;
    try {
      await putEngineGroup({ group_id: g.group_id, delete: true });
      toast.success(`group ${g.name ?? g.group_id} deleted`);
      onSaved();
    } catch (e) {
      toast.error(`delete refused: ${(e as Error).message}`);
    }
  };

  return (
    <Card className="gap-0 py-0 shadow-none">
      <CardContent className="flex items-center gap-2 px-3 py-2 text-[12px]">
        <Input
          className="h-6 w-40 text-[12px]"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          onBlur={() => void writeLabel()}
          onKeyDown={(e) => e.key === "Enter" && void writeLabel()}
          placeholder={g.group_id}
          title="display label (the id is the stable slug)"
        />
        <code className="min-w-0 truncate text-[11px] text-dim" title="the group id (stable slug — the write handle)">
          {g.group_id}
        </code>
        <span className="flex min-w-0 flex-wrap items-center gap-1" title="members — a row belongs to at most one group">
          {g.server_ids.map((id) => (
            <Badge key={id} variant="outline" className="rounded-pill px-1.5 py-0 text-[10px] font-normal text-dim">
              {srvName(id)}
            </Badge>
          ))}
        </span>
        <label className="ml-auto flex items-center gap-1.5 text-[11px] text-dim" title="group-wide lease cap — at most this many background jobs across all members at once">
          cap
          <Input
            className="h-6 w-14 text-center text-[12px]"
            value={cap}
            onChange={(e) => setCap(e.target.value)}
            onBlur={() => void writeCap()}
            onKeyDown={(e) => e.key === "Enter" && void writeCap()}
          />
        </label>
        <Button size="xs" variant="outline" className="h-6 px-2 text-[11px]" onClick={() => void del()}>
          delete
        </Button>
      </CardContent>
    </Card>
  );
}

function ServerCard({
  s,
  now,
  running,
  points,
  staleS,
  group,
  groups,
  srvName,
  requireToken,
  onGroupPick,
  onEdit,
}: {
  s: ServerRow;
  now: number;
  running: boolean;
  points: MetricPoint[];
  staleS: number;
  group: EngineGroup | null;
  groups: EngineGroup[];
  srvName: (id: string) => string;
  requireToken: () => boolean;
  onGroupPick: (gid: string | null) => void;
  onEdit: () => void;
}) {
  const word = s.watched
    ? liveWord({ idle: !!s.signal?.idle, degraded: !!s.signal?.degraded }, running || s.models.some((m) => m.running))
    : liveWord(null, false);
  const probe = probeWord(s.model_source);
  // The LOAD axis (#52 slice 2): the captured measurement beside the idle
  // verdict. A SEPARATE line — the idle word is the verdict, the load read
  // is the measurement (two axes, never merged into one word). Absent read
  // (load_source missing) = null = render nothing.
  const load = loadRead(s.signal, staleS);
  const [armed, setArmed] = React.useState(false);
  const armTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(
    () => () => {
      if (armTimer.current) clearTimeout(armTimer.current);
    },
    [],
  );

  const onRemove = async () => {
    if (!armed) {
      setArmed(true);
      armTimer.current = setTimeout(() => setArmed(false), 4000);
      return;
    }
    setArmed(false);
    try {
      await removeServer(s.id);
      toast.success(`removed ${s.name}`);
    } catch (e) {
      toast.error(`remove refused: ${(e as Error).message}`);
    }
  };

  return (
    <Card className="gap-0 py-0 shadow-none">
      <CardHeader className="flex-row items-center gap-2 px-3 py-2 pb-0">
        <CardTitle className="text-[13px] font-semibold">{s.name}</CardTitle>
        <span className={`text-[12px] font-semibold ${TONE[word.tone]}`} title={word.note}>
          {word.label}
        </span>
        {/* The routing-health dot (D5 display): the liveness axis beside the
            idle word. Green = the /v1/models probe answered (routing green),
            red = the probe never answered (the declared list stands). The
            idle word is the separate activity axis and stays unchanged. */}
        <span
          className={`size-1.5 shrink-0 rounded-full ${probe.tone === "ok" ? "bg-ok" : "bg-err"}`}
          title={probe.note}
        />
        {/* The LOAD axis (#52 slice 2): the captured engine load read beside
            the idle word. A measurement, not a verdict — it sits on its own
            line beside (never inside) the idle word, so a busy engine and an
            idle verdict never blur into one word. Exception-only: no load
            read = nothing renders here; a stale read (load_age_s above the
            configured freshness window) dims, the values still show. */}
        {load && (
          <span
            className={`min-w-0 truncate text-[11px] text-dim ${load.stale ? "opacity-60" : ""}`}
            title={
              load.stale
                ? `engine load read — ${load.source} · STALE: older than ${staleS}s (the values may be out of date)`
                : `engine load read — ${load.source}${load.parts.length > 0 ? `: ${load.parts.join(" · ")}` : ""}`
            }
          >
            {load.source}
            {load.parts.length > 0 ? ` · ${load.parts.join(" · ")}` : ""}
          </span>
        )}
        {s.engaged && (
          <Badge variant="outline" className="shrink-0 rounded-pill border-accent/50 px-1.5 py-0 text-[10px] font-normal text-accent" title="an active lease or session holds an engine slot on this row">
            engaged
          </Badge>
        )}
        <CardAction className="gap-1.5">
          <Button size="xs" variant="ghost" className="h-6 px-2 text-[11px]" onClick={onEdit}>
            edit
          </Button>
          <Button
            size="xs"
            variant={armed ? "destructive" : "outline"}
            className="h-6 px-2 text-[11px]"
            onClick={() => void onRemove()}
            title="remove this server from the declared inventory"
          >
            {armed ? "confirm?" : "remove"}
          </Button>
        </CardAction>
      </CardHeader>

      <CardContent className="px-3 py-2 flex flex-col gap-2">
        <ModelList s={s} now={now} />
        <Separator />
        <MetricRows points={points} />
      </CardContent>

      <CardFooter className="flex-col items-stretch gap-1.5 px-3 py-1.5 text-[11px] text-dim">
        <div className="flex items-center justify-between gap-3">
          <code className="truncate" title="base url — edit to change">{s.url}</code>
          <span className="whitespace-nowrap">{lastSeen(s, now)}</span>
        </div>
        {/* The group picker (D3): a row belongs to at most one group. "no
            group" removes it; picking another group moves it (ungroup from
            the old, rewrite the new). The one-row-per-group rule means a row
            already in another group is refused by the second write. */}
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-dim">group</span>
          <Select
            value={s.group_id ?? ""}
            onValueChange={(v) => {
              if (requireToken()) onGroupPick(v === "" ? null : v);
            }}
          >
            <SelectTrigger size="sm" className="h-6 w-full text-[11px]" title="same-host mutual exclusion group (the group-wide lease cap)">
              <SelectValue placeholder="no group" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="" className="text-[11px]">no group</SelectItem>
              {groups.map((g) => (
                <SelectItem key={g.group_id} value={g.group_id} className="text-[11px]">
                  {g.name ?? g.group_id} · cap {g.max_concurrent}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {group && (
            <span className="shrink-0 whitespace-nowrap text-[10px] text-dim" title={`group ${group.group_id}: members ${group.server_ids.map((id) => srvName(id)).join(", ")}; max_concurrent ${group.max_concurrent}`}>
              cap {group.max_concurrent}
            </span>
          )}
        </div>
      </CardFooter>
    </Card>
  );
}

function ModelList({ s, now }: { s: ServerRow; now: number }) {
  if (s.models.length === 0) {
    const seen =
      s.probed_at != null ? ` — probe last answered ${ago(now - s.probed_at)}` : " — probe never answered";
    return <div className="text-[11px] text-dim">no models seen{seen}</div>;
  }
  return (
    <div className="flex flex-wrap gap-1">
      {s.models.map((m) => (
        <Badge
          key={m.name}
          variant="outline"
          title={s.model_source === "probed" ? "advertised via /v1/models" : "operator-declared (the probe never answered)"}
          className="max-w-full gap-1.5 rounded-pill px-2 py-0 text-[11px] font-normal"
        >
          {m.running && <span className="size-1.5 rounded-full bg-accent" title="a lease is running on this model" />}
          <span className="truncate">{m.name}</span>
        </Badge>
      ))}
      {s.model_source === "declared" && (
        <span className="self-center text-[10px] text-dim" title="the /v1/models probe never answered for this row">
          declared, not probed{s.probed_at === null ? "" : ` · last probe ${ago(now - s.probed_at)}`}
        </span>
      )}
    </div>
  );
}

function MetricRows({ points }: { points: MetricPoint[] }) {
  if (points.length === 0) {
    return <div className="text-[11px] text-dim">no metrics yet — the store fills as the engine runs</div>;
  }
  const reqs = points.map((p) => p.req_total ?? 0);
  const tok = points.map((p) => p.engine_tokens_out ?? p.tokens_out ?? 0);
  const last = (a: number[]) => a[a.length - 1];
  return (
    <div className="flex flex-col gap-1">
      <MetricRow k="req / hr" values={reqs} value={fmt(last(reqs))} title="requests per hour, last 24h" />
      <MetricRow k="tokens / hr" values={tok} value={fmt(last(tok))} title="output tokens per hour, last 24h" />
    </div>
  );
}

function MetricRow({ k, values, value, title }: { k: string; values: number[]; value: string; title: string }) {
  return (
    <div className="flex items-center gap-2 text-[11px]" title={title}>
      <span className="min-w-[84px] shrink-0 text-dim">{k}</span>
      <Sparkline values={values} />
      <span className="ml-auto whitespace-nowrap">{value}</span>
    </div>
  );
}

function lastSeen(s: ServerRow, now: number): string {
  if (s.probed_at != null) return `models last seen ${ago(now - s.probed_at)}`;
  if (s.watched) return "watched since declared · model list unverified";
  return "never seen";
}

// ---------------------------------------------------------------------------
// The add/edit dialog: name, base URL, provider kind, API key (write-only:
// set/clear/absent — never a read-back), fallback models. Talks to
// POST /api/servers (upsert).
// ---------------------------------------------------------------------------

function ServerFormDialog({
  open,
  onOpenChange,
  server,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  server: ServerRow | null;
  onSaved: () => void;
}) {
  const editing = server !== null;
  const [name, setName] = React.useState("");
  const [url, setUrl] = React.useState("");
  const [provider, setProvider] = React.useState("llama-swap");
  const [keyDraft, setKeyDraft] = React.useState("");
  const [clearKey, setClearKey] = React.useState(false);
  const [models, setModels] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  // Re-arm the fields each time the dialog opens.
  React.useEffect(() => {
    if (!open) return;
    setName(server?.name ?? "");
    setUrl(server?.url ?? "");
    setProvider(server?.provider ?? "llama-swap");
    setKeyDraft("");
    setClearKey(false);
    setModels((server?.models ?? []).map((m) => m.name).join(", "));
    setErr(null);
  }, [open, server]);

  const colocation =
    provider === "omlx" && /^https?:\/\/(?!127\.|localhost)/.test(url)
      ? "oMLX reads a local log file and a local sqlite store — it cannot work across the network. Run the arbiter on that machine for this kind."
      : null;

  const save = async () => {
    setSaving(true);
    setErr(null);
    try {
      const body: Record<string, unknown> = {
        ...(editing ? { id: server.id } : {}),
        name: name.trim(),
        url: url.trim(),
        provider,
        models: models
          .split(",")
          .map((m) => m.trim())
          .filter(Boolean),
      };
      if (keyDraft.trim()) body.auth_token = keyDraft.trim();
      else if (clearKey) body.auth_token = "";
      await postServer(body as never);
      onSaved();
      onOpenChange(false);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md font-mono text-[12px]">
        <DialogHeader>
          <DialogTitle className="text-[13px]">{editing ? `edit ${server?.name}` : "add a server"}</DialogTitle>
          <DialogDescription className="text-[11px]">
            the declared inventory: one entry per inference engine the gate may run work on.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-dim">name</span>
            <Input className="h-7 text-[12px]" value={name} onChange={(e) => setName(e.target.value)} placeholder="llama-swap" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-dim">url (http or https)</span>
            <Input className="h-7 text-[12px]" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://100.105.225.1:11434" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-dim">provider kind</span>
            <Select value={provider} onValueChange={setProvider}>
              <SelectTrigger size="sm" className="w-full h-7 text-[12px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PROVIDER_CHOICES.map(([v, label]) => (
                  <SelectItem key={v} value={v} className="text-[12px]">
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          {colocation && <div className="border border-warn/40 bg-warn/10 px-2 py-1.5 text-[11px] text-warn">{colocation}</div>}
          <label className="flex flex-col gap-1">
            <span className="text-dim">
              API key{server?.auth_set ? " (one is stored — type to replace, leave empty to keep)" : " (stored on the arbiter only)"}
            </span>
            <Input
              type="password"
              className="h-7 text-[12px]"
              value={keyDraft}
              onChange={(e) => setKeyDraft(e.target.value)}
              placeholder="optional — sent as Authorization: Bearer only to this engine"
            />
            {server?.auth_set && (
              <label className="flex items-center gap-1.5 text-[11px] text-dim">
                <input type="checkbox" checked={clearKey} onChange={(e) => setClearKey(e.target.checked)} />
                remove the stored key
              </label>
            )}
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-dim">models, comma separated (the fallback list if /v1/models never answers)</span>
            <Input className="h-7 text-[12px]" value={models} onChange={(e) => setModels(e.target.value)} placeholder="Qwen3-32B, Qwen3-8B" />
          </label>
          {err && <div className="border border-err/40 bg-err/10 px-2 py-1.5 text-[11px] text-err">{err}</div>}
        </div>
        <DialogFooter>
          <Button size="sm" variant="outline" className="h-7 text-[12px]" onClick={() => onOpenChange(false)}>
            cancel
          </Button>
          <Button size="sm" className="h-7 text-[12px]" disabled={saving || !name.trim() || !url.trim()} onClick={() => void save()}>
            {saving ? "saving…" : editing ? "save changes" : "add server"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
