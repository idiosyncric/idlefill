import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  Card,
  CardHeader,
  CardTitle,
  CardAction,
  CardContent,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Sparkline } from "@/components/Sparkline";
import { StatTiles, TilesSkeleton } from "@/components/stat-tiles";
import { ago, durFmt, fmt, liveWord, type StateWord } from "@/lib/format";
import { buildGapLine, hostLine, intentWord, meshTiles, peerVerdict, relayOutcome } from "@/lib/mesh-stats";
import { buildRemoteRows, type RemoteRow } from "@/lib/remote-metrics";
import {
  LOCAL_MACHINE,
  VIA_NOTE,
  hostedServers,
  hostOfServer,
  machineSummary,
  type HostVia,
  type MachineSummary,
} from "@/lib/hierarchy";
import { machineKey } from "@/lib/hash-nav";
import {
  apiToken,
  getRemoteMetrics,
  requestPeerUpdate,
  type MeshPeer,
  type ServerRow,
  type StateSnapshot,
} from "@/lib/api";

const TONE: Record<string, string> = {
  ok: "text-ok",
  warn: "text-warn",
  err: "text-err",
  accent: "text-accent",
  dim: "text-dim",
};

// ---------------------------------------------------------------------------
// Machines — the mesh peers (#50), in the Overview style: the mesh stat
// tiles above the fold (Peers online · Queued across mesh · Running across
// mesh · Engines idle — lib/mesh-stats.ts, the same discipline as the
// fleet tiles: FRESH snapshots only in the sums, coverage named, absent =
// em-dash with the reason, never a fake zero) and one read-only glance
// ROW per configured machine (the EngineRow shape: name + activity verdict
// word + presence dot + version, its engines as rows, its queue/session/
// lease counts as gauges). An offline peer dims to the last-known
// truth (labelled), exactly like a stale engine card. Coarse by
// construction: presence, per-engine idle state, queue DEPTHS, and
// session/lease counts — never job ids, titles, URLs, or payloads. The
// write plane is the paired control of #39, not this surface.
//
// The resources wave re-layout (2026-10-13): the small grid cards became
// FULL-WIDTH machine ROWS with a master-detail split — the left column is
// the machine's identity (instance, coarse counts · host · build lines, the
// update flow with its toasts, the peer-metrics expand), the right column
// its engines with the two SOURCES side by side: "hosted here — declared on
// this arbiter" (live local truth, NEVER dims) and "reported by that
// machine" (the peer's own snapshot list, dims stale with its snapshot).
// Narrow screens stack the columns (auto-fit grid, no media queries, the
// design law). Under each name one SUMMARY line of published-only counts
// (engines here · agents · sessions), derived by the exact joins in
// lib/hierarchy.ts (machineSummary) — counts whose population is COMPLETE
// for that machine, so unlike the tiles a 0 there is the truth, never a
// fake. Nothing about what the data says moved — only where it sits.
//
// "This Machine" (owner call, 2026-10-11) sits FIRST in the list — the
// earlier rule ("the local machine is the rest of this page, never a row
// here") is retired: the operator reading a machines list expects to see
// the machine they are on. Its row is the local truth (this page's own
// poll, not a pull): the same counts a peer would publish about us, plus
// the coarse host block (load averages · memory · uptime — the
// htop-equivalent ADD key off the arbiter's own node:os read; the GPU
// truth already rides the engine load axis elsewhere). Its engine column
// carries the ONE source there can be: the loopback/local-only join of the
// declared rows.
//
// #79/#86: each row gains ONE read-only expand — the remote range read. It
// pulls that peer's engine + session series THROUGH this arbiter (never to
// a peer origin, D3), on demand (no background pull), and renders the
// #52/#57 Usage sparkline vocabulary. ADD-only: a failed pull is a render
// gap, never a fake zero.
//
// mesh-update.md D4: the one write this tab is allowed — the update button,
// on a peer row whose LOCAL edge says `i_control` and nowhere else. Two-step
// confirm (one click arms "confirm?" for 3 s); the answer is a named toast
// (queued / update_in_flight / not_paired / direction_denied / …). The
// button creates an INTENT on the target, never a command: its host updater
// helper runs the machine's own documented update. This Machine has no
// button — it updates by the operator's own command line; the intents asked
// OF this machine render as chips on the local row (the coarse
// update_intents block).
//
// Navigable hierarchy (2026-10-13, layout-only, zero wire change): each
// row registers itself under its scheme key (machineKey = "machine/<name>",
// the local row keyed by machineKey(LOCAL_MACHINE) — the SAME label the
// hierarchy joins and the Servers-tab chip pass). A focusKey (App-owned,
// prefix-gated to this scheme) that names a row scrolls it into view ONCE
// and lights a transient hairline ring (~1.5 s, cleared on timeout AND on
// unmount); every other case — a deleted machine, rows not in yet — just
// opens the tab: no error chrome, no stale ring. Each hosted-engine row
// (the "hosted here" block — the arbiter's own join, the one that knows
// the row id) becomes a button deep-linking to that engine's card on the
// Inference servers tab.
// ---------------------------------------------------------------------------

