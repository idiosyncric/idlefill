import * as React from "react";
import { toast } from "sonner";
import { ArrowUp, ArrowDown } from "lucide-react";
import {
  Card,
  CardHeader,
  CardTitle,
  CardAction,
  CardContent,
  CardFooter,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
  getAliases,
  putAlias,
  type AliasRow,
  type ModelAliasEntry,
  type ServerRow,
  type StateSnapshot,
} from "@/lib/api";
import {
  HERMES_MODEL_ACCESS_LABEL,
  currentProviderOf,
  groupModelsByProfile,
  groupProvidersByProfile,
  hasModelAccess,
  idlefillWiredNames,
  servedModelGaps,
} from "@/lib/hermes-model-access";
import { ago, fmtCtx, probeWord } from "@/lib/format";
import { modelTiles } from "@/lib/model-stats";
import { StatTiles, TilesSkeleton } from "@/components/stat-tiles";

// ---------------------------------------------------------------------------
// Models — the operator-declared model aliases (#66). One card per alias:
// its pairs (the engine row + its EXACT probed model id) with the per-pair
// probe marker, the resolved winner (pin), and the edit form. An alias pins
// ONE model name to exact engine inventory entries; the winner answers with
// that pair's own id (the client router rewrites the body). Pairs are picked
// ONLY from probed engine inventories (D5 — never a fuzzy match); the
// arbiter never sees a token here (aliases carry none by construction).
//
// Authoring cadence (the legacy posture, kept): the rows come from the
// token-gated GET /api/aliases on a 30s timer + on mount + after each write
// — NOT from the 5s state poll. The probed pick-lists come from THIS poll's
// per-row model inventories (st.servers). With no token the pane names the
// requirement and no request leaves the page.
// ---------------------------------------------------------------------------

const AUTHORING_MS = 30_000;

export function Models({ st }: { st: StateSnapshot | null }) {
  const [aliases, setAliases] = React.useState<AliasRow[]>([]);
  const [loaded, setLoaded] = React.useState(false);
  const [editName, setEditName] = React.useState<string | null>(null);
  const [adding, setAdding] = React.useState(false);

  const servers = st?.servers ?? [];
  const srvName = React.useCallback(
    (id: string) => servers.find((s) => s.id === id)?.name ?? id,
    [servers],
  );

  const hasToken = apiToken() !== null;

  // The authoring read: token-gated; a non-200 keeps the rows in hand
  // (drop-don't-wipe).
  const refresh = React.useCallback(async () => {
    if (!apiToken()) return;
    try {
      const rows = await getAliases();
      setAliases(rows);
      setLoaded(true);
    } catch {
      /* the pane keeps its last good rows */
    }
  }, []);

  // Priority re-arrangement. The stored key order IS the priority: it is the
  // order /v1/models advertises (first = the default model) and the default
  // model a minted agent config names. A move rewrites the whole order as
  // { order: [name, …] } (first = highest priority). The list the pane holds
  // is already in priority order (the server returns stored insertion order).
  const reorder = React.useCallback(
    async (names: string[]) => {
      if (!apiToken()) {
        toast.error("needs the arbiter API token — paste it in Settings first");
        return;
      }
      const current = aliases.map((a) => a.alias);
      if (names.length !== current.length || names.every((n, i) => current[i] === n)) return; // no-op
      try {
        await putAlias({ order: names });
        toast.success("priority updated");
        void refresh();
      } catch (e) {
        toast.error(`reorder refused: ${(e as Error).message}`);
      }
    },
    [aliases, refresh],
  );

  // Swap one card with its neighbor (the up/down arrows).
  const move = React.useCallback(
    (index: number, dir: -1 | 1) => {
      const j = index + dir;
      if (j < 0 || j >= aliases.length) return;
      const names = aliases.map((a) => a.alias);
      [names[index], names[j]] = [names[j]!, names[index]!];
      void reorder(names);
    },
    [aliases, reorder],
  );

  React.useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), AUTHORING_MS);
    return () => clearInterval(id);
  }, [refresh]);

  // Re-render from cache on the state tick (fresh server names/ages).
  React.useEffect(() => {
    if (st && !loaded && apiToken()) void refresh();
  }, [st, loaded, refresh]);

  return (
    <section>
      <div className="flex items-center gap-3 mb-3">
        <h2 className="text-[12px] font-semibold uppercase tracking-wide text-dim">Model aliases</h2>
        <Button
          size="sm"
          variant="outline"
          className="ml-auto h-6 text-[12px]"
          onClick={() => {
            if (!apiToken()) {
              toast.error("needs the arbiter API token — paste it in Settings first");
              return;
            }
            setAdding(true);
          }}
          title="declare a model alias — one name pinned to exact engine inventory entries"
        >
          + add alias
        </Button>
      </div>

      {st === null ? (
        <TilesSkeleton cols={4} />
      ) : (
        <StatTiles
          cols={4}
          tiles={modelTiles(st).map((tile, i) => ({
            label: ["Aliases", "Routing", "Re-routed", "First alias"][i],
            title: [
              "operator aliases with a resolved winner this tick — what the router publishes to every agent",
              "how many winners came from a live /v1/models probe (green) rather than a declared list (red)",
              "aliases whose stored pin or group block was dead — traffic moved to the next-best pair",
              "the alias /v1/models leads with — the machine's advertised default",
            ][i],
            tile,
          }))}
        />
      )}

      {!hasToken ? (
        <Card className="py-4 shadow-none">
          <CardContent className="px-4 text-[12px] text-dim">
            paste the arbiter token into the header to list and edit aliases
          </CardContent>
        </Card>
      ) : aliases.length === 0 ? (
        <Card className="py-4 shadow-none">
          <CardContent className="px-4 text-[12px] text-dim">
            no aliases declared — “+ add alias” pins one model name to exact engine inventory entries
          </CardContent>
        </Card>
      ) : (
        <>
          <p className="mb-2 text-[11px] text-dim">
            cards are listed in PRIORITY order — top = highest priority. The top alias is the machine’s default model
            (the name /v1/models leads with, and the name a minted agent config names). Re-order with the arrows.
          </p>
          <div className="grid gap-2.5 [grid-template-columns:repeat(auto-fit,minmax(340px,1fr))]">
            {aliases.map((a, i) => (
              <AliasCard
                key={a.alias}
                a={a}
                index={i}
                total={aliases.length}
                published={st?.model_aliases.find((m) => m.name === a.alias) ?? null}
                onMove={(dir) => move(i, dir)}
                srvName={srvName}
                servers={servers}
                now={st?.now ?? Date.now()}
                onEdit={() => {
                  if (apiToken()) setEditName(a.alias);
                }}
              />
            ))}
          </div>
        </>
      )}

      <HermesModelAccess st={st} />

      <AliasFormDialog
        open={adding}
        onOpenChange={setAdding}
        alias={null}
        servers={servers}
        existing={aliases}
        srvName={srvName}
        onSaved={() => {
          toast.success("alias saved");
          void refresh();
        }}
      />
      <AliasFormDialog
        open={editName !== null}
        onOpenChange={(o) => !o && setEditName(null)}
        alias={aliases.find((x) => x.alias === editName) ?? null}
        servers={servers}
        existing={aliases}
        srvName={srvName}
        onSaved={() => {
          toast.success("alias updated");
          void refresh();
        }}
      />
    </section>
  );
}

