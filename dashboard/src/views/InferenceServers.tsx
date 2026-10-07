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
  apiToken,
  type ServerRow,
  type StateSnapshot,
  type MetricPoint,
} from "@/lib/api";
import { ago, fmt, liveWord, PROVIDER_CHOICES } from "@/lib/format";

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
  const runningAnywhere = React.useMemo(() => {
    const active = new Set((st?.active_leases ?? []).map((l) => l.server_id ?? "srv-watched"));
    return active;
  }, [st]);

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

function ServerCard({
  s,
  now,
  running,
  points,
  onEdit,
}: {
  s: ServerRow;
  now: number;
  running: boolean;
  points: MetricPoint[];
  onEdit: () => void;
}) {
  const word = s.watched
    ? liveWord({ idle: !!s.signal?.idle, degraded: !!s.signal?.degraded }, running || s.models.some((m) => m.running))
    : liveWord(null, false);
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

      <CardFooter className="justify-between gap-3 px-3 py-1.5 text-[11px] text-dim">
        <code className="truncate" title="base url — edit to change">{s.url}</code>
        <span className="whitespace-nowrap">{lastSeen(s, now)}</span>
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
