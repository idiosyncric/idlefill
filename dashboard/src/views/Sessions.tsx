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
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Sparkline } from "@/components/Sparkline";
import { Skeleton } from "@/components/ui/skeleton";
import { copyText } from "@/lib/clipboard";
import {
  apiToken,
  getAliases,
  setSessionOverride,
  setSessionPin,
  getSessionTranscript,
  readLocalHermesTranscript,
  patchLocalHermesLifecycle,
  type AliasRow,
  type HermesLifecyclePatch,
  type HermesTranscriptMessage,
  type HermesTranscriptPage,
  type SessionRow,
  type SessionTranscript,
  type StateSnapshot,
} from "@/lib/api";
import { ago, durFmt, fmt, isOnline, liveWord, sessGateLabelText, sessStateWord, sessStale } from "@/lib/format";
import { engineEdge, type EngineEdge } from "@/lib/session-edge";
import { sessionTiles } from "@/lib/session-stats";
import { flowPipePath, pipeClass, pipeEdge, pipeTitle, type PipeEdge } from "@/lib/pipe-phases";
import { foreignActivity, sessionCardFacts, type SessionCardFacts } from "@/lib/flow-cards";
import { StatTiles, TilesSkeleton } from "@/components/stat-tiles";

const TONE: Record<string, string> = {
  ok: "text-ok",
  warn: "text-warn",
  err: "text-err",
  accent: "text-accent",
  dim: "text-dim",
};

const MINT_KEY = "idlefill.mintedSessions";
const MODE_KEY = "idlefill.sessMode";

// Tile tooltips — same order as lib/session-stats.ts sessionTiles().
const SESSION_TILE_TITLES = [
  "sessions the routers self-registered — a router registers one on its first request",
  "sessions the router gate holds behind another session's slot",
  "sessions under an operator pause override — the router holds their traffic",
  "rows whose 90 s heartbeat lapsed — the router may have dropped them",
];

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
// #78: the session viewer — a Sheet that shows the ROUTER's read-only view of
// one session's requests (request time + the model + streamed token total the
// router observed, plus the 60s request buckets). It is NOT a chat reader: the
// router only ever saw timing + a sniffed model + a token total, never the
// conversation, so the panel says so plainly and shows exactly that and nothing
// more. Data: GET /api/sessions/<token>/transcript (arbiter → client proxy).
//
// #85 slice A adds the REAL conversation below it, but ONLY when the row
// carries a Hermes session id AND the owning client's loopback daemon is
// online: the page fetches GET http://127.0.0.1:<proxy_port>/client/hermes-
// transcript/<session_id>?offset=…&limit=… ON-DEMAND (viewer open, one
// bounded page per click — never bulk-polled, never through the arbiter).
// ---------------------------------------------------------------------------

const CONVO_PAGE = 50;

// The owning client's loopback proxy port for a session row — the #85
// transcript is read over loopback ONLY, so the panel needs the client that
// hosts the session to be online and to have reported a proxy_port.
function hostProxyPort(st: StateSnapshot, s: SessionRow): number | undefined {
  if (!s.client_id) return undefined;
  const c = (st.clients ?? []).find((x) => x.client_id === s.client_id);
  if (!c || !c.proxy_port) return undefined;
  if (!isOnline(c.last_seen, st.now)) return undefined;
  return c.proxy_port;
}

// ---------------------------------------------------------------------------
// #85 slice G: the row's lifecycle controls — rename + pin, wired to the
// OWNING client's loopback route (PATCH /client/hermes-lifecycle/<id>,
// edit-token guarded). The scope law: these fire ONLY on a deliberate click.
// Nothing here calls them automatically (no timer, no refresh hook), one
// click sends exactly ONE PATCH (the buttons are disabled while in flight),
// and a refusal is NEVER retried — the toast carries the NAMED refusal
// reason verbatim ("session_not_found — no hermes profile holds session…").
// The verb's payload never touches the arbiter: the client daemon proxies it
// straight to the gateway and publishes nothing.
//
// WHICH FIELDS: `title` and `pinned` are the issue's named row UX.
// archived / hidden / unread stay API-only on purpose — the Sessions list is
// arbiter truth, not the Hermes desktop sidebar, so a hidden/archived row
// would keep showing here regardless and the flag would be an invisible
// no-op on this page; inventing chrome for it was explicitly out of scope.
// The client route allow-lists all five, so a future slice can surface them
// without a wire change.
// ---------------------------------------------------------------------------