// ---------------------------------------------------------------------------
// One alias card: the name, the pairs (with the per-pair source marker),
// the winner line, and the pin/unpin + edit controls.
// ---------------------------------------------------------------------------

// The per-pair source marker (D1 alias-stability rename): `mismatch` is the
// probe CONTRADICTION — the row's /v1/models probe succeeded but its list
// lacks this id (the old per-tick `dropped` case, renamed to name it
// honestly); `dropped` REMAINS the sanitizer marker (config corruption).
const SOURCE_MARK: Record<string, string> = {
  declared: "declared",
  mismatch: "probe says no",
  dropped: "dropped (config)",
  unprobed: "not probed",
};

const SOURCE_TITLE: Record<string, string> = {
  declared: "pair source: declared — the row's probe never answered this tick; the stored declaration stands",
  mismatch: "pair source: mismatch — the row's /v1/models probe SUCCEEDED but its list lacks this id (probe contradiction, D1): an ALERT, not a drop — the alias still publishes, honestly degraded",
  dropped: "pair source: dropped — sanitizer: hostile id, missing row, or blank url (config corruption, D1)",
  unprobed: "pair source: unprobed — stored pair the row's probe has never confirmed",
};

// ---------------------------------------------------------------------------
// #87 D4: capability + misalignment display helpers. Capabilities are DERIVED
// from the published facts — each pair's engine entry looked up in its row's
// probed inventory (never claimed for declared rows), the winner's variant id
// read straight off the published entry. No new arbiter state.
// ---------------------------------------------------------------------------

export type ModelCaps = { context_length?: number; input_modalities?: string[]; output_modalities?: string[] };

const nonTextInputs = (c: ModelCaps | undefined): string[] =>
  (c?.input_modalities ?? []).filter((m) => m !== "text");