const REMOTE_WINDOW_MS = 7 * 86_400_000; // the 7-day default, local parity (D2)

const TILE_TITLES: string[] = [
  "configured peers whose last successful pull is inside the 90 s stale window",
  "jobs waiting across the mesh — only FRESH peer snapshots count; an offline peer never does",
  "leases running across the mesh — only FRESH peer snapshots count",
  "watched engines idle across the mesh — only FRESH peer snapshots count",
];

export function Machines({
  st,
  focusKey,
  onEnginePick,
  onConsumeFocus,
}: {
  st: StateSnapshot | null;
  /** App-owned deep-link focus, already prefix-gated to this view's scheme
   *  ("machine/<name>") — null when the hash/focus names nothing here. */
  focusKey?: string | null;
  /** Cross-tab pick: open this engine's card on the Inference servers tab.
   *  Absent = rows stay plain lines. */
  onEnginePick?: (serverId: string) => void;
  /** Tell App the focus was consumed (it clears the state and rewrites the
   *  hash to the bare sub-tab so a refresh never re-flashes). */
  onConsumeFocus?: () => void;
}) {
  // Deep-link plumbing (layout-only): every machine row registers itself
  // under its scheme key; a focusKey that names a row scrolls it in ONCE
  // and arms the transient ring. The ring timer is its own effect keyed on
  // flashKey, so App clearing the focus (focusKey → null) cannot cut the
  // highlight short, and unmounting clears the timer — no leaks, no stale
  // ring. A focusKey that names no row (deleted machine, or the rows are
  // not even in yet and never will be) just opens the tab.
  const rowRefs = useRef(new Map<string, HTMLElement>());
  const [flashKey, setFlashKey] = useState<string | null>(null);
  const regRow = (key: string, el: HTMLElement | null) => {
    if (el) rowRefs.current.set(key, el);
    else rowRefs.current.delete(key);
  };
  const rowsIn = st !== null; // the skeleton render registers no rows
  useEffect(() => {
    if (!focusKey || !rowsIn) return;
    const el = rowRefs.current.get(focusKey);
    if (el) {
      el.scrollIntoView({ block: "center" });
      setFlashKey(focusKey);
    }
    onConsumeFocus?.(); // consumed exactly once, match or no match
  }, [focusKey, rowsIn, onConsumeFocus]);
  useEffect(() => {
    if (flashKey === null) return;
    const t = setTimeout(() => setFlashKey(null), 1500);
    return () => clearTimeout(t); // timeout AND unmount both clear the highlight
  }, [flashKey]);
  if (!st) {
    return (
      <section className="flex flex-col gap-3">
        <TilesSkeleton cols={4} />
        <Skeleton className="h-32 rounded-lg" />
      </section>
    );
  }
  const peers = st.mesh?.peers ?? [];
  // The hierarchy pass (owner ask 2026-10-12): every declared engine row
  // joins to exactly one machine by its own named facts (url host / group
  // label / loopback), and renders inside THAT machine's row — urza's row
  // carries strata-urza AND llama-swap-urza, not just what urza's
  // own arbiter happens to report. A row no machine names stays out of
  // every row and is NAMED below the list; it never disappears.
  const hosts = hostedServers(st);
  const hostedOn = (machine: string): { row: ServerRow; via: HostVia }[] =>
    (hosts.byMachine.get(machine) ?? []).map((row) => ({ row, via: hostOfServer(st, row)?.via ?? "local-only" }));

  return (
    <section className="flex flex-col gap-3">
      {peers.length > 0 && (
        <StatTiles
          cols={4}
          tiles={meshTiles(peers).map((tile, i) => ({
            label: ["Peers online", "Queued across mesh", "Running across mesh", "Engines idle"][i],
            title: TILE_TITLES[i],
            tile,
          }))}
        />
      )}
      <div className="flex items-center gap-3">
        <h2 className="text-[12px] font-semibold uppercase tracking-wide text-dim">Machines</h2>
        <span className="ml-auto text-[11px] text-dim">
          {peers.length} {peers.length === 1 ? "peer" : "peers"} · read-only snapshots · one write: update (paired peers)
        </span>
      </div>

      {peers.length === 0 ? (
        <Card className="py-4 shadow-none">
          <CardContent className="px-4 text-[12px] text-dim">
            no mesh peers configured — add <code>mesh_peers</code> to the arbiter's config to pull coarse
            snapshots from other idlefill instances
          </CardContent>
        </Card>
      ) : null}
      {/* Full-width rows, one per machine (the resources wave): the list
          stacks, each row splits identity/engines side by side when wide
          and stacks them when narrow — auto-fit, no media queries. */}
      <div className="flex flex-col gap-2.5">
        <LocalRow
          st={st}
          hosted={hostedOn(LOCAL_MACHINE)}
          rowRef={(el) => regRow(machineKey(LOCAL_MACHINE), el)}
          highlighted={flashKey === machineKey(LOCAL_MACHINE)}
          onEnginePick={onEnginePick}
        />
        {peers.map((p) => (
          <PeerRow
            key={p.url}
            st={st}
            p={p}
            now={st.now}
            hosted={hostedOn(p.name)}
            rowRef={(el) => regRow(machineKey(p.name), el)}
            highlighted={flashKey === machineKey(p.name)}
            onEnginePick={onEnginePick}
          />
        ))}
      </div>
      {hosts.unhosted.length > 0 && (
        <div className="text-[11px] text-dim" title="these rows' url hostnames match no machine and their engine group names no machine — the Machines tab never guesses a host; the rows stand whole on the Inference servers tab">
          host not named: {hosts.unhosted.map((s) => s.name).join(", ")} — url and group name no machine here (whole on the Inference servers tab)
        </div>
      )}
    </section>
  );
}

