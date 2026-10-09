import { useState } from "react";
import {
  Card,
  CardHeader,
  CardTitle,
  CardAction,
  CardContent,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Sparkline } from "@/components/Sparkline";
import { liveWord, type StateWord } from "@/lib/format";
import { buildRemoteRows, type RemoteRow } from "@/lib/remote-metrics";
import { getRemoteMetrics, type MeshPeer, type StateSnapshot } from "@/lib/api";

const TONE: Record<string, string> = {
  ok: "text-ok",
  warn: "text-warn",
  err: "text-err",
  accent: "text-accent",
  dim: "text-dim",
};

// ---------------------------------------------------------------------------
// Machines — the mesh peers (#50). One read-only row per configured peer
// instance. Coarse by construction: the snapshot carries presence,
// per-engine idle state, queue DEPTHS, and session/lease counts — never job
// ids, titles, URLs, or payloads. The local machine is the rest of this
// page, never a row here. Read-only: the write plane is the paired control
// of #39, not this surface.
//
// #79/#86: each row gains ONE read-only expand — the remote range read. It
// pulls that peer's engine + session series THROUGH this arbiter (never to
// a peer origin, D3), on demand (no background pull), and renders the
// #52/#57 Usage sparkline vocabulary. ADD-only: the collapsed rows render
// exactly as before; a failed pull is a render gap, never a fake zero.
// ---------------------------------------------------------------------------

const REMOTE_WINDOW_MS = 7 * 86_400_000; // the 7-day default, local parity (D2)

export function Machines({ st }: { st: StateSnapshot | null }) {
  const peers = st?.mesh?.peers ?? [];

  return (
    <section>
      <div className="flex items-center gap-3 mb-3">
        <h2 className="text-[12px] font-semibold uppercase tracking-wide text-dim">Machines</h2>
        <span className="ml-auto text-[11px] text-dim">
          {peers.length} {peers.length === 1 ? "peer" : "peers"} · read-only snapshots
        </span>
      </div>

      {peers.length === 0 ? (
        <Card className="py-4 shadow-none">
          <CardContent className="px-4 text-[12px] text-dim">
            no mesh peers configured — add <code>mesh_peers</code> to the arbiter's config to pull coarse
            snapshots from other idlefill instances
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-2.5 [grid-template-columns:repeat(auto-fit,minmax(300px,1fr))]">
          {peers.map((p) => (
            <PeerCard key={p.url} p={p} />
          ))}
        </div>
      )}
    </section>
  );
}