/** Compact capability chip set for one engine entry: ctx + non-text inputs. */
function CapsChips({ caps }: { caps: ModelCaps | undefined }) {
  const mods = nonTextInputs(caps);
  if (!caps || (caps.context_length === undefined && mods.length === 0)) return null;
  const title = [
    caps.context_length !== undefined ? `context ${caps.context_length}` : null,
    caps.input_modalities ? `inputs: ${caps.input_modalities.join(", ")}` : null,
    caps.output_modalities ? `outputs: ${caps.output_modalities.join(", ")}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <span className="flex shrink-0 items-center gap-1" title={title}>
      {caps.context_length !== undefined && (
        <span className="rounded-pill border border-border px-1.5 py-0 text-[10px] text-dim">{fmtCtx(caps.context_length)}</span>
      )}
      {mods.map((m) => (
        <span key={m} className="rounded-pill border border-accent/50 px-1.5 py-0 text-[10px] text-accent">
          {m}
        </span>
      ))}
    </span>
  );
}

function AliasCard({
  a,
  index,
  total,
  published,
  onMove,
  srvName,
  servers,
  now,
  onEdit,
}: {
  a: AliasRow;
  index: number;
  total: number;
  // The arbiter's RESOLVED winner for this tick (the published model_aliases
  // entry joined by name). It is the routing truth — the pin when healthy and
  // group-free, else the next-best option (fallback). Null until the first
  // state poll lands.
  published: ModelAliasEntry | null;
  onMove: (dir: -1 | 1) => void;
  srvName: (id: string) => string;
  servers: ServerRow[];
  now: number;
  onEdit: () => void;
}) {
  const winnerId = a.pinned_server_id ?? a.pairs[0]?.server_id ?? "";
  const winnerPair = a.pairs.find((p) => p.server_id === winnerId) ?? a.pairs[0];
  const winnerIsPin = a.pinned_server_id !== undefined;
  const isDefault = index === 0 && total > 0;

  // The effective winner: the arbiter's RESOLVED winner once the state poll
  // has landed (the routing truth — the pin when healthy and group-free, else
  // the next-best option), else the stored pin's pair (the pre-poll display,
  // the row the server would resolve). `source` is the routing-health axis:
  // 'probed' = green, 'declared' = red (the probe never answered this tick).
  const eff = published
    ? {
        server_id: published.server_id,
        model: published.engine_model,
        source: published.catalog_source,
      }
    : winnerPair
      ? {
          server_id: winnerPair.server_id,
          model: winnerPair.model,
          source: (winnerPair.source === "probed" ? "probed" : "declared") as "probed" | "declared",
        }
      : null;

  // #87 D4: per-pair capability lookup from the row's PROBED inventory
  // (declared rows know nothing — no chips). Modality divergence across
  // the pairs of one alias is derived here, never stored.
  const capsFor = (server_id: string, model: string): ModelCaps | undefined =>
    servers.find((s) => s.id === server_id)?.models.find((m) => m.name === model);
  const knownPairs = a.pairs.filter((p) => capsFor(p.server_id, p.model)?.input_modalities !== undefined);
  const modRows = new Map<string, Set<string>>();
  for (const p of knownPairs) {
    for (const m of nonTextInputs(capsFor(p.server_id, p.model))) {
      if (!modRows.has(m)) modRows.set(m, new Set());
      modRows.get(m)!.add(`${srvName(p.server_id)} / ${p.model}`);
    }
  }
  const divergences = [...modRows.entries()].filter(([, rows]) => rows.size < knownPairs.length);

  const pin = async (server_id: string | null) => {
    if (!apiToken()) {
      toast.error("needs the arbiter API token — paste it in Settings first");
      return;
    }
    try {
      await putAlias({ alias: a.alias, pin: server_id });
      toast.success(
        server_id
          ? `${a.alias}: winner is ${srvName(server_id)}`
          : `${a.alias}: winner is the first pair`,
      );
    } catch (e) {
      toast.error(`pin failed: ${(e as Error).message}`);
    }
  };

  const del = async () => {
    if (!apiToken()) {
      toast.error("needs the arbiter API token — paste it in Settings first");
      return;
    }
    if (!window.confirm(`delete the alias ${a.alias}? the name falls back to the bare catalog routing`)) return;
    try {
      await putAlias({ alias: a.alias, delete: true });
      toast.success(`alias deleted: ${a.alias}`);
    } catch (e) {
      toast.error(`delete refused: ${(e as Error).message}`);
    }
  };

  return (
    <Card className="gap-0 py-0 shadow-none">
      <CardHeader className="flex-row items-center gap-2 px-3 py-2 pb-0">
        <span className="flex items-center gap-1.5">
          <span className="flex items-center gap-0.5" title="re-order the priority (top = highest)">
            <Button
              size="xs"
              variant="ghost"
              className="h-6 w-6 p-0 text-[11px] text-dim"
              disabled={index === 0}
              onClick={() => onMove(-1)}
              title="raise the priority (move up toward the default)"
              aria-label="raise priority"
            >
              <ArrowUp className="size-3.5" />
            </Button>
            <Button
              size="xs"
              variant="ghost"
              className="h-6 w-6 p-0 text-[11px] text-dim"
              disabled={index === total - 1}
              onClick={() => onMove(1)}
              title="lower the priority (move down)"
              aria-label="lower priority"
            >
              <ArrowDown className="size-3.5" />
            </Button>
          </span>
          <span className="w-4 text-[11px] tabular-nums text-dim" title={`priority ${index + 1} of ${total}`}>
            {index + 1}.
          </span>
        </span>
        <CardTitle className="font-mono text-[13px] font-semibold">{a.alias}</CardTitle>
        {isDefault && (
          <Badge variant="outline" className="shrink-0 rounded-pill border-accent/50 px-1.5 py-0 text-[10px] font-normal text-accent" title="the top alias — the machine’s default model (first in /v1/models, named by a minted agent config)">
            default
          </Badge>
        )}
        <CardAction className="gap-1.5">
          <Button size="xs" variant="ghost" className="h-6 px-2 text-[11px]" onClick={onEdit}>
            edit
          </Button>
          <Button size="xs" variant="outline" className="h-6 px-2 text-[11px]" onClick={() => void del()}>
            delete
          </Button>
        </CardAction>
      </CardHeader>

      <CardContent className="flex flex-col gap-2 px-3 py-2">
        <div className="flex flex-col gap-1">
          {a.pairs.map((p, i) => {
            const mark = SOURCE_MARK[p.source];
            return (
              <div key={`${p.server_id}/${p.model}-${i}`} className="flex items-center gap-2 text-[12px]">
                <span
                  className={`size-1.5 shrink-0 rounded-full ${p.source === "probed" ? "bg-ok" : p.source === "dropped" ? "bg-err" : "bg-warn"}`}
                  title={p.source}
                />
                <span className="min-w-0 truncate" title={`engine ${srvName(p.server_id)}`}>
                  {srvName(p.server_id)}
                </span>
                <span className="min-w-0 truncate font-mono text-[11px] text-dim" title="the EXACT model id this row serves">
                  {p.model}
                </span>
                <CapsChips caps={capsFor(p.server_id, p.model)} />
                {mark && (
                  <Badge
                    variant="outline"
                    className={`ml-auto shrink-0 rounded-pill px-1.5 py-0 text-[10px] font-normal ${p.source === "mismatch" || p.source === "dropped" ? "text-warn" : "text-dim"}`}
                    title={SOURCE_TITLE[p.source] ?? `pair source: ${p.source}`}
                  >
                    {mark}
                  </Badge>
                )}
              </div>
            );
          })}
        </div>

        <div className="flex items-center gap-2 text-[12px]">
          <span className="text-[11px] text-dim">winner</span>
          {eff ? (
            <>
              <span className="font-semibold">{srvName(eff.server_id)}</span>
              <code
                className={`min-w-0 truncate text-[11px] ${eff.model !== a.alias ? "text-warn" : "text-dim"}`}
                title={
                  eff.model !== a.alias
                    ? "mis-aligned with the alias name: the engine answers under its OWN id — the router splices this id into the body"
                    : "the engine's own model id"
                }
              >
                {eff.model}
              </code>
              <CapsChips
                caps={
                  published
                    ? { context_length: published.context_length, input_modalities: published.input_modalities, output_modalities: published.output_modalities }
                    : capsFor(eff.server_id, eff.model)
                }
              />
              <span
                className={`size-1.5 shrink-0 rounded-full ${eff.source === "probed" ? "bg-ok" : "bg-err"}`}
                title={probeWord(eff.source).note}
              />
              {published?.fallback && (
                <Badge variant="outline" className="rounded-pill border-err/50 px-1.5 py-0 text-[10px] font-normal text-err" title="the pin is dead (or group-blocked) — traffic moved to the next-best option">
                  re-routed from {srvName(a.pinned_server_id ?? "")}
                </Badge>
              )}
              {published?.degraded && (
                <Badge
                  variant="outline"
                  className="rounded-pill border-warn/50 px-1.5 py-0 text-[10px] font-normal text-warn"
                  title="the winner is not probe-confirmed this tick (its pair is mismatch or declared) — the alias still publishes, honestly degraded (D1); the pair marker names why"
                >
                  degraded
                </Badge>
              )}
              {!published?.fallback && a.pinned_server_id === eff.server_id && (
                <Badge variant="outline" className="rounded-pill border-accent/50 px-1.5 py-0 text-[10px] font-normal text-accent">
                  pinned
                </Badge>
              )}
              {!published && !winnerIsPin && <span className="text-[10px] text-dim">first pair</span>}
            </>
          ) : (
            <span className="text-dim">none</span>
          )}
          <span className="ml-auto flex gap-1.5">
            {winnerIsPin ? (
              <Button size="xs" variant="outline" className="h-6 px-2 text-[11px]" title="unpin — the first pair answers again" onClick={() => void pin(null)}>
                unpin
              </Button>
            ) : (
              <Select value="" onValueChange={(v) => v && void pin(v)}>
                <SelectTrigger size="sm" className="h-6 w-[92px] text-[11px]" title="pin a specific pair as the winner">
                  <SelectValue placeholder="pin…" />
                </SelectTrigger>
                <SelectContent>
                  {[...new Set(a.pairs.map((p) => p.server_id))].map((id) => (
                    <SelectItem key={id} value={id} className="text-[11px]">
                      {srvName(id)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </span>
        </div>

        <div className="text-[11px] text-dim">{now > 0 ? `updated ${ago(now - a.updated_at)}` : ""}</div>
      </CardContent>

      <CardFooter className="border-t border-border px-3 py-1.5 text-[11px] text-dim">
        <span className="flex flex-wrap items-center gap-2">
          <span title="pairs list EVERY engine that can answer this name; the winner answers with that pair's own model id">
            {a.pairs.length} pair{a.pairs.length === 1 ? "" : "s"}
          </span>
          {/* #87 D4: a modality SOME known pairs serve and others do not —
              routing to a pair that cannot see the input is the misalignment
              the operator must see before pinning multimodal traffic. */}
          {divergences.map(([mod, rows]) => {
            const missing = knownPairs
              .filter((p) => !nonTextInputs(capsFor(p.server_id, p.model)).includes(mod))
              .map((p) => `${srvName(p.server_id)} / ${p.model}`);
            return (
              <span
                key={mod}
                className="rounded-pill border border-warn/50 px-1.5 py-0 text-[10px] text-warn"
                title={`${mod}: served by ${rows.size}/${knownPairs.length} probed pairs — missing on ${missing.join(", ")}`}
              >
                {mod} {rows.size}/{knownPairs.length}
              </span>
            );
          })}
          {/* D1: the alias's OTHER pairs as secondary chips — the client
              router's failover surface (D3). Read-only here: no token rides
              the block, and this view opens no write surface for them. */}
          {(published?.fallback_targets ?? []).map((t) => (
            <span
              key={`${t.server_id}/${t.engine_model}`}
              className="rounded-pill border border-border px-1.5 py-0 text-[10px] text-dim"
              title={`fallback target (D1): ${srvName(t.server_id)} serves ${t.engine_model} at ${t.url} — the local router's one-shot failover surface if the winner is slow (D3); the arbiter never forwards, and this chip is read-only`}
            >
              ↦ {srvName(t.server_id)} / {t.engine_model}
            </span>
          ))}
        </span>
      </CardFooter>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// The add/edit dialog. Pair rows are two verbatim picks: the server row,