// The per-machine summary line under the name (resources wave): published
// counts only, every join EXACT (lib/hierarchy.ts machineSummary). The
// tooltip names each join in one sentence; a 0 renders honestly because the
// join is COMPLETE for this machine's population — the counts are not the
// tiles, where absent coverage earns an em-dash instead.
function SummaryLine({ s }: { s: MachineSummary }) {
  const n = (v: number) => <span className="text-foreground">{fmt(v)}</span>;
  return (
    <div
      className="text-[11px] text-dim"
      title="published-only counts, every join EXACT — engines here = this arbiter's declared rows whose url host or engine-group label names this machine · agents = the profiles on this machine's clients' published rosters (rosters are what clients report — a client that publishes none contributes 0) · sessions = session rows whose client_id is one of this machine's client daemons"
    >
      {n(s.engines)} engines here · {n(s.agents)} agents · {n(s.sessions)} sessions
    </div>
  );
}

// The engine state word for one hosted row + its dot class — the shared
// shape of the row line in both source columns (identity of the row:
// dot, name, right-aligned state word, idle duration when idle).
function engineDot(row: ServerRow): string {
  return row.signal?.degraded ? "bg-err" : row.signal?.idle ? "bg-border" : "bg-accent";
}

// This Machine — the local row (first in the list, owner call 2026-10-11):
// the same coarse counts a peer would publish about this instance, read as
// local truth from this page's own poll. The host line is the arbiter's
// live node:os read (host-wide even inside a container); absent on an
// arbiter that predates the key → no line, never a fake zero. Nothing here
// dims: it is all this page's own live poll.
function LocalRow({
  st,
  hosted,
  rowRef,
  highlighted,
  onEnginePick,
}: {
  st: StateSnapshot;
  hosted: { row: ServerRow; via: HostVia }[];
  rowRef: (el: HTMLElement | null) => void;
  highlighted: boolean;
  onEnginePick?: (serverId: string) => void;
}) {
  const running = (st.active_leases ?? []).length > 0;
  const w: StateWord = liveWord(st.idle, running);
  const queued = (st.clients ?? []).flatMap((c) => c.projects ?? []).reduce((a, p) => a + (p.queue_depth || 0), 0);
  const h = st.host;
  const hline = hostLine(h);
  return (
    <Card ref={rowRef} className={`gap-0 py-0 shadow-none ${highlighted ? "ring-1 ring-ring" : ""}`}>
      <CardHeader className="flex-row items-center gap-2 px-3 py-2 pb-0">
        <span className="size-1.5 shrink-0 rounded-full bg-ok" title="this machine — the arbiter serving this page" />
        <CardTitle className="min-w-0 truncate text-[13px] font-semibold" title="the arbiter serving this page — local truth, not a pull">
          This Machine
        </CardTitle>
        <span className={`shrink-0 text-[11px] font-semibold ${TONE[w.tone]}`} title={w.note}>{w.label}</span>
        <CardAction>
          <span className="shrink-0 text-[11px] text-dim" title="this row rides the page's own 5 s state poll — not a peer pull">
            local
          </span>
        </CardAction>
      </CardHeader>

      <CardContent className="flex flex-col gap-1.5 px-3 py-2">
        <SummaryLine s={machineSummary(st, LOCAL_MACHINE)} />
        <div className="grid gap-x-4 gap-y-2 [grid-template-columns:repeat(auto-fit,minmax(300px,1fr))]">
          {/* identity column — instance, coarse counts, host, update intents */}
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-2 text-[11px] text-dim">
              <span title="instance id — the identity (tailnet IPs move, the id does not)">instance</span>{" "}
              <code className="min-w-0 truncate text-foreground/80">{st.mesh?.instance_id ?? "no mesh identity"}</code>
            </div>
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-3 text-[11px] text-dim" title="the same coarse counts a peer would pull about this machine">
                <span className="whitespace-nowrap" title="jobs waiting across this machine's clients"><span className="text-[13px] font-semibold text-foreground">{fmt(queued)}</span> queued</span>
                <span className="whitespace-nowrap" title="interactive sessions registered here"><span className="text-[13px] font-semibold text-foreground">{fmt((st.sessions ?? []).length)}</span> sessions</span>
                <span className="whitespace-nowrap" title="leases running here"><span className="text-[13px] font-semibold text-foreground">{fmt((st.active_leases ?? []).length)}</span> running</span>
              </div>
              {hline && (
                <div className="text-[10px] text-dim" title={`coarse host counters — what the arbiter's process sees of its own host (host-wide even inside its container)${h?.cpus ? ` · ${h.cpus} cpus` : ""}${h?.load15 !== undefined ? ` · 15m load ${h.load15}` : ""} · GPU truth rides the engine load axis`}>
                  {hline}
                </div>
              )}
            </div>
            {(st.update_intents?.length ?? 0) > 0 && (
              <div className="flex flex-wrap items-center gap-1.5" title="machine-update intents asked of THIS machine by a paired controller (mesh-update.md) — this machine updates by the operator's own command line, there is no local button">
                <span className="text-[10px] uppercase tracking-wide text-dim">updates</span>
                {[...(st.update_intents ?? [])].reverse().map((it) => {
                  const iw = intentWord(it, st.now);
                  return (
                    <span key={it.id} className={`rounded border border-border px-1.5 py-0.5 text-[10px] font-semibold ${TONE[iw.tone]}`} title={`${iw.note} · intent ${it.id} · requested by ${it.source_instance_id}`}>
                      {iw.label}
                    </span>
                  );
                })}
              </div>
            )}
          </div>
          {/* engines column — the ONE source there can be for the local
              machine: the loopback/local-only join of the declared rows
              (live local truth, never dims). Exception-only lines when the
              join names nothing. */}
          <div className="flex flex-col gap-0.5">
            {(st.servers ?? []).length === 0 && <div className="text-[11px] text-dim">no engines declared</div>}
            {(st.servers ?? []).length > 0 && hosted.length === 0 && (
              <div className="text-[11px] text-dim" title="every declared row names another machine (url host or engine-group label) — this machine hosts none">
                no engines hosted on this machine
              </div>
            )}
            {hosted.length > 0 && (
              <>
                <span className="text-[10px] uppercase tracking-wide text-dim">hosted here — declared on this arbiter</span>
                {hosted.map(({ row, via }) => {
                  const sw: StateWord = liveWord(
                    row.signal ? { idle: row.signal.idle, degraded: row.signal.degraded } : null,
                    running || row.models.some((m) => m.running),
                  );
                  // the one line of the row: dot · name · right-aligned state
                  // word (+ idle duration). With a wired pick it becomes a
                  // button (keyboard-accessible, focus-visible ring, no
                  // chevron — the affordance is the ring and the title, in
                  // keeping with the flat-by-default posture).
                  const line = (
                    <>
                      <span
                        className={`size-1.5 shrink-0 rounded-full ${engineDot(row)}`}
                        title={`${row.name}: ${sw.label} — hosted here (${VIA_NOTE[via]})`}
                      />
                      <span className="min-w-0 truncate">{row.name}</span>
                      <span className={`ml-auto whitespace-nowrap text-[11px] font-semibold ${TONE[sw.tone]}`} title={sw.note}>
                        {sw.label}
                        {row.signal?.idle && row.signal.idle_for_s != null ? ` · ${durFmt(row.signal.idle_for_s)}` : ""}
                      </span>
                    </>
                  );
                  if (onEnginePick)
                    return (
                      <button
                        key={row.id}
                        type="button"
                        onClick={() => onEnginePick(row.id)}
                        title="open this engine's card on the Inference servers tab"
                        className="flex items-center gap-2 rounded-sm text-left text-[12px] outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                      >
                        {line}
                      </button>
                    );
                  return (
                    <div key={row.id} className="flex items-center gap-2 text-[12px]">
                      {line}
                    </div>
                  );
                })}
              </>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function PeerRow({
  st,
  p,
  now,
  hosted,
  rowRef,
  highlighted,
  onEnginePick,
}: {
  st: StateSnapshot;
  p: MeshPeer;
  now: number;
  hosted: { row: ServerRow; via: HostVia }[];
  rowRef: (el: HTMLElement | null) => void;
  highlighted: boolean;
  onEnginePick?: (serverId: string) => void;
}) {
  const snap = p.snapshot;
  const w: StateWord = peerVerdict(snap);
  // Past the arbiter's 90 s pull window the snapshot is the LAST-KNOWN
  // truth: shown dimmed and labelled, never rewritten, never zeroed. Only
  // the snapshot-sourced column dims — the hosted block and the identity
  // lines are this arbiter's own live readings and never dim.
  const stale = !p.online;
  const staleDim = stale && snap ? "opacity-60" : "";
  return (
    <Card ref={rowRef} className={`gap-0 py-0 shadow-none ${highlighted ? "ring-1 ring-ring" : ""}`}>
      <CardHeader className="flex-row items-center gap-2 px-3 py-2 pb-0">
        <span
          className={`size-1.5 shrink-0 rounded-full ${p.online ? "bg-ok" : "bg-warn"}`}
          title={
            p.online
              ? "online — the last successful pull is inside the 90 s stale window"
              : p.fetch_age_s === null
                ? "offline — no pull has ever succeeded"
                : `offline — the last successful pull is ${ago(p.fetch_age_s * 1000)} (past the 90 s stale window)`
          }
        />
        <CardTitle className="min-w-0 truncate text-[13px] font-semibold" title={p.url}>{p.name}</CardTitle>
        <span className={`shrink-0 text-[11px] font-semibold ${TONE[w.tone]} ${staleDim}`} title={w.note}>
          {w.label}
        </span>
        <CardAction>
          <span className="shrink-0 text-[11px] text-dim" title="seconds since the last SUCCESSFUL pull — past 90 s the peer is offline and its snapshot is the last-known truth">
            {p.fetch_age_s === null ? "never pulled" : `pulled ${ago(p.fetch_age_s * 1000)}`}
          </span>
        </CardAction>
      </CardHeader>

      <CardContent className="flex flex-col gap-1.5 px-3 py-2">
        <SummaryLine s={machineSummary(st, p.name)} />
        <div className="grid gap-x-4 gap-y-2 [grid-template-columns:repeat(auto-fit,minmax(300px,1fr))]">
          {/* identity column — instance, exceptions, the url, the one write
              (the update flow), and the peer-metrics expand. All of it is
              this arbiter's live reading: never dims. */}
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-2 text-[11px] text-dim">
              <span title="instance id — the identity (tailnet IPs move, the id does not)">instance</span>{" "}
              <code className="min-w-0 truncate text-foreground/80">{p.instance_id || "unknown"}</code>
              {snap?.version && (
                <span className="ml-auto shrink-0 text-[10px] text-dim" title="the peer's arbiter version">{snap.version}</span>
              )}
            </div>
            {p.error && (
              <div className="text-[11px] text-err" title="the last pull failed — exception-only, cleared on the next success">
                last error: {p.error}
              </div>
            )}
            {!snap && !p.error && (
              <div className="text-[11px] text-dim">no snapshot yet — the first pull fills this row</div>
            )}
            <div className="flex items-center gap-2 border-t border-border pt-1.5 text-[11px] text-dim">
              <code className="min-w-0 truncate" title="the peer's mesh url">{p.url}</code>
              {p.i_control && <UpdateButton p={p} />}
            </div>
            <RemoteExpand p={p} />
          </div>
          {/* engines column — the two SOURCES, side by side when wide,
              stacked when narrow, never merged. */}
          <div className="grid gap-x-4 gap-y-2 [grid-template-columns:repeat(auto-fit,minmax(200px,1fr))]">
            {/* The hierarchy block (owner ask 2026-10-12): the engine rows THIS
                arbiter declares that host on THAT machine — exact joins (url
                hostname = the peer's, or engine-group label = the machine's
                name). urza's row carries strata-urza AND llama-swap-urza even
                though urza's own snapshot names only one of them. Reads live
                from this page's poll — never dims with a stale snapshot. */}
            {hosted.length > 0 && (
              <div className="flex flex-col gap-0.5">
                <span className="text-[10px] uppercase tracking-wide text-dim">hosted here — declared on this arbiter</span>
                {hosted.map(({ row, via }) => {
                  const sw: StateWord = liveWord(
                    row.signal ? { idle: row.signal.idle, degraded: row.signal.degraded } : null,
                    !!row.engaged || row.models.some((m) => m.running),
                  );
                  // Same row shape as the local block — and the same pick
                  // button (the block is this arbiter's own join, so it knows
                  // the row id the Servers tab addresses the card by).
                  const line = (
                    <>
                      <span
                        className={`size-1.5 shrink-0 rounded-full ${engineDot(row)}`}
                        title={`${row.name} — ${VIA_NOTE[via]} · ${row.url}`}
                      />
                      <span className="min-w-0 truncate" title={`${row.url} · ${row.models.length} models seen`}>{row.name}</span>
                      <span className={`ml-auto whitespace-nowrap text-[11px] font-semibold ${TONE[sw.tone]}`} title={sw.note}>
                        {sw.label}
                        {row.signal?.idle && row.signal.idle_for_s != null ? ` · ${durFmt(row.signal.idle_for_s)}` : ""}
                      </span>
                    </>
                  );
                  if (onEnginePick)
                    return (
                      <button
                        key={row.id}
                        type="button"
                        onClick={() => onEnginePick(row.id)}
                        title="open this engine's card on the Inference servers tab"
                        className="flex items-center gap-2 rounded-sm text-left text-[12px] outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                      >
                        {line}
                      </button>
                    );
                  return (
                    <div key={row.id} className="flex items-center gap-2 text-[12px]">
                      {line}
                    </div>
                  );
                })}
              </div>
            )}
            {/* The peer's own column: everything here is THAT machine's
                snapshot — its engines and its coarse counts — one block,
                one dim when the pull goes stale. */}
            {snap && (
              <div className={`flex flex-col gap-2 ${staleDim}`} title={stale ? "the peer is offline — showing the last-known snapshot" : undefined}>
                <div className="flex flex-col gap-0.5">
                  <span className="text-[10px] uppercase tracking-wide text-dim" title="the peer's own snapshot: the engines it reports and its coarse counts — the last-known truth while the peer is offline">reported by that machine</span>
                  {snap.servers.length === 0 && <div className="text-[11px] text-dim">no engines reported</div>}
                  {snap.servers.map((s, i) => {
                    const sw: StateWord = liveWord({ idle: s.idle, degraded: s.degraded }, false);
                    return (
                      <div key={i} className="flex items-center gap-2 text-[12px]">
                        <span
                          className={`size-1.5 shrink-0 rounded-full ${s.degraded ? "bg-err" : s.idle ? "bg-border" : "bg-accent"}`}
                          title={`${s.name}: ${sw.label}`}
                        />
                        <span className="min-w-0 truncate">{s.name}</span>
                        <span className={`ml-auto whitespace-nowrap text-[11px] font-semibold ${TONE[sw.tone]}`} title={sw.note}>
                          {sw.label}
                          {s.idle && s.idle_for_s != null ? ` · ${durFmt(s.idle_for_s)}` : ""}
                        </span>
                      </div>
                    );
                  })}
                </div>
                <div className="flex flex-col gap-1">
                  <div className="flex items-center gap-3 text-[11px] text-dim" title="queue depths, session and lease counts — coarse by construction (the peer publishes numbers, never rows)">
                    <span className="whitespace-nowrap" title="jobs waiting on that machine"><span className="text-[13px] font-semibold text-foreground">{fmt(snap.queue_depth)}</span> queued</span>
                    <span className="whitespace-nowrap" title="interactive sessions registered there"><span className="text-[13px] font-semibold text-foreground">{fmt(snap.sessions)}</span> sessions</span>
                    <span className="whitespace-nowrap" title="leases running there"><span className="text-[13px] font-semibold text-foreground">{fmt(snap.active_leases)}</span> running</span>
                    <span className="ml-auto whitespace-nowrap text-[10px]" title="when that machine took the snapshot (its own clock)">
                      snap {ago(now - snap.ts)}
                    </span>
                    {stale && <span className="text-[10px] text-warn" title="the last successful pull lapsed past the 90 s window — these values may be out of date">stale</span>}
                  </div>
                  {hostLine(snap.host) && (
                    <div className="text-[10px] text-dim" title="coarse host counters as THAT machine's arbiter reported them (load/memory/uptime — absent on a peer that predates the key)">
                      {hostLine(snap.host)}
                    </div>
                  )}
                  {buildGapLine(p) && (
                    <div className={`text-[10px] ${TONE[buildGapLine(p)!.tone]}`} title="the git commit that machine's arbiter booted from, and how far its build sits from this machine's (counted with git rev-list on this checkout — 'behind' is why the update button exists; 'differ' = the two shas cannot be ordered from here; absent = that machine does not report a build)">
                      {buildGapLine(p)!.text}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// The one write the Machines tab carries (mesh-update.md D4): press once to
// arm ("confirm?" for 3 s), press again to relay the update verb to the
// peer. The local arbiter signs the #39 envelope; the target records an
// INTENT and its own host helper does everything else — nothing executable
// crosses the wire. The button exists only on an `i_control` row; an
// unpaired or reverse edge never shows it (and the relay refuses it by name
// even if the UI were wrong).
function UpdateButton({ p }: { p: MeshPeer }) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const disarm = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setArmed(false);
  };

  const arm = () => {
    setArmed(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setArmed(false), 3000);
  };

  const fire = async () => {
    disarm();
    if (!apiToken()) {
      toast.error("needs the arbiter API token — paste it in the header first");
      return;
    }
    setBusy(true);
    try {
      const relay = await requestPeerUpdate(p.instance_id);
      const w = relayOutcome(relay);
      if (w.tone === "err") toast.error(`${p.name}: ${w.label}`, { description: w.note });
      else if (w.tone === "warn") toast.warning(`${p.name}: ${w.label}`, { description: w.note });
      else toast.success(`${p.name}: ${w.label}`, { description: w.note });
    } catch (e) {
      toast.error(`${p.name}: ${e instanceof Error ? e.message : String(e)}`, {
        description: "the local relay refused before hopping — the denial names itself",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      disabled={busy}
      onClick={armed ? () => void fire() : arm}
      title={
        busy
          ? "relaying the update verb to the peer…"
          : armed
            ? "one more click asks this machine to update its idlefill install — its host updater helper runs the machine's own update command"
            : "ask this machine to update its idlefill install (creates an intent there; nothing executable crosses the wire)"
      }
      className={`ml-auto shrink-0 rounded border px-2 py-0.5 text-[11px] font-semibold transition-colors ${
        armed ? "border-warn text-warn" : "border-border text-dim hover:text-foreground"
      } disabled:opacity-50`}
    >
      {busy ? "relaying…" : armed ? "confirm?" : "update"}
    </button>
  );
}

/**
 * The one expand per peer row (#79 D6, ADD-only). Collapsed = the page
 * renders exactly as before. On open it range-reads the peer's engine +
 * session series THROUGH this arbiter (D3) and renders the Usage
 * sparkline vocabulary. Never on the poll tick — this fetch happens only
 * when the operator opens the row. A failed pull is a named gap; an
 * in-TTL cache hit rides the `stale` label. It sits in the row's identity
 * column (the series pull belongs to the machine, not to either engine
 * source).
 */
function RemoteExpand({ p }: { p: MeshPeer }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [built, setBuilt] = useState<{ rows: RemoteRow[]; absences: string[] } | null>(null);
  const [meta, setMeta] = useState<{ stale: boolean; pulledAt: number; truncated: boolean } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const pull = async (id: string) => {
    setLoading(true);
    setErr(null);
    try {
      const now = Date.now();
      const from = now - REMOTE_WINDOW_MS;
      const [eng, ses] = await Promise.all([
        getRemoteMetrics(id, "engine", from, now),
        getRemoteMetrics(id, "session", from, now),
      ]);
      setBuilt(buildRemoteRows(eng.series, ses.series, { stale: eng.stale, truncated: eng.truncated }));
      setMeta({ stale: eng.stale || ses.stale, pulledAt: Math.max(eng.pulled_at, ses.pulled_at), truncated: eng.truncated || ses.truncated });
    } catch (e) {
      setBuilt(null);
      setMeta(null);
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && p.instance_id && built === null && !loading && err === null) void pull(p.instance_id);
  };

  return (
    <div className="border-t border-border pt-1.5">
      <button
        type="button"
        onClick={toggle}
        disabled={!p.instance_id}
        title={p.instance_id ? "pull this peer's series through the local arbiter (on demand)" : "no instance id yet — the first snapshot pull is needed"}
        className="w-full py-0.5 text-left text-[11px] text-dim hover:text-foreground disabled:opacity-50"
      >
        {open ? "▾ hide peer metrics" : "▸ peer metrics"}
        <span className="ml-2 normal-case text-[10px] opacity-70">req/hr · tokens/hr · sessions (7 d)</span>
      </button>
      {open && (
        <div className="flex flex-col gap-1 pb-1">
          {loading && <div className="text-[11px] text-dim">pulling…</div>}
          {err && (
            <div className="text-[11px] text-err" title="the fetch failed: the row renders offline under the 90 s stale rule — no fake zeros">
              pull failed: {err}
            </div>
          )}
          {!loading && !err && built && built.rows.length === 0 && built.absences.length === 0 && (
            <div className="text-[11px] text-dim">no series lines in the window — the peer's store is empty here</div>
          )}
          {!loading && meta && (
            <div className="text-[10px] text-dim">
              {meta.stale ? "cached" : "live"} · pulled {Math.max(0, Math.round((Date.now() - meta.pulledAt) / 1000))}s ago
              {meta.truncated && <span title="the 2,000-point cap trimmed the oldest"> · truncated</span>}
            </div>
          )}
          {!loading && built && built.absences.map((a) => (
            <div key={a} className="text-[11px] text-dim italic" title="the peer's own store carries no load axis for this engine — named, never zeroed">{a}</div>
          ))}
          {!loading && built && built.rows.map((r, i) => (
            <div key={`${r.label}-${i}`} className="flex items-center gap-2 text-[11px]">
              <span className="w-36 min-w-0 truncate" title={r.title}>{r.label}</span>
              <Sparkline values={r.values} stroke={r.stroke} title={r.title} />
              <span className="w-14 text-right font-semibold">{r.valueText}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
