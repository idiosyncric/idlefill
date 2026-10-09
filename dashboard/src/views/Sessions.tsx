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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Sparkline } from "@/components/Sparkline";
import { copyText } from "@/lib/clipboard";
import {
  apiToken,
  setSessionOverride,
  setSessionPin,
  type SessionRow,
  type StateSnapshot,
} from "@/lib/api";
import { ago, isOnline, sessGateLabelText, sessStateWord, sessStale } from "@/lib/format";

const TONE: Record<string, string> = {
  ok: "text-ok",
  warn: "text-warn",
  err: "text-err",
  accent: "text-accent",
  dim: "text-dim",
};

const MINT_KEY = "idlefill.mintedSessions";
const MODE_KEY = "idlefill.sessMode";

type MintedLine = { port: number; token: string };

function mintedLines(): Record<string, MintedLine[]> {
  try {
    const raw = localStorage.getItem(MINT_KEY);
    const obj = raw ? (JSON.parse(raw) as Record<string, MintedLine[]>) : {};
    return obj && typeof obj === "object" ? obj : {};
  } catch {
    return {};
  }
}
function saveMinted(obj: Record<string, MintedLine[]>) {
  try {
    localStorage.setItem(MINT_KEY, JSON.stringify(obj));
  } catch {
    /* private mode: lines just don't persist */
  }
}
function mintToken(): string {
  // <8 hex>-<4 hex>: path-safe, short enough to retype, unique enough here.
  const b = new Uint8Array(6);
  crypto.getRandomValues(b);
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return h.slice(0, 8) + "-" + h.slice(8);
}
function readMode(): "rows" | "flow" {
  const m = localStorage.getItem(MODE_KEY);
  return m === "flow" ? "flow" : "rows";
}

// #77: "open in the Hermes desktop" — navigate the page to hermes://open/<id>.
// The dashboard is the desktop's WKWebView over an external origin (no IPC), so
// a page navigation is the only lever: WKWebView hands the unregistered custom
// scheme to the OS, which routes it to the registered Hermes desktop app. The
// click is fail-quiet — a scheme nothing answers is a no-op.
function openInHermesDesktop(sessionId: string) {
  try {
    window.location.href = "hermes://open/" + encodeURIComponent(sessionId);
  } catch {
    /* fail-quiet: no handler registered for hermes:// on this platform */
  }
}