function PeerCard({ p }: { p: MeshPeer }) {
  const snap = p.snapshot;
  return (
    <Card className="gap-0 py-0 shadow-none">
      <CardHeader className="flex-row items-center gap-2 px-3 py-2 pb-0">
        <CardTitle className="text-[13px] font-semibold">{p.name}</CardTitle>
        <Badge
          variant="outline"
          className={`rounded-pill px-1.5 py-0 text-[10px] font-normal ${p.online ? "text-ok" : "text-warn"}`}
        >
          {p.online ? "Online" : "Offline"}
        </Badge>
        <CardAction>
          <span className="text-[11px] text-dim" title="time since the last successful pull">
            {p.fetch_age_s === null ? "never pulled" : `pulled ${p.fetch_age_s}s ago`}
          </span>
        </CardAction>
      </CardHeader>

      <CardContent className="flex flex-col gap-2 px-3 py-2">
        <div className="text-[11px] text-dim">
          <span title="instance id">instance</span> <code className="text-foreground/80">{p.instance_id ?? "unknown"}</code>
        </div>
        {p.error && (
          <div className="text-[11px] text-err" title="the last pull failed">
            last error: {p.error}
          </div>
        )}
        {!snap && !p.error && (
          <div className="text-[11px] text-dim">no snapshot yet — the first pull fills this card</div>
        )}
        {snap && (
          <>
            <div className="flex flex-col gap-0.5">
              {snap.servers.length === 0 && <div className="text-[11px] text-dim">no engines reported</div>}
              {snap.servers.map((s, i) => {
                const w: StateWord = liveWord({ idle: s.idle, degraded: s.degraded }, false);
                return (
                  <div key={i} className="flex items-center gap-2 text-[12px]">
                    <span className={`size-1.5 rounded-full ${s.idle && !s.degraded ? "bg-border" : "bg-accent"}`} />
                    <span className="min-w-0 truncate">{s.name}</span>
                    <span className={`ml-auto text-[11px] font-semibold ${TONE[w.tone]}`} title={w.note}>
                      {w.label}
                      {s.idle && s.idle_for_s != null ? ` · ${s.idle_for_s}s` : ""}
                    </span>
                  </div>
                );
              })}
            </div>
            <div className="flex items-center gap-3 text-[11px] text-dim" title="queue depths, session and lease counts (coarse by construction)">
              <span>{snap.queue_depth.toLocaleString()} queued</span>
              <span>{snap.sessions} sessions</span>
              <span>{snap.active_leases} running</span>
              {snap.version && <span className="ml-auto" title="the peer's arbiter version">{snap.version}</span>}
            </div>
          </>
        )}
      </CardContent>

      <RemoteExpand p={p} />

      <div className="border-t border-border px-3 py-1.5 text-[11px] text-dim">
        <code className="truncate" title="the peer's mesh url">{p.url}</code>
      </div>
    </Card>
  );
}

/**
 * The one expand per peer row (#79 D6, ADD-only). Collapsed = the page
 * renders exactly as before. On open it range-reads the peer's engine +
 * session series THROUGH this arbiter (D3) and renders the Usage
 * sparkline vocabulary. Never on the poll tick — this fetch happens only
 * when the operator opens the row. A failed pull is a named gap; an
 * in-TTL cache hit rides the `stale` label.
 */
function RemoteExpand({ p }: { p: MeshPeer }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState<RemoteRow[] | null>(null);
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
      setRows(buildRemoteRows(eng.series, ses.series));
      setMeta({ stale: eng.stale || ses.stale, pulledAt: Math.max(eng.pulled_at, ses.pulled_at), truncated: eng.truncated || ses.truncated });
    } catch (e) {
      setRows(null);
      setMeta(null);
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && p.instance_id && rows === null && !loading && err === null) void pull(p.instance_id);
  };

  return (
    <div className="border-t border-border">
      <button
        type="button"
        onClick={toggle}
        disabled={!p.instance_id}
        title={p.instance_id ? "pull this peer's series through the local arbiter (on demand)" : "no instance id yet — the first snapshot pull is needed"}
        className="w-full px-3 py-1.5 text-left text-[11px] text-dim hover:text-foreground disabled:opacity-50"
      >
        {open ? "▾ hide peer metrics" : "▸ peer metrics"}
        <span className="ml-2 normal-case text-[10px] opacity-70">req/hr · tokens/hr · sessions (7 d)</span>
      </button>
      {open && (
        <div className="flex flex-col gap-1 px-3 pb-2">
          {loading && <div className="text-[11px] text-dim">pulling…</div>}
          {err && (
            <div className="text-[11px] text-err" title="the fetch failed: the row renders offline under the 90 s stale rule — no fake zeros">
              pull failed: {err}
            </div>
          )}
          {!loading && !err && rows && rows.length === 0 && (
            <div className="text-[11px] text-dim">no series lines in the window — the peer's store is empty here</div>
          )}
          {!loading && meta && (
            <div className="text-[10px] text-dim">
              {meta.stale ? "cached" : "live"} · pulled {Math.max(0, Math.round((Date.now() - meta.pulledAt) / 1000))}s ago
              {meta.truncated && <span title="the 2,000-point cap trimmed the oldest"> · truncated</span>}
            </div>
          )}
          {!loading && rows && rows.map((r, i) => (
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
