import {
  Card,
  CardHeader,
  CardTitle,
  CardAction,
  CardContent,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { liveWord, type StateWord } from "@/lib/format";
import type { MeshPeer, StateSnapshot } from "@/lib/api";

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
// ---------------------------------------------------------------------------

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

      <div className="border-t border-border px-3 py-1.5 text-[11px] text-dim">
        <code className="truncate" title="the peer's mesh url">{p.url}</code>
      </div>
    </Card>
  );
}
