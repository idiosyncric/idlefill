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
import { Sparkline } from "@/components/Sparkline";
import { copyText } from "@/lib/clipboard";
import {
  apiToken,
  setSessionOverride,
  setSessionPin,
  getSessionTranscript,
  readLocalHermesTranscript,
  patchLocalHermesLifecycle,
  type HermesLifecyclePatch,
  type HermesTranscriptMessage,
  type HermesTranscriptPage,
  type SessionRow,
  type SessionTranscript,
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
  const [viewOpen, setViewOpen] = React.useState(false);
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