function LifecycleControls({ st, s }: { st: StateSnapshot; s: SessionRow }) {
  const sessionId = s.session_id;
  const port = hostProxyPort(st, s);
  const shortTok = String(s.token ?? "").slice(0, 8);
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  // The Hermes flag is never published, so the page cannot OBSERVE it — it
  // remembers only what THIS page did (first click pins, the next unpins).
  // A pin over an already-pinned row is a gateway no-op, so a page-local
  // guess can never corrupt the row.
  const [pinnedHere, setPinnedHere] = React.useState(false);

  if (!sessionId) return null;

  const run = async (body: HermesLifecyclePatch, onOk: (profile: string) => void) => {
    if (!port || busy) return;
    setBusy(true);
    try {
      const r = await patchLocalHermesLifecycle(port, sessionId, body);
      onOk(r.profile);
    } catch (e) {
      // Verbatim: the message already reads "<named reason> — <refusal detail>".
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const commitRename = () => {
    const t = draft.trim().slice(0, 256);
    if (t === "") return; // an empty draft is a no-op, never a write
    void run({ title: t }, (profile) => {
      toast.success(`session ${shortTok} renamed over loopback (profile ${profile})`);
      setEditing(false);
      setDraft("");
    });
  };

  const togglePin = () => {
    const next = !pinnedHere;
    void run({ pinned: next }, (profile) => {
      setPinnedHere(next);
      toast.success(`session ${shortTok} ${next ? "pinned" : "unpinned"} over loopback (profile ${profile})`);
    });
  };

  if (editing) {
    return (
      <span className="flex items-center gap-1">
        <Input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitRename();
            else if (e.key === "Escape") {
              setEditing(false);
              setDraft("");
            }
          }}
          placeholder="new title (Enter writes, Esc cancels)"
          maxLength={256}
          disabled={busy}
          className="h-6 w-[190px] text-[11px]"
        />
        <Button
          size="xs"
          variant="outline"
          className="h-6 px-2 text-[11px]"
          disabled={busy || draft.trim() === ""}
          onClick={commitRename}
          title="PATCH /api/sessions/<id> {title} over the owning client's loopback — one click, one write, never retried"
        >
          {busy ? "writing…" : "save"}
        </Button>
        <Button
          size="xs"
          variant="ghost"
          className="h-6 px-1.5 text-[10px] text-dim"
          onClick={() => {
            setEditing(false);
            setDraft("");
          }}
          title="discard (nothing was sent)"
        >
          ×
        </Button>
      </span>
    );
  }

  if (!port) {
    // Honest disabled state: no Hermes id would be hidden above; a live
    // loopback port is the only way this verb can fire (never relayed
    // through the arbiter).
    return (
      <TooltipProvider delayDuration={0}>
        <Tooltip>
          <TooltipTrigger asChild>
            <span>
              <Button size="xs" variant="outline" className="h-6 px-2 text-[11px]" disabled>
                rename
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent>
            the owning client has no live loopback port — lifecycle writes go over loopback only, never through the arbiter
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  return (
    <span className="flex items-center gap-1">
      <Button
        size="xs"
        variant="outline"
        className="h-6 px-2 text-[11px]"
        disabled={busy}
        onClick={() => setEditing(true)}
        title="rename this Hermes session (PATCH {title} to the gateway over the owning client's loopback)"
      >
        rename
      </Button>
      <Button
        size="xs"
        variant={pinnedHere ? "outline" : "ghost"}
        className={`h-6 px-2 text-[11px] ${pinnedHere ? "text-accent" : "text-dim"}`}
        disabled={busy}
        onClick={togglePin}
        title={
          pinnedHere
            ? "unpin this Hermes session (the page remembers only what it clicked — Hermes' current flag is never published; a pin over an already-pinned row is a no-op)"
            : "pin this Hermes session in its desktop sidebar (PATCH {pinned:true} over loopback — one click, one write, never retried)"
        }
      >
        {pinnedHere ? "unpin" : "pin"}
      </Button>
    </span>
  );
}

// One conversation message row: role chip, content (capped server-side),
// tool name / tool calls, token count, timestamp.
function ConvoMessageRow({ m, i }: { m: HermesTranscriptMessage; i: number }) {
  const role = m.role ?? "?";
  const roleTone = role === "user" ? "text-accent" : role === "assistant" ? "text-ok" : "text-dim";
  return (
    <div className="flex flex-col gap-1 rounded-md border border-border bg-panel/50 px-2.5 py-1.5 text-[12px]">
      <div className="flex items-center gap-2">
        <span className={`font-mono font-semibold ${roleTone}`}>{role}</span>
        {m.timestamp != null && (
          <span className="font-mono text-[10px] text-dim" title="the ledger's message timestamp">
            {new Date(m.timestamp).toLocaleTimeString([], { hour12: false })}
          </span>
        )}
        {typeof m.token_count === "number" && (
          <span className="text-[10px] text-dim" title="token_count recorded for this message">
            {m.token_count >= 1000 ? `${Math.round(m.token_count / 100) / 10}k` : m.token_count} tok
          </span>
        )}
        {m.finish_reason && (
          <Badge variant="outline" className="rounded-pill px-1.5 py-0 text-[10px] font-normal text-dim" title="finish_reason">
            {m.finish_reason}
          </Badge>
        )}
      </div>
      {m.content && (
        <p className="whitespace-pre-wrap break-words text-[11px] leading-relaxed text-foreground/85">
          {m.content}
          {m.content_truncated && <span className="text-dim"> …[capped]</span>}
        </p>
      )}
      {m.tool_name && (
        <span className="text-[10px] text-dim font-mono" title="tool this message names">
          tool: {m.tool_name}
        </span>
      )}
      {m.tool_calls?.length && (
        <div className="flex flex-wrap gap-1.5">
          {m.tool_calls.map((c, j) => (
            <Badge key={`${i}-${j}`} variant="outline" className="rounded-pill px-1.5 py-0 text-[10px] font-normal text-dim" title="tool call">
              call {c.name}
            </Badge>
          ))}
          {m.tool_calls_truncated && <span className="text-[10px] text-dim">…calls capped</span>}
        </div>
      )}
    </div>
  );
}

// The on-demand Hermes conversation: page fetched when the sheet opens,
// "older page" button walks offset forward, bounded per page by the client.
function ConvoPanel({ port, sessionId }: { port: number; sessionId: string }) {
  const [page, setPage] = React.useState<HermesTranscriptPage | null>(null);
  const [messages, setMessages] = React.useState<HermesTranscriptMessage[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [loadingMore, setLoadingMore] = React.useState(false);

  React.useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    setMessages([]);
    readLocalHermesTranscript(port, sessionId, 0, CONVO_PAGE)
      .then((p) => {
        if (!live) return;
        setPage(p);
        setMessages(p.messages);
      })
      .catch((e) => {
        if (live) setError((e as Error).message);
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [port, sessionId]);

  const loadMore = async () => {
    if (!page) return;
    setLoadingMore(true);
    try {
      const next = await readLocalHermesTranscript(port, sessionId, page.next_offset, CONVO_PAGE);
      setPage(next);
      setMessages((prev) => [...prev, ...next.messages]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between text-[11px] text-dim">
        <span>
          the real conversation (gateway ledger, profile <code>{page?.profile ?? "?"}</code>) — fetched on-demand over loopback, never via the arbiter
        </span>
      </div>

      {loading && <div className="text-[12px] text-dim">loading the conversation…</div>}

      {!loading && error && (
        <div className="flex flex-col gap-1 text-[12px] text-err">
          <span className="font-semibold">conversation unavailable</span>
          <span className="text-dim">{error}</span>
        </div>
      )}

      {!loading && !error && messages.length === 0 && (
        <div className="rounded-md border border-border bg-panel/50 px-3 py-2 text-[12px] text-dim">
          the gateway reports no messages for this session id
        </div>
      )}

      {messages.map((m, i) => <ConvoMessageRow key={m.id ?? `page-${page?.offset ?? 0}-${i}`} m={m} i={i} />)}

      {page?.has_more && !error && (
        <Button size="xs" variant="outline" className="h-7 px-3 text-[11px]" onClick={loadMore} disabled={loadingMore}>
          {loadingMore ? "loading…" : `older messages (offset ${page.next_offset})`}
        </Button>
      )}
      {page && !page.has_more && messages.length > 0 && (
        <div className="text-[10px] text-dim">end of the fetched page — {messages.length} message(s) loaded</div>
      )}
    </div>
  );
}

function TranscriptSheet({
  token,
  title,
  onClose,
  sessionId,
  proxyPort,
}: {
  token: string;
  title: string;
  onClose: () => void;
  sessionId?: string;
  proxyPort?: number;
}) {
  const [data, setData] = React.useState<SessionTranscript | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    getSessionTranscript(token)
      .then((t) => {
        if (live) setData(t);
      })
      .catch((e) => {
        if (live) setError((e as Error).message);
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [token]);

  const requests = data?.requests ?? [];
  const buckets = data?.buckets ?? [];
  const totalRequests = requests.length;
  const anyTokens = requests.some((r) => typeof r.tokens === "number");
  const anyModel = requests.some((r) => Boolean(r.model));

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className="w-[min(440px,92vw)] gap-0">
        <SheetHeader className="border-b border-border px-4 py-3">
          <SheetTitle className="font-mono text-[13px]">{title}</SheetTitle>
          <SheetDescription className="text-[11px] leading-relaxed text-dim">
            the router&apos;s view, not the full conversation — what the router observed per
            request (time, model, streamed token total), never the messages
          </SheetDescription>
        </SheetHeader>

        <div className="flex flex-col gap-3 overflow-y-auto px-4 py-3">
          {loading && (
            <div className="text-[12px] text-dim">loading the router&apos;s view…</div>
          )}

          {!loading && error && (
            <div className="flex flex-col gap-1 text-[12px] text-err">
              <span className="font-semibold">transcript unavailable</span>
              <span className="text-dim">{error}</span>
              <span className="text-dim">
                the router that owns this session may be offline, or it reports no
                loopback port the arbiter can reach.
              </span>
            </div>
          )}

          {!loading && !error && (
            <>
              {/* Honest state: a 502 is shown above; an empty ring is the
                  honest "no requests the router saw". */}
              {totalRequests === 0 ? (
                <div className="flex flex-col gap-1 rounded-md border border-border bg-panel/50 px-3 py-3 text-[12px] text-dim">
                  <span className="font-semibold text-foreground/80">no requests in the router&apos;s ring</span>
                  <span>
                    the router has recorded no traffic for this token — the ring is
                    in-memory, so a daemon restart starts it empty.
                  </span>
                </div>
              ) : (
                <>
                  <div className="flex items-center justify-between text-[11px] text-dim">
                    <span>
                      {totalRequests} request{totalRequests === 1 ? "" : "s"} the router observed
                      {anyTokens ? " · token totals" : ""}
                      {anyModel ? " · model" : ""}
                    </span>
                  </div>

                  <div className="flex flex-col gap-1">
                    {requests.map((r, i) => (
                      <div
                        key={`${r.at}-${i}`}
                        className="flex items-center gap-2 rounded-md border border-border bg-panel/50 px-2.5 py-1.5 text-[12px]"
                      >
                        <span className="font-mono tabular-nums" title="when the router saw this request">
                          {new Date(r.at).toLocaleTimeString([], { hour12: false })}
                        </span>
                        <span className="text-dim">{ago(Date.now() - r.at)}</span>
                        <span className="ml-auto flex items-center gap-2">
                          {typeof r.tokens === "number" && (
                            <span className="text-dim" title="last total_tokens the router saw streaming on this session">
                              {r.tokens >= 1000 ? `${Math.round(r.tokens / 100) / 10}k` : r.tokens} tok
                            </span>
                          )}
                          {r.model && (
                            <Badge variant="outline" className="rounded-pill px-1.5 py-0 text-[10px] font-normal" title="last model the router sniffed on this session">
                              {r.model}
                            </Badge>
                          )}
                        </span>
                      </div>
                    ))}
                  </div>

                  {buckets.length > 0 && (
                    <div className="mt-1 flex items-center gap-2 text-[11px] text-dim">
                      <span>requests / min, last 10 min</span>
                      <Sparkline values={buckets} className="h-[16px] w-[90px] flex-none" />
                    </div>
                  )}
                </>
              )}
            </>
          )}

          {/* #85 slice A: the REAL conversation, on-demand from the owning
              client's loopback daemon. Only rendered when the row carries a
              Hermes session id and that client reports a live proxy port. */}
          {sessionId && proxyPort ? (
            <div className="mt-2 flex flex-col gap-2 border-t border-border pt-3">
              <ConvoPanel port={proxyPort} sessionId={sessionId} />
            </div>
          ) : sessionId ? (
            <div className="mt-2 border-t border-border pt-3 text-[11px] text-dim">
              the owning client reports no loopback port — the conversation can only be
              read over loopback, so this page cannot reach it.
            </div>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
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
        <TilesSkeleton cols={4} />
        <Skeleton className="h-24 rounded-lg" />
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
      <StatTiles
        cols={4}
        tiles={sessionTiles(sessions, st.now).map((tile, i) => ({
          label: ["Sessions", "At the gate", "Paused", "Stale"][i],
          title: SESSION_TILE_TITLES[i],
          tile,
        }))}
      />
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
  const [viewOpen, setViewOpen] = React.useState(false);
  const [rerouteOpen, setRerouteOpen] = React.useState(false);
  // The D4 session→engine edge: the engine row this session routes through
  // (the operator pin wins once one stands), read through lib/session-edge.
  // Exception-only honesty: a healthy unpinned row renders byte-for-byte as
  // before — the annotation and the warn tone appear only when the engine
  // row names a fact (queue > 0, a stale sample, a degraded/no-signal
  // posture) and the gate says the session is ACTIVE.
  const edgeTarget = s.engine_pin?.server_id ?? s.server_id ?? null;
  const edgeSignal = edgeTarget ? ((st.servers ?? []).find((r) => r.id === edgeTarget)?.signal ?? null) : null;
  const edge = engineEdge(s, edgeSignal);
  const edgeTitle = [
    "the engine this session routes to",
    edge.pinned ? "operator pin — lands at release time" : null,
    edge.slow ? `slow: ${edge.slowReasons.join("; ")} (sample age at the arbiter's snapshot)` : null,
  ]
    .filter(Boolean)
    .join(" — ");
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
        title={`session ${s.token}${s.hermes_meta?.title ? ` — “${s.hermes_meta.title}”` : ""}${s.client_name ? " — registered by " + s.client_name : ""}`}
      >
        {shortTok}
      </span>
      {s.client_name && <span className="text-[11px] text-dim">{s.client_name}</span>}
      {/* The agent this session belongs to (owner ask 2026-10-12): the
          connector's provenance stamp names which Hermes profile's ledger
          the router READ this session's row from — exact, never inferred.
          Absent stamp (old client / ledger miss) = nothing renders. */}
      {s.hermes_meta?.profile && (
        <span
          className="text-[11px] text-dim"
          title="the agent profile that owns this session — provenance: the profile ledger the gateway row was read from (exact, never inferred)"
        >
          @{s.hermes_meta.profile}
        </span>
      )}
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
      <LifecycleControls st={st} s={s} />
      <Button
        size="xs"
        variant="ghost"
        className="h-6 px-2 text-[11px] text-dim"
        title="view the router's observed requests for this session (the router's view, not the conversation)"
        onClick={() => setViewOpen(true)}
      >
        view
      </Button>
      {viewOpen && (
        <TranscriptSheet
          token={s.token}
          title={`session ${shortTok} — router's view`}
          onClose={() => setViewOpen(false)}
          sessionId={s.session_id}
          proxyPort={hostProxyPort(st, s)}
        />
      )}
      {edge.target && (
        <span className={`text-[11px] ${edge.slow ? "text-warn" : "text-dim"}`} title={edgeTitle}>
          → {serverName(st, edge.target)}
          {edge.annotation ? ` · ${edge.annotation}` : ""}
        </span>
      )}
      {edge.slow && (
        <Button
          size="xs"
          variant="outline"
          className="h-6 border-warn/50 px-2 text-[11px] text-warn"
          title={`the engine behind this session looks slow — ${edge.slowReasons.join("; ")} — pick one of the model's alias pairs (the EXISTING engine-pin write; lands at release time, a running stream never moves)`}
          onClick={() => {
            if (!apiToken()) {
              toast.error("needs the arbiter API token — paste it in the header first");
              return;
            }
            setRerouteOpen(true);
          }}
        >
          re-route…
        </Button>
      )}
      {rerouteOpen && <RerouteChooser st={st} s={s} onClose={() => setRerouteOpen(false)} />}
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
            (() => {
              const parts: string[] = [];
              if (position > 0) parts.push(`position ${position} in the router's FIFO queue`);
              const heldFor =
                s.gate?.waitSince != null ? `held ${ago(now - (s.gate!.waitSince as number))}` : null;
              if (heldFor) parts.push(`${heldFor} at the gate`);
              parts.push(
                `held ${waiting > 1 ? `${waiting} request(s) ` : ""}behind another session — the operator can release the hold (pause ⇒ the turn stops stalling, answered "held by gate", retry in ~15s)`,
              );
              return parts.join(" · ");
            })()
          }
        >
          {(() => {
            const base = position > 0 ? `#${position}` : waiting > 1 ? `${waiting} waiting` : "";
            const heldFor = s.gate?.waitSince != null ? ` · ${ago(now - (s.gate!.waitSince as number))}` : "";
            return `queued${base ? ` · ${base}` : ""}${heldFor}`;
          })()}
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
// D4 re-route: the pair chooser over the session model's alias pairs — the
// verbatim GET /api/aliases rows (the same token-gated authoring read the
// Models tab uses), posting the EXISTING engine-pin write
// (POST /api/sessions/:token/pin { server_id } — server/src/api.ts, landing
// on arbiter.setSessionPin: an alias session may only be pinned to one of
// its alias's pair rows, exactly what this chooser lists). The pin applies
// through the existing release-time resolver (queued + next-request traffic
// moves; a running stream never does). NO optimistic state: the 5s poll
// refresh shows the row's engine_pin. A model with no alias pairs is REFUSED
// BY NAME; clearing the pin is offered because the same route supports it
// (server_id: null). Zero new server surface, zero new credential plane.
// ---------------------------------------------------------------------------

function RerouteChooser({ st, s, onClose }: { st: StateSnapshot; s: SessionRow; onClose: () => void }) {
  const shortTok = String(s.token ?? "").slice(0, 8);
  const model = typeof s.history?.model === "string" && s.history.model !== "" ? s.history.model : null;
  const current = s.engine_pin?.server_id ?? null;
  const [rows, setRows] = React.useState<AliasRow[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    let live = true;
    getAliases()
      .then((a) => live && setRows(a))
      .catch((e) => live && setError((e as Error).message));
    return () => {
      live = false;
    };
  }, []);

  const aliasRow = rows !== null && model !== null ? (rows.find((a) => a.alias === model) ?? null) : null;
  const pairs = aliasRow?.pairs ?? null;

  const post = async (server_id: string | null) => {
    if (busy) return;
    setBusy(true);
    try {
      await setSessionPin(s.token, server_id);
      toast.success(
        server_id
          ? `session ${shortTok} pinned to ${serverName(st, server_id)} — lands at release (a running stream never moves)`
          : `pin cleared for session ${shortTok}`,
      );
      onClose(); // the poll refresh shows the pin — nothing is faked in-page
    } catch (e) {
      toast.error(`pin refused: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md font-mono text-[12px]">
        <DialogHeader>
          <DialogTitle className="text-[13px]">re-route session {shortTok}</DialogTitle>
          <DialogDescription className="text-[11px]">
            the engine behind this session looks slow. Picking a pair posts the EXISTING engine-pin write — the
            standing choice lands at release time (queued + next-request traffic moves; a running stream never
            does). The row updates on the next poll; nothing is shown optimistically.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          {rows === null && error === null && <div className="text-[11px] text-dim">reading the alias pairs…</div>}
          {error !== null && <div className="text-[11px] text-err">aliases read failed: {error}</div>}
          {rows !== null && model === null && (
            <div className="text-[11px] text-dim">
              the router has not sniffed a model for this session yet — the pair list is model-scoped, so there is
              nothing to choose by name.
            </div>
          )}
          {rows !== null && model !== null && aliasRow === null && (
            <div className="text-[11px] text-dim">
              no alias is declared for <code>{model}</code> — nothing to re-route between. A bare name routes to the
              row that carries it (the rows-mode pin select names any row that serves it).
            </div>
          )}
          {pairs !== null && (
            <div className="flex flex-col gap-1">
              {pairs.map((p, i) => {
                const isCurrent = current !== null && p.server_id === current;
                return (
                  <div key={`${p.server_id}/${p.model}-${i}`} className="flex items-center gap-2 text-[12px]">
                    <span
                      className={`size-1.5 shrink-0 rounded-full ${p.source === "probed" ? "bg-ok" : p.source === "dropped" ? "bg-err" : "bg-warn"}`}
                      title={`pair source: ${p.source}`}
                    />
                    <span className="min-w-0 truncate">{serverName(st, p.server_id)}</span>
                    <span className="min-w-0 truncate text-[11px] text-dim" title="the EXACT model id this row serves">
                      {p.model}
                    </span>
                    <Button
                      size="xs"
                      variant={isCurrent ? "ghost" : "outline"}
                      className="ml-auto h-6 px-2 text-[11px]"
                      disabled={busy || isCurrent}
                      onClick={() => void post(p.server_id)}
                      title={`pin ${serverName(st, p.server_id)} for this session — POST /api/sessions/<token>/pin {server_id} (a mismatch pair is still a legal pin target — the pin is the operator's override)`}
                    >
                      {isCurrent ? "current" : "pin"}
                    </Button>
                  </div>
                );
              })}
            </div>
          )}
          {s.engine_pin && (
            <div className="flex items-center gap-2 border-t border-border pt-2 text-[11px] text-dim">
              pinned to {serverName(st, s.engine_pin.server_id)}
              <Button
                size="xs"
                variant="outline"
                className="ml-auto h-6 px-2 text-[11px]"
                disabled={busy}
                onClick={() => void post(null)}
                title="clear the pin — the same route with server_id: null (the session routes by the alias winner again)"
              >
                clear pin
              </Button>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// The #67 flow view, #74-ported: the same published payload drawn as a live
// surface. Left: sessions as compact cards (agent profile, session id, age,
// model, engine-reported rates, ledger Ctx/Turns) grouped by the model name
// they ask for. Right: the engine rows as cards with their load (counts read
// from the session rows — arbiter truth). The GRID stays the functional
// surface — the D4 edge labels and exception annotations render exactly as
// before, and the pin select on the rows-mode row is the re-route (the same
// write, POST /api/sessions/:token/pin). Orthogonal SVG connectors (session→
// engine, #67-style) paint on top, phase-colored by the pure mapping in
// lib/pipe-phases.ts, anchored to the CARD borders so every pipe visibly
// meets the card it names — not the far corner of a column-wide text row.
// NEW: the "Outside idlefill" cards — engines whose own status names more
// in-flight requests than the router holds are carrying conversations that
// never registered a session; detected by pure arithmetic in lib/flow-cards.ts.
// The SVG is aria-hidden decoration carrying the SAME tooltip text as the grid
// edge; the card text already carries everything a screen reader needs.
// Geometry is measured from the rendered DOM on each poll — zero new network
// calls.
// ---------------------------------------------------------------------------

const cssSafe = (s: string) => String(s).replace(/[^a-zA-Z0-9_-]/g, "_");

type PipePath = { token: string; d: string; cls: string; title: string; ex: number; ey: number };

function FlowView({ st }: { st: StateSnapshot }) {
  const rows = st.sessions ?? [];
  const engines = (st.servers ?? []).slice().sort((a, b) => a.name.localeCompare(b.name));

  type SessNode = {
    token: string;
    short: string;
    sid: string | null;
    host: string;
    stale: boolean;
    group: string;
    target: string;
    edge: EngineEdge;
    pipe: PipeEdge;
    engineName: string;
    facts: SessionCardFacts;
  };
  const nodes: SessNode[] = [];
  const groups = new Map<string, SessNode[]>();
  for (const s of rows) {
    const g = s.history?.model ?? s.hermes_meta?.model ?? "(unseen model)";
    const target = s.engine_pin?.server_id ?? s.server_id ?? engines[0]?.id ?? "";
    const edgeSignal =
      (st.servers ?? []).find((r) => r.id === (s.engine_pin?.server_id ?? s.server_id ?? ""))?.signal ?? null;
    const edge = engineEdge(s, edgeSignal);
    const node: SessNode = {
      token: s.token,
      short: String(s.token ?? "").slice(0, 8),
      sid: s.session_id ?? null,
      host: s.client_name ?? "unknown host",
      stale: sessStale(s, st.now),
      group: g,
      target,
      edge,
      pipe: pipeEdge(s, edge, st.now),
      engineName: engines.find((e) => e.id === edge.target)?.name ?? edge.target ?? "",
      facts: sessionCardFacts(s, edgeSignal, st.now),
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

  // "Outside idlefill": an engine whose OWN status names more in-flight work
  // than the router holds is carrying conversations that never registered a
  // /s/<token> session. Pure arithmetic on the payload already in hand — the
  // kinds with no in-flight axis (llama-swap) never produce a row.
  const foreign = foreignActivity(st, engines);

  // The connector geometry: measure the rendered cards, draw the pipes. Runs
  // after each render of this view (the 5s poll re-runs it); no fetch, no
  // timers — pure DOM arithmetic on the state already in hand. The anchors
  // are the CARD borders, so every pipe visibly meets the card it names.
  const boxRef = React.useRef<HTMLDivElement | null>(null);
  const [paths, setPaths] = React.useState<PipePath[]>([]);
  React.useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const b = box.getBoundingClientRect();
    if (b.width === 0 || b.height === 0) return;
    const out: PipePath[] = [];
    for (const n of nodes) {
      if (!n.edge.target || !engines.some((e) => e.id === n.edge.target)) continue; // fail-quiet: no edge row, no pipe
      const sEl = box.querySelector(`[data-flow-node="sess:${cssSafe(n.token)}"]`);
      const eEl = box.querySelector(`[data-flow-node="engine:${cssSafe(n.edge.target)}"]`);
      if (!sEl || !eEl) continue; // engine row vanished mid-render: no pipe, no crash
      const sr = sEl.getBoundingClientRect();
      const er = eEl.getBoundingClientRect();
      const x1 = sr.right - b.left + 2;
      const y1 = (sr.top + sr.bottom) / 2 - b.top;
      const x2 = er.left - b.left - 2;
      const y2 = (er.top + er.bottom) / 2 - b.top;
      out.push({
        token: n.token,
        d: flowPipePath(x1, y1, x2, y2, 10),
        cls: pipeClass(n.pipe),
        title: pipeTitle(n.short, n.engineName, n.edge, n.pipe),
        ex: x2,
        ey: y2,
      });
    }
    for (const f of foreign) {
      const sEl = box.querySelector(`[data-flow-node="foreign:${cssSafe(f.engineId)}"]`);
      const eEl = box.querySelector(`[data-flow-node="engine:${cssSafe(f.engineId)}"]`);
      if (!sEl || !eEl) continue;
      const sr = sEl.getBoundingClientRect();
      const er = eEl.getBoundingClientRect();
      const x1 = sr.right - b.left + 2;
      const y1 = (sr.top + sr.bottom) / 2 - b.top;
      const x2 = er.left - b.left - 2;
      const y2 = (er.top + er.bottom) / 2 - b.top;
      out.push({
        token: `foreign:${f.engineId}`,
        d: flowPipePath(x1, y1, x2, y2, 10),
        cls: pipeClass({ phase: "base", dashed: false, animated: false, muted: true, reason: "outside idlefill" }),
        title:
          f.evidence === "conversation_cache"
            ? `engine ${serverName(st, f.engineId)} is PARKING ${f.parkedConversations} conversation caches; ${f.attributed} belong to registered sessions — ${f.foreign} conversation${f.foreign === 1 ? "" : "s"} the router never registered`
            : `engine ${serverName(st, f.engineId)} carries ${f.foreign} request${f.foreign === 1 ? "" : "s"} the router never registered — the engine names ${f.inFlight} in-flight, ${f.attributed} belong to idlefill sessions`,
        ex: x2,
        ey: y2,
      });
    }
    setPaths(out);
  }, [st]);

  return (
    <Card className="py-0 shadow-none">
      {/* The wide column gutter is the #67 connector lane — the grid columns
          keep their content, only the space between them grows so the pipes
          have a legible run (the legacy flow view used a 120px gutter). */}
      <CardContent ref={boxRef} className="relative grid grid-cols-2 gap-14 px-4 py-3">
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
                <div className="flex flex-col gap-1">
                  {members.map((s) => (
                    <div
                      key={s.token}
                      data-flow-node={`sess:${cssSafe(s.token)}`}
                      className={`flex max-w-[360px] flex-col gap-0.5 rounded-md border border-border bg-panel px-2 py-1.5 ${s.stale ? "opacity-60" : ""}`}
                    >
                      {/* header: the session's identity — id, owning agent
                          profile (exact provenance, never inferred), age. */}
                      <div className="flex items-center gap-1.5 text-[11px]">
                        <span
                          className={`size-1.5 shrink-0 rounded-full ${s.stale ? "bg-border" : "bg-ok"}`}
                          title={s.stale ? "stale (no heartbeat within 90s)" : "live (heartbeat within 90s)"}
                        />
                        <span
                          className="font-mono font-semibold"
                          title={`session ${s.token}${s.sid ? ` — hermes ${s.sid}` : ""}`}
                        >
                          {s.short}
                        </span>
                        <span
                          className="text-[10px] text-dim"
                          title={s.facts.profile ? "the agent profile that owns this session — provenance: the profile ledger the gateway row was read from (exact, never inferred)" : "the client this session registered from — no profile provenance reported"}
                        >
                          {s.facts.profile ? `agent ${s.facts.profile}` : `@${s.host}`}
                        </span>
                        <span className="ml-auto text-[10px] text-dim" title="session age at the arbiter — since its first registered request">
                          {durFmt(s.facts.ageS)}
                        </span>
                      </div>
                      {/* the model it asks for, plus the engine's OWN reported
                          rates (since-boot averages — labelled as such). */}
                      <div className="flex flex-wrap items-center gap-x-1.5 text-[11px]">
                        <span>{s.group}</span>
                        {s.facts.genTps != null && (
                          <span className="text-[10px] text-dim" title="the engine's own reported average decode rate (since-boot average from its status read)">
                            ≈{fmt(Math.round(s.facts.genTps))} t/s
                          </span>
                        )}
                        {s.facts.prefillTps != null && (
                          <span className="text-[10px] text-dim" title="the engine's own reported average prompt-eval (prefill) rate (since-boot)">
                            ≈{fmt(Math.round(s.facts.prefillTps))} t/s prefill
                          </span>
                        )}
                      </div>
                      {(s.facts.ctx != null || s.facts.turns != null || s.facts.cachePct != null) && (
                        <div className="flex flex-wrap gap-x-1.5 text-[10px] text-dim">
                          {s.facts.ctx != null && (
                            <span title="input tokens recorded for this session in the gateway ledger">Ctx: {fmt(s.facts.ctx)}</span>
                          )}
                          {s.facts.turns != null && (
                            <span title="messages recorded for this session in the gateway ledger">Turns: {fmt(s.facts.turns)}</span>
                          )}
                          {s.facts.cachePct != null && (
                            <span title="KV-cache hit ratio reported by the engine itself (since boot) — engine-level, not per-session">Cache: {s.facts.cachePct}% hit</span>
                          )}
                        </div>
                      )}
                      {/* D4: the labelled session→engine edge (no graph
                          library — the engine column carries the posture
                          word). Warn = the slow heuristic fired. The SVG
                          pipe on this card carries the identical title. */}
                      {s.edge.target && (
                        <span
                          className={`text-[10px] ${s.edge.slow ? "text-warn" : "text-dim"}`}
                          title={pipeTitle(s.short, s.engineName, s.edge, s.pipe)}
                        >
                          → {s.engineName || s.edge.target}
                          {s.edge.annotation ? ` · ${s.edge.annotation}` : ""}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
          {foreign.length > 0 && (
            <div className="flex flex-col gap-1">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-dim">Outside idlefill</div>
              {foreign.map((f) => (
                <div
                  key={f.engineId}
                  data-flow-node={`foreign:${cssSafe(f.engineId)}`}
                  className="flex max-w-[360px] flex-col gap-0.5 rounded-md border border-dashed border-border bg-panel px-2 py-1.5"
                >
                  <div className="flex items-center gap-1.5 text-[11px]">
                    <span className="size-1.5 shrink-0 rounded-full bg-warn" title={f.evidence === "conversation_cache" ? "the engine's conversation cache names parked conversations the router never registered" : "the engine's own status names live traffic the router never registered"} />
                    <span>{f.foreign} conversation{f.foreign === 1 ? "" : "s"} outside the router</span>
                    <span className="ml-auto text-[10px] text-dim">→ {serverName(st, f.engineId)}</span>
                  </div>
                  <div
                    className="text-[10px] text-dim"
                    title={
                      f.evidence === "conversation_cache"
                        ? `the engine parks ${fmt(f.parkedConversations!)} conversation KV caches; ${fmt(f.attributed)} of them belong to sessions this view sees — the rest are conversations aimed straight at the engine, never through a /s/<token> session. ceiling honesty: a session whose cache was evicted is invisible to the engine's count`
                        : `the engine's status reports more in-flight requests than idlefill sessions hold — the remainder is direct traffic aimed at the engine, never seen by any /s/<token> session`
                    }
                  >
                    {f.evidence === "conversation_cache"
                      ? `${fmt(f.parkedConversations!)} parked caches · ${fmt(f.attributed)} attributable to sessions${f.inFlight != null && f.inFlight > 0 ? ` · ${fmt(f.inFlight)} generating` : ""}`
                      : `engine names ${fmt(f.inFlight!)} in-flight · ${fmt(f.attributed)} idlefill`}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="flex flex-col gap-2">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-dim">Inference engines</div>
          {engines.map((e) => {
            const l = load.get(e.id) ?? { active: 0, queued: 0 };
            const sig = e.signal;
            const w = liveWord(sig ? { idle: sig.idle, degraded: sig.degraded } : null, l.active > 0);
            return (
              <div
                key={e.id}
                data-flow-node={`engine:${cssSafe(e.id)}`}
                className="flex flex-col gap-0.5 rounded-md border border-border bg-panel px-2 py-1.5"
              >
                <div className="flex items-center gap-1.5 text-[11px]">
                  <span
                    className={`size-1.5 shrink-0 rounded-full ${sig?.degraded ? "bg-err" : sig ? (sig.idle ? "bg-border" : "bg-accent") : "bg-border"}`}
                    title={`${e.name}: ${w.label}`}
                  />
                  <span className="font-semibold">{e.name}</span>
                  <span className="ml-auto text-[10px] text-dim" title="sessions routing here: active / queued">
                    {l.active} act · {l.queued} q
                  </span>
                  <span className={`whitespace-nowrap text-[10px] font-semibold ${TONE[w.tone]}`} title={w.note}>
                    {w.label}
                    {sig?.idle && sig.idle_for_s != null ? ` · ${durFmt(sig.idle_for_s)}` : ""}
                  </span>
                </div>
                {(sig?.cache_efficiency != null || sig?.avg_generation_tps != null || sig?.avg_prefill_tps != null || sig?.conv_cache_parked != null) && (
                  <div className="flex flex-wrap gap-x-1.5 text-[10px] text-dim">
                    {typeof sig?.conv_cache_parked === "number" && (
                      <span title={`the engine parks conversation KV caches between requests: ${fmt(sig.conv_cache_parked)} parked of ${sig.conv_cache_slots != null ? fmt(sig.conv_cache_slots) : "?"} slots (${fmt(sig.conv_cache_parks ?? 0)} parks, ${fmt(sig.conv_cache_restores ?? 0)} restores, ${fmt(sig.conv_cache_evictions ?? 0)} evictions)`}>
                        conversations: {fmt(sig.conv_cache_parked)} parked{sig.conv_cache_slots != null ? ` / ${fmt(sig.conv_cache_slots)}` : ""}
                      </span>
                    )}
                    {typeof sig?.cache_efficiency === "number" && sig.cache_efficiency <= 1 && (
                      <span title="KV-cache hit ratio, the engine's own reported number (since boot)">KV cache: {Math.round(sig.cache_efficiency * 100)}% hit</span>
                    )}
                    {typeof sig?.avg_generation_tps === "number" && (
                      <span title="average decode rate the engine reports (since-boot average)">≈{fmt(Math.round(sig.avg_generation_tps))} t/s gen</span>
                    )}
                    {typeof sig?.avg_prefill_tps === "number" && (
                      <span title="average prompt-eval (prefill) rate the engine reports (since-boot average)">≈{fmt(Math.round(sig.avg_prefill_tps))} t/s prefill</span>
                    )}
                  </div>
                )}
              </div>
            );
          })}
          {engines.length === 0 && <div className="text-[12px] text-dim">no engines declared</div>}
        </div>
        {/* LAST child, as in #67: the pipes paint above the node chrome. */}
        <svg className="flow-pipes" aria-hidden="true">
          {paths.map((p) => (
            <g key={p.token}>
              <path className={p.cls} d={p.d}>
                <title>{p.title}</title>
              </path>
              <circle className="pipe-end" cx={p.ex} cy={p.ey} r={3} />
            </g>
          ))}
        </svg>
      </CardContent>
      <div className="border-t border-border px-4 py-1.5 text-[11px] text-dim">
        the connectors draw the session→engine edge the rows already name — the pin select on a row (rows mode) re-routes it; the agent never learns the engine changed. the “outside idlefill” cards appear only when an engine&apos;s own status names more conversations than the router can attribute — parked conversation caches (strata) first, in-flight counts as the fallback; the engine&apos;s count, never a guess
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