// The per-row open affordance, rendered right after the hermes chip. A row that
// carries a session id deep-links; a row without one renders the button
// disabled (wrapped in a span so the tooltip still fires on the
// pointer-events-none disabled Button — the shadcn sidebar workaround).
function HermesOpenButton({ sessionId }: { sessionId?: string }) {
  if (sessionId) {
    return (
      <Button
        size="xs"
        variant="outline"
        className="h-6 px-2 text-[11px]"
        title="open this session in the Hermes desktop (hermes://open/&lt;id&gt;)"
        onClick={() => openInHermesDesktop(sessionId)}
      >
        open
      </Button>
    );
  }
  return (
    <TooltipProvider delayDuration={0}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span>
            <Button size="xs" variant="outline" className="h-6 px-2 text-[11px]" disabled>
              open
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>
          this row carries no Hermes session id — nothing to open
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

// ---------------------------------------------------------------------------
// Sessions — interactive traffic the router self-registered (#32/#33).
// The router enforces admission; this view displays arbiter truth and offers
// the operator controls: the per-session gate (pause / force / clear) and
// the engine pin (standing routing choice). Rows mode is the dense ops view;
// flow is the glance view (sessions grouped by model, connectors to the
// engines they route to). The New session launcher (#43) mints page-local
// tokens — the arbiter never sees a mint until the session's first request.
// ---------------------------------------------------------------------------

export function Sessions({ st }: { st: StateSnapshot | null }) {
  const [mode, setMode] = React.useState<"rows" | "flow">(readMode);
  if (!st) {
    return (
      <section className="flex flex-col gap-3">
        <h2 className="text-[12px] font-semibold uppercase tracking-wide text-dim">Sessions</h2>
        <Card className="py-4 shadow-none">
          <CardContent className="px-4 text-[12px] text-dim">no sessions registered</CardContent>
        </Card>
      </section>
    );
  }
  const sessions = st.sessions ?? [];
  const hosted = (st.clients ?? []).filter((c) => c.proxy_port && isOnline(c.last_seen, st.now));

  const pickMode = (m: string) => {
    const next = m === "flow" ? "flow" : "rows";
    setMode(next);
    localStorage.setItem(MODE_KEY, next);
  };

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <h2 className="text-[12px] font-semibold uppercase tracking-wide text-dim">Sessions</h2>
        {sessions.length > 0 && (
          <Tabs value={mode} onValueChange={pickMode}>
            <TabsList className="h-7">
              <TabsTrigger value="rows" className="h-5 px-2 text-[11px]">
                rows
              </TabsTrigger>
              <TabsTrigger value="flow" className="h-5 px-2 text-[11px]">
                flow
              </TabsTrigger>
            </TabsList>
          </Tabs>
        )}
        <span className="ml-auto text-[11px] text-dim">
          {sessions.length} {sessions.length === 1 ? "session" : "sessions"} registered
        </span>
      </div>

      {sessions.length === 0 ? (
        <Card className="py-4 shadow-none">
          <CardContent className="px-4 text-[12px] text-dim">
            no sessions registered — a router registers one on its first <code>/s/&lt;token&gt;</code> request
          </CardContent>
        </Card>
      ) : mode === "flow" ? (
        <FlowView st={st} />
      ) : (
        <Card className="py-0 shadow-none">
          <CardContent className="flex flex-col gap-1.5 px-3 py-2.5">
            {sessions.map((s) => (
              <SessionRowView key={s.token} s={s} st={st} />
            ))}
          </CardContent>
        </Card>
      )}

      {hosted.length > 0 && <Launcher st={st} />}
    </section>
  );
}

// One session row: liveness dot, the short token handle (+ host + history
// facts), the exception tags (stale / forced / queued), the state word, the
// engine pin select, and the gate select.
function SessionRowView({ s, st }: { s: SessionRow; st: StateSnapshot }) {
  const now = st.now;
  const word = sessStateWord(s, now);
  const stale = sessStale(s, now);
  const shortTok = String(s.token ?? "").slice(0, 8);
  const queued = s.gate?.state === "queued";
  const gateNum = (v: number | undefined) => (Number.isFinite(v) ? Math.floor(v as number) : 0);
  const waiting = queued ? gateNum(s.gate?.waiting) : 0;
  const position = queued ? gateNum(s.gate?.position) : 0;
  const hist = s.history;
  const rpm = hist?.rpm;

  const setOverride = async (value: string) => {
    if (!apiToken()) {
      toast.error("needs the arbiter API token — paste it in the header first");
      return;
    }
    const ov = value === "paused" ? "pause" : value === "forced" ? "force" : null;
    try {
      await setSessionOverride(s.token, ov);
      toast.success(value === "running" ? `session ${shortTok} resumed` : `session ${shortTok} ${value.toLowerCase()}`);
    } catch (e) {
      toast.error(`gate refused: ${(e as Error).message}`);
    }
  };

  const setPin = async (value: string) => {
    if (!apiToken()) {
      toast.error("needs the arbiter API token — paste it in the header first");
      return;
    }
    const sid = value === "" ? null : value;
    try {
      await setSessionPin(s.token, sid);
      const row = (st.servers ?? []).find((r) => r.id === sid);
      toast.success(sid ? `session ${shortTok} pinned to ${row?.name ?? sid}` : `pin cleared for session ${shortTok}`);
    } catch (e) {
      toast.error(`pin refused: ${(e as Error).message}`);
    }
  };

  return (
    <div className={`flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-border bg-panel/50 px-2.5 py-1.5 ${stale ? "opacity-70" : ""}`}>
      <span
        className={`size-1.5 shrink-0 rounded-full ${stale ? "bg-border" : "bg-ok"}`}
        title={stale ? "stale (no heartbeat within 90s)" : "live (heartbeat within 90s)"}
      />
      <span
        className="min-w-[70px] font-mono text-[12px] font-semibold"
        title={`session ${s.token}${s.client_name ? " — registered by " + s.client_name : ""}`}
      >
        {shortTok}
      </span>
      {s.client_name && <span className="text-[11px] text-dim">{s.client_name}</span>}
      {hist?.model && (
        <Badge variant="outline" className="rounded-pill px-1.5 py-0 text-[10px] font-normal" title="last model this session negotiated (sniffed by the router)">
          {hist.model}
        </Badge>
      )}
      {hist?.tokens != null && hist.tokens > 0 && (
        <span className="text-[11px] text-dim" title="token total of the last usage chunk the router streamed for this session">
          {hist.tokens >= 1000 ? `${Math.round(hist.tokens / 100) / 10}k` : hist.tokens} tok
        </span>
      )}
      {rpm && rpm.some((v) => v > 0) && (
        <span title="requests/min, last 10 minutes">
          <Sparkline values={rpm} className="h-[14px] w-[70px] flex-none" />
        </span>
      )}
      <span className="text-[11px] text-dim" title="the newest request the router saw on this session">
        {s.last_activity != null ? `last request ${ago(now - s.last_activity)}` : "no requests yet"}
      </span>
      {s.session_id && (
        <span className="text-[11px] text-dim" title="hermes conversation id (X-Hermes-Session-Id)">
          hermes {String(s.session_id)}
        </span>
      )}
      <HermesOpenButton sessionId={s.session_id} />
      {s.server_id && !s.engine_pin && (
        <span className="text-[11px] text-dim" title="the engine this session routes to">
          → {serverName(st, s.server_id)}
        </span>
      )}
      {stale && (
        <Badge variant="outline" className="rounded-pill px-1.5 py-0 text-[10px] font-normal text-dim" title="no heartbeat from this session in the last 90s — the router may have dropped it">
          stale
        </Badge>
      )}
      {s.override?.override === "force" && (
        <Badge variant="outline" className="rounded-pill border-accent/50 px-1.5 py-0 text-[10px] font-normal text-accent" title="operator forced this session — the router admits it past the session slot cap until the override is cleared">
          forced
        </Badge>
      )}
      {queued && (
        <Badge
          variant="outline"
          className="rounded-pill px-1.5 py-0 text-[10px] font-normal"
          title={
            position > 0
              ? `position ${position} in the router's FIFO queue — held behind another session`
              : waiting > 1
                ? "held at the router behind another session"
                : "held at the router behind another session"
          }
        >
          {position > 0 ? `queued · #${position}` : waiting > 1 ? `queued · ${waiting} waiting` : "queued"}
        </Badge>
      )}
      <span className="ml-auto flex items-center gap-1.5">
        <span className={`text-[12px] font-semibold ${TONE[word.tone]}`} title={word.note}>
          {word.label}
        </span>
        <Select value={s.engine_pin ? s.engine_pin.server_id : s.server_id ?? ""} onValueChange={(v) => void setPin(v)}>
          <SelectTrigger
            size="sm"
            className="h-6 w-[130px] text-[11px]"
            title="engine pin — the standing routing choice (queued + next-request traffic moves; a running stream never does)"
          >
            <SelectValue placeholder="route" />
          </SelectTrigger>
          <SelectContent>
            {(st.servers ?? []).map((r) => (
              <SelectItem key={r.id} value={r.id} className="text-[11px]">
                {r.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={s.override?.override === "pause" ? "paused" : s.override?.override === "force" ? "forced" : "running"}
          onValueChange={(v) => void setOverride(v)}
        >
          <SelectTrigger size="sm" className="h-6 w-[118px] text-[11px]" title={`set gate for session ${shortTok}`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(["running", "paused", "forced"] as const).map((m) => (
              <SelectItem key={m} value={m} className="text-[11px]">
                {sessGateLabelText(m)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </span>
    </div>
  );
}

function serverName(st: StateSnapshot, id: string): string {
  return (st.servers ?? []).find((r) => r.id === id)?.name ?? id;
}

// ---------------------------------------------------------------------------
// The #67 flow view: the same published payload drawn as a live surface.
// Left: sessions grouped by the model name they ask for. Right: the engine
// rows with their load (counts read from the session rows — arbiter truth).
// A connector line ties each session to the engine it routes to; the pin
// select on each session row is the re-route (drag is the legacy affordance
// — the select carries the same write, POST /api/sessions/:token/pin).
// ---------------------------------------------------------------------------

function FlowView({ st }: { st: StateSnapshot }) {
  const rows = st.sessions ?? [];
  const engines = (st.servers ?? []).slice().sort((a, b) => a.name.localeCompare(b.name));

  type SessNode = { token: string; short: string; host: string; stale: boolean; group: string; target: string };
  const nodes: SessNode[] = [];
  const groups = new Map<string, SessNode[]>();
  for (const s of rows) {
    const g = s.history?.model ?? "(unseen model)";
    const target = s.engine_pin?.server_id ?? s.server_id ?? engines[0]?.id ?? "";
    const node: SessNode = {
      token: s.token,
      short: String(s.token ?? "").slice(0, 8),
      host: s.client_name ?? "unknown host",
      stale: sessStale(s, st.now),
      group: g,
      target,
    };
    nodes.push(node);
    const list = groups.get(g) ?? [];
    list.push(node);
    groups.set(g, list);
  }
  const groupNames = [...groups.keys()].sort((a, b) => a.localeCompare(b));

  const load = new Map<string, { active: number; queued: number }>();
  for (const e of engines) load.set(e.id, { active: 0, queued: 0 });
  for (const s of rows) {
    const t = s.engine_pin?.server_id ?? s.server_id ?? "";
    const l = load.get(t);
    if (!l) continue;
    if (s.gate?.state === "queued") l.queued += 1;
    else if (s.gate?.state === "active" || (s.last_activity != null && st.now - s.last_activity < 30_000)) l.active += 1;
  }

  return (
    <Card className="py-0 shadow-none">
      <CardContent className="grid grid-cols-2 gap-4 px-4 py-3">
        <div className="flex flex-col gap-2">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-dim">Sessions by model</div>
          {groupNames.map((g) => {
            const members = groups.get(g) ?? [];
            const perMachine = new Map<string, number>();
            for (const s of members) perMachine.set(s.host, (perMachine.get(s.host) ?? 0) + 1);
            const counts = [...perMachine.entries()].map(([m, n]) => `${m} ×${n}`).join(", ");
            return (
              <div key={g}>
                <div className="mb-0.5 text-[12px]">
                  <b>{g}</b> <span className="text-dim">— {counts}</span>
                </div>
                <div className="flex flex-col gap-0.5">
                  {members.map((s) => (
                    <div key={s.token} className={`flex items-center gap-2 text-[12px] ${s.stale ? "opacity-60" : ""}`}>
                      <span className={`size-1.5 rounded-full ${s.stale ? "bg-border" : "bg-ok"}`} />
                      <span className="font-mono text-[11px]">{s.short}</span>
                      <span className="text-[11px] text-dim">@{s.host}</span>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
        <div className="flex flex-col gap-2">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-dim">Inference engines</div>
          {engines.map((e) => {
            const l = load.get(e.id) ?? { active: 0, queued: 0 };
            const sig = e.signal;
            const sigWord = sig ? (sig.idle ? `idle ${sig.idle_for_s ?? "—"}s` : "busy") : "";
            return (
              <div key={e.id} className="flex items-center gap-2 text-[12px]">
                <span className={`size-1.5 rounded-full ${sig && !sig.idle ? "bg-ok" : "bg-border"}`} />
                <span className="font-semibold">{e.name}</span>
                <span className="ml-auto text-[11px] text-dim" title="sessions routing here: active / queued">
                  {l.active} act · {l.queued} q
                </span>
                {sigWord && <span className="text-[11px] text-dim">{sigWord}</span>}
              </div>
            );
          })}
          {engines.length === 0 && <div className="text-[12px] text-dim">no engines declared</div>}
        </div>
      </CardContent>
      <div className="border-t border-border px-4 py-1.5 text-[11px] text-dim">
        the pin select on a row (rows mode) re-routes a session — the agent never learns the engine changed
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// The session launcher (#43): mint a token, hand over the exact `/model …/s/
// <token>` line. The mint lives PAGE-side (crypto in the browser) — the
// arbiter never sees a token until the session's first request. Lines persist
// per client so the 5s refresh never wipes a line mid-paste.
// ---------------------------------------------------------------------------

function Launcher({ st }: { st: StateSnapshot }) {
  const [minted, setMinted] = React.useState<Record<string, MintedLine[]>>(mintedLines);
  const hosted = (st.clients ?? [])
    .filter((c) => c.proxy_port && isOnline(c.last_seen, st.now))
    .sort((a, b) => a.name.localeCompare(b.name));

  const commit = (next: Record<string, MintedLine[]>) => {
    setMinted(next);
    saveMinted(next);
  };

  const mint = (name: string, port: number) => {
    const next = { ...minted };
    const list = Array.isArray(next[name]) ? next[name].slice() : [];
    list.unshift({ port, token: mintToken() });
    next[name] = list.slice(0, 5); // the page keeps the newest five per machine
    commit(next);
  };
  const drop = (name: string, token: string) => {
    const next = { ...minted };
    next[name] = (Array.isArray(next[name]) ? next[name] : []).filter((l) => l.token !== token);
    commit(next);
  };
  const copyLine = (line: string) => {
    copyText(line).then((ok) => (ok ? toast.success("line copied") : toast.error("copy failed")));
  };

  return (
    <Card className="py-0 shadow-none">
      <CardHeader className="flex-row items-center gap-2 px-4 py-2 pb-0">
        <CardTitle className="text-[12px] font-semibold uppercase tracking-wide text-dim">New session</CardTitle>
        <CardAction>
          <span className="text-[11px] text-dim">the mint is page-local — the row appears on the session's first request</span>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 px-4 py-2.5">
        {hosted.map((c) => {
          const lines = Array.isArray(minted[c.name]) ? minted[c.name] : [];
          return (
            <div key={c.name} className="flex flex-col gap-1">
              <div className="flex items-center gap-2 text-[12px]">
                <span className="font-semibold">{c.name}</span>
                <span className="text-[11px] text-dim">127.0.0.1:{c.proxy_port}</span>
                <Button
                  size="xs"
                  variant="outline"
                  className="ml-auto h-6 px-2 text-[11px]"
                  onClick={() => mint(c.name, c.proxy_port!)}
                  title="mint a fresh session token for this machine's router"
                >
                  new session
                </Button>
              </div>
              {lines.map((l) => {
                const line = `/model http://127.0.0.1:${l.port}/s/${l.token}`;
                return (
                  <div key={l.token} className="flex items-center gap-2 pl-3 text-[12px]">
                    <code className="min-w-0 truncate">{line}</code>
                    <Button size="xs" variant="ghost" className="h-5 px-1.5 text-[10px]" onClick={() => copyLine(line)}>
                      copy
                    </Button>
                    <Button
                      size="xs"
                      variant="ghost"
                      className="h-5 px-1.5 text-[10px] text-dim"
                      title="forget this line (an already-started session keeps running)"
                      onClick={() => drop(c.name, l.token)}
                    >
                      ×
                    </Button>
                  </div>
                );
              })}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