// then its EXACT probed model id. A stored pair the probe never confirmed
// round-trips as an explicit "(not probed — stored)" pick; NEW picks are
// probed-only (D5). The winner pin can only name a server the alias pairs
// to. Renaming an alias = delete + create (the name IS the identity).
// ---------------------------------------------------------------------------

type PairDraft = { server_id: string; model: string; unprobed?: string };

function AliasFormDialog({
  open,
  onOpenChange,
  alias,
  servers,
  existing,
  srvName,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  alias: AliasRow | null;
  servers: ServerRow[];
  existing: AliasRow[];
  srvName: (id: string) => string;
  onSaved: () => void;
}) {
  const editing = alias !== null;
  const [name, setName] = React.useState("");
  const [pairs, setPairs] = React.useState<PairDraft[]>([]);
  const [pin, setPin] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  // The insert position for a NEW alias (an index 0..existing.length into the
  // priority list; length = append at the bottom). Ignored on edit (the name
  // is the identity; re-order from the card arrows). Default = append at the
  // bottom (no silent demotion of the current default).
  const [position, setPosition] = React.useState("0");

  React.useEffect(() => {
    if (!open) return;
    setName(alias?.alias ?? "");
    setPairs(alias ? alias.pairs.map((p) => ({ server_id: p.server_id, model: p.model })) : [{ server_id: "", model: "" }]);
    setPin(alias?.pinned_server_id ?? "");
    setErr(null);
    setPosition(String(existing.length)); // append at the bottom by default
  }, [open, alias]);
  // eslint-disable-next-line react-hooks/exhaustive-deps

  // The probed inventory for a row (the pick-list), plus any stored value
  // the probe never confirmed (it round-trips verbatim, marked). #87: the
  // pick labels carry the observed caps (ctx + non-text inputs) so the
  // operator cannot pin a pair blind to a modality gap.
  const modelOptions = (server_id: string, keep: string): { value: string; label: string }[] => {
    const opts: { value: string; label: string }[] = [{ value: "", label: "— model id —" }];
    const inv = servers.find((s) => s.id === server_id)?.models ?? [];
    const label = (m: { name: string; context_length?: number; input_modalities?: string[] }): string => {
      const mods = nonTextInputs(m);
      const suffix = [m.context_length !== undefined ? fmtCtx(m.context_length) : null, ...mods]
        .filter((x): x is string => Boolean(x))
        .join(" · ");
      return suffix ? `${m.name}  (${suffix})` : m.name;
    };
    if (keep && !inv.some((m) => m.name === keep)) opts.push({ value: keep, label: `${keep} (not probed — stored)` });
    for (const m of inv) opts.push({ value: m.name, label: label(m) });
    if (inv.length === 0 && !keep) opts.push({ value: "", label: "(no probed inventory for that row)" });
    return opts;
  };

  const setPair = (i: number, patch: Partial<PairDraft>) => {
    setPairs((ps) => ps.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  };

  const save = async () => {
    setSaving(true);
    setErr(null);
    const aliasName = editing ? alias!.alias : name.trim();
    if (!aliasName) {
      setErr("an alias name is required");
      setSaving(false);
      return;
    }
    if (!editing && existing.some((x) => x.alias === aliasName)) {
      setErr("an alias with that name already exists — edit it from its row (rename = delete + create)");
      setSaving(false);
      return;
    }
    const rows: { server_id: string; model: string }[] = [];
    for (const r of pairs) {
      if (!r.server_id && !r.model) continue; // an untouched empty row is noise
      if (!r.server_id || !r.model) {
        setErr("a pair needs BOTH the engine row and its model id");
        setSaving(false);
        return;
      }
      rows.push({ server_id: r.server_id, model: r.model });
    }
    if (rows.length === 0) {
      setErr("at least one pair is required");
      setSaving(false);
      return;
    }
    const seen = new Set<string>();
    for (const r of rows) {
      const k = `${r.server_id}::${r.model}`;
      if (seen.has(k)) {
        setErr(`duplicate pair: ${srvName(r.server_id)} / ${r.model}`);
        setSaving(false);
        return;
      }
      seen.add(k);
    }
    if (pin && !rows.some((r) => r.server_id === pin)) {
      setErr("the winner pin must name a row the alias pairs to");
      setSaving(false);
      return;
    }

    // Patch-by-difference against the stored row: unchanged pairs/pin are
    // NOT in the body (the server keeps what it holds).
    const stored = editing ? alias! : null;
    const body: { alias: string; pairs?: { server_id: string; model: string }[]; pin?: string | null } = { alias: aliasName };
    const same =
      stored !== null &&
      stored.pairs.length === rows.length &&
      stored.pairs.every((p, i) => p.server_id === rows[i].server_id && p.model === rows[i].model);
    if (!same) body.pairs = rows;
    const storedPin = (stored?.pinned_server_id ?? "") || "";
    if (pin !== storedPin) body.pin = pin || null;
    if (Object.keys(body).length === 1) {
      setErr("nothing to save — the pairs and the winner already match");
      setSaving(false);
      return;
    }
    try {
      await putAlias(body);
      // A NEW alias: place it at the chosen insert position. The create
      // appended it at the BOTTOM (stored insertion order), so only a
      // position above the last index is a real move; re-order to land it.
      if (!editing) {
        const others = existing.map((x) => x.alias);
        const pos = Math.max(0, Math.min(parseInt(position, 10) || 0, others.length));
        const order = [...others.slice(0, pos), aliasName, ...others.slice(pos)];
        if (pos < others.length) await putAlias({ order });
      }
      onSaved();
      onOpenChange(false);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const pinIds = [...new Set(pairs.map((p) => p.server_id).filter(Boolean))];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg font-mono text-[12px]">
        <DialogHeader>
          <DialogTitle className="text-[13px]">{editing ? `edit ${alias!.alias}` : "add an alias"}</DialogTitle>
          <DialogDescription className="text-[11px]">
            a pair = the engine row + its EXACT probed model id. The winner answers with that pair's own model id (the local router rewrites the request body).
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          {editing ? (
            <div className="flex items-center gap-2">
              <span className="text-dim">alias</span>
              <code>{alias!.alias}</code>
            </div>
          ) : (
            <>
              <label className="flex flex-col gap-1">
                <span className="text-dim">alias name (≤128 printable chars)</span>
                <Input className="h-7 text-[12px]" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Qwen3.Flagship" maxLength={128} />
              </label>
              <label className="flex items-center gap-2">
                <span className="text-dim">insert position (priority)</span>
                <Select value={position} onValueChange={setPosition}>
                  <SelectTrigger size="sm" className="h-7 w-[200px] text-[12px]">
                    <SelectValue placeholder="— position —" />
                  </SelectTrigger>
                  <SelectContent>
                    {existing.length === 0 ? (
                      <SelectItem value="0" className="text-[12px]">
                        the only alias (top)
                      </SelectItem>
                    ) : (
                      <>
                        <SelectItem value="0" className="text-[12px]">
                          1 · top — becomes the default
                        </SelectItem>
                        {existing.map((x, i) =>
                          i < existing.length - 1 ? (
                            <SelectItem key={x.alias} value={String(i + 1)} className="text-[12px]">
                              {i + 2} · after {x.alias}
                            </SelectItem>
                          ) : null,
                        )}
                        <SelectItem value={String(existing.length)} className="text-[12px]">
                          {existing.length + 1} · bottom (after {existing[existing.length - 1]!.alias})
                        </SelectItem>
                      </>
                    )}
                  </SelectContent>
                </Select>
              </label>
            </>
          )}

          <div className="flex flex-col gap-1.5">
            {pairs.map((p, i) => (
              <div key={i} className="flex items-center gap-1.5">
                <Select value={p.server_id} onValueChange={(v) => setPair(i, { server_id: v, model: "" })}>
                  <SelectTrigger size="sm" className="h-7 flex-1 text-[12px]" title="the declared engine row this pair points at">
                    <SelectValue placeholder="— engine row —" />
                  </SelectTrigger>
                  <SelectContent>
                    {servers.map((s) => (
                      <SelectItem key={s.id} value={s.id} className="text-[12px]">
                        {s.name} · {s.url}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select value={p.model} onValueChange={(v) => setPair(i, { model: v })}>
                  <SelectTrigger size="sm" className="h-7 flex-1 text-[12px]" title="the EXACT model id this row's probe reported">
                    <SelectValue placeholder="— model id —" />
                  </SelectTrigger>
                  <SelectContent>
                    {modelOptions(p.server_id, p.model).map((o) => (
                      <SelectItem key={o.value || "empty"} value={o.value} disabled={o.value === ""} className="text-[12px]">
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  size="xs"
                  variant="ghost"
                  className="h-7 px-2 text-[12px] text-dim"
                  title="remove this pair"
                  onClick={() => setPairs((ps) => (ps.length > 1 ? ps.filter((_, j) => j !== i) : ps.map((x, j) => (j === i ? { server_id: "", model: "" } : x))))}
                >
                  ×
                </Button>
              </div>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="xs"
              variant="outline"
              className="h-6 px-2 text-[11px]"
              onClick={() => setPairs((ps) => [...ps, { server_id: "", model: "" }])}
            >
              + pair
            </Button>
            <span className="text-[11px] text-dim">a pair = the engine row + its EXACT probed model id</span>
          </div>

          <label className="flex items-center gap-2">
            <span className="text-dim">winner (pin)</span>
            <Select value={pin} onValueChange={setPin}>
              <SelectTrigger size="sm" className="h-7 w-[180px] text-[12px]">
                <SelectValue placeholder="first pair (default)" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="" className="text-[12px]">first pair (default)</SelectItem>
                {pinIds.map((id) => (
                  <SelectItem key={id} value={id} className="text-[12px]">
                    pin {srvName(id)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>

          {err && <div className="border border-err/40 bg-err/10 px-2 py-1.5 text-[11px] text-err">{err}</div>}
        </div>
        <DialogFooter>
          <Button size="sm" variant="outline" className="h-7 text-[12px]" onClick={() => onOpenChange(false)}>
            cancel
          </Button>
          <Button size="sm" className="h-7 text-[12px]" disabled={saving} onClick={() => void save()}>
            {saving ? "saving…" : editing ? "save changes" : "add alias"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// #85 slice C: HERMES MODEL ACCESS — the read-only cross-check strip. What
// each client's Hermes gateway SERVES (`GET /v1/models`) and what each
// profile could SWITCH TO (`GET /api/model/options?include_unconfigured=
// false`) arrive as the `hermes_models`/`hermes_model_options` ADD-keys on
// the register heartbeat (harvested at most once per connector round,
// sanitized client-side AND at the arbiter edge) and ride /api/state's
// client rows. Exception-only: a machine whose client never reported the
// blocks (old client, connector off, gateway outage) renders NOTHING —
// never an empty list pretending to be truth.
//
// The only diff-style claim is per SERVED model id: a model the gateway
// answers as that idlefill never wires (no alias names it, no engine
// inventory carries it — EXACT match only, the #66 D5 posture) shows as a
// warn chip. The provider catalog is the profile's SWITCH vocabulary —
// rendered as counts/names, never name-by-name diffed against GGUF ids
// (different vocabularies; a 100-name wall is noise, not signal). READ-
// ONLY: zero buttons/onClick — the model set/switch verbs are not in
// idlefill's surface at all.
// ---------------------------------------------------------------------------

const NAMES_INLINE = 6; // model names shown under the current provider before "+N more"

function HermesModelAccess({ st }: { st: StateSnapshot | null }) {
  const clients = (st?.clients ?? []).filter((c) => hasModelAccess(c));
  if (clients.length === 0) return null;
  const wired = idlefillWiredNames(st);
  return (
    <div className="mt-4">
      <h2 className="mb-1 text-[12px] font-semibold uppercase tracking-wide text-dim">{HERMES_MODEL_ACCESS_LABEL}</h2>
      <p className="mb-2 text-[11px] text-dim">
        what each machine’s Hermes gateway serves and what its profiles could switch to (gateway read once per
        connector round — read-only, no switch verb here); served models idlefill never wires are named in warn.
      </p>
      <div className="grid gap-2.5 [grid-template-columns:repeat(auto-fit,minmax(340px,1fr))]">
        {clients.map((c) => (
          <ClientModelCard key={c.client_id} c={c} wired={wired} />
        ))}
      </div>
    </div>
  );
}

function ClientModelCard({ c, wired }: { c: NonNullable<StateSnapshot["clients"]>[number]; wired: Set<string> }) {
  const servedByProfile = groupModelsByProfile(c.hermes_models);
  const providersByProfile = groupProvidersByProfile(c.hermes_model_options);
  const profiles = [...new Set([...servedByProfile.keys(), ...providersByProfile.keys()])].sort();
  return (
    <Card className="py-3 shadow-none">
      <CardHeader className="px-4 pb-1">
        <CardTitle className="text-[12px]">{c.name}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 px-4">
        {profiles.map((profile) => {
          const served = servedByProfile.get(profile) ?? [];
          const providers = providersByProfile.get(profile) ?? [];
          const gaps = servedModelGaps(served, wired);
          const current = currentProviderOf(providers);
          const others = providers.filter((p) => p !== current);
          return (
            <div key={profile} className="flex flex-wrap items-center gap-1 text-[11px]">
              <span className="text-[10px] font-semibold uppercase text-dim" title="the Hermes profile these rows belong to (stamped by the connector)">
                {profile}
              </span>
              {served.map((m) => (
                <span
                  key={`m:${m.id}`}
                  className={`rounded-pill border px-1.5 py-0 text-[10px] ${gaps.includes(m.id) ? "border-warn/50 text-warn" : "border-border text-dim"}`}
                  title={[
                    `served model ${m.id}${m.root ? ` (root: ${m.root})` : ""}`,
                    gaps.includes(m.id) ? "— not wired in idlefill (no alias name, no engine inventory id matches)" : "— an alias or engine inventory names it",
                    "(gateway /v1/models — read-only)",
                  ].join(" ")}
                >
                  {m.id}
                </span>
              ))}
              {current && (
                <span
                  key={`p:${current.slug}`}
                  className="rounded-pill border border-border bg-background/40 px-1.5 py-0 text-[10px] text-dim"
                  title={[
                    `current provider: ${current.slug}`,
                    current.authenticated === true ? "authenticated" : null,
                    typeof current.total_models === "number" ? `${current.total_models} models available` : null,
                    current.models_truncated ? "name list truncated" : null,
                    "(gateway /api/model/options — read-only)",
                  ]
                    .filter(Boolean)
                    .join(" — ")}
                >
                  {current.slug}
                  <span className="text-dim/60"> · current</span>
                </span>
              )}
              {current?.models?.slice(0, NAMES_INLINE).map((n) => (
                <span key={`pn:${n}`} className="rounded-pill border border-border/60 px-1.5 py-0 text-[10px] text-dim/70" title={`model ${n} under ${current.slug} (switchable — read-only)`}>
                  {n}
                </span>
              ))}
              {current && (current.models?.length ?? 0) > NAMES_INLINE && (
                <span className="text-[10px] text-dim" title={`${current.models?.length ?? 0} names survived the connector cap${current.models_truncated ? " of a longer gateway list" : ""}`}>
                  +{(current.models?.length ?? 0) - NAMES_INLINE} more
                </span>
              )}
              {others.length > 0 && (
                <span
                  className="text-[10px] text-dim"
                  title={others.map((p) => `${p.slug}${typeof p.total_models === "number" ? ` (${p.total_models})` : ""}${p.models_truncated ? " †" : ""}`).join(", ")}
                >
                  +{others.length} switchable {others.length === 1 ? "provider" : "providers"}
                </span>
              )}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
