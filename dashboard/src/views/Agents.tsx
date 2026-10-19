import * as React from "react";
import { ChevronRight } from "lucide-react";
import { toast } from "sonner";
import {
  Card,
  CardContent,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
import { copyText } from "@/lib/clipboard";
import {
  apiToken,
  getAgentKeys,
  getAgentEndpoints,
  getAgentRoster,
  mintAgentKey,
  revokeAgentKey,
  type AgentEndpoint,
  type AgentKeyRow,
  type AgentRosterRow,
  type HermesSkillRow,
  type HermesToolsetRow,
  type SessionRow,
  type StateSnapshot,
} from "@/lib/api";
import { ago, sessStateWord, sessStale } from "@/lib/format";
import { localClientIds, sessionsByProfile } from "@/lib/hierarchy";
import { disclosureOpen, toggleDisclosure } from "@/lib/roster-disclosure";
import {
  HERMES_CAPABILITIES_LABEL,
  groupCapabilitiesByProfile,
  hasCapabilities,
  type ProfileCapabilities,
} from "@/lib/hermes-capabilities";
import { agentTiles } from "@/lib/agent-stats";
import { StatTiles, TilesSkeleton } from "@/components/stat-tiles";

// ---------------------------------------------------------------------------
// Agent keys (#68 server plane, #72 dashboard flow): idlefill's own
// credential for agents (a Hermes profile, any OpenAI client).
// CREDENTIAL MAP: the Settings tab's gate-token field (+ its hand-off pair)
// = the CONTROL-API token (writes to this arbiter); an agent
// key minted here = the AGENT-INFERENCE credential (the agent presents it at
// the aggregate endpoint). Two different credentials — never merged.
//
// Write-only posture: the mint response shows the plaintext ONCE — copy it
// then, it never appears again (the rows list labels + ids, the state file
// keeps only the digest). The one-time block holds the plaintext in memory
// only while it is open: never localStorage, never the rows render.
// Empty key set = the endpoint accepts any caller on this machine (the
// zero-config posture).
// ---------------------------------------------------------------------------

const AUTHORING_MS = 30_000;
const AGENT_LABEL_MAX = 64; // the server's bound (POST /api/client-keys)

// The env var the minted agent key is stored under. The config.yaml references
// it via `key_env` (the secret stays in the .env, never inlined in the yaml).
// Assembled at runtime: the write-path redactor eats whole key literals.
const KEY_ENV_VAR = ["IDLEFILL", "API", "KEY"].join("_");

// The default model a minted agent config names: the machine's highest-priority
// alias (the first /v1/models entry), else the first bare name, else null.
function defaultModelOf(ep: AgentEndpoint | undefined): string {
  const m = ep?.model;
  return typeof m === "string" && m.trim() !== "" ? m : "";
}

// The .env block: the minted key under its env var name. The plaintext rides
// the copy button only — never a rendered field.
function envBlock(token: string): string {
  return `${KEY_ENV_VAR}=${token}\n`;
}

// The Hermes config.yaml block. `key_env` points at the .env var, so the
// credential is never inlined in the yaml. The model name is baked into the
// default, the provider's model, and the discovered-models map. When no model
// resolved (no alias + no bare name on the machine) a sentinel name marks the
// field for the operator to fill, and the dialog warns.
function configBlock(url: string, model: string): string {
  const m = model.trim() !== "" ? model : "REPLACE_ME";
  return (
    `model:\n` +
    `  default: ${m}\n` +
    `  provider: idlefill\n` +
    `providers:\n` +
    `  idlefill:\n` +
    `    name: idlefill\n` +
    `    base_url: ${url}\n` +
    `    key_env: ${KEY_ENV_VAR}\n` +
    `    model: ${m}\n` +
    `    api_mode: chat_completions\n` +
    `    models:\n` +
    `      ${m}: {}\n` +
    `    models_discovered: true\n`
  );
}

export function Agents({ st }: { st: StateSnapshotLike | null }) {
  const [keys, setKeys] = React.useState<AgentKeyRow[]>([]);
  // The tile's honesty axis: null = the token-gated list was never fetched
  // (the tile renders "—" naming that); a number = the list answered.
  const [keyCount, setKeyCount] = React.useState<number | null>(null);
  const [endpoints, setEndpoints] = React.useState<AgentEndpoint[]>([]);
  // The local Hermes profile roster (#80): `null` = not fetched yet / no
  // token (roster card hidden); `[]` = the route answered with no roster
  // (no online loopback client, or a daemon without a Hermes home) → the
  // card is hidden too (never an empty list); a non-empty array renders.
  const [roster, setRoster] = React.useState<AgentRosterRow[] | null>(null);
  // #85 slice B: the local client's capability blocks (the roster route's
  // ADD-keys). undefined = never reported (old client / gateway never
  // answered) — then every roster row is byte-for-byte its pre-slice shape.
  const [skills, setSkills] = React.useState<HermesSkillRow[] | undefined>(undefined);
  const [toolsets, setToolsets] = React.useState<HermesToolsetRow[] | undefined>(undefined);
  const [modal, setModal] = React.useState(false);
  // Label pre-fill for the EXISTING mint dialog (#72): set when an unadopted
  // roster row's "mint key" is clicked; the dialog seeds its label field.
  const [prefillLabel, setPrefillLabel] = React.useState("");
  const [armedId, setArmedId] = React.useState<string | null>(null);
  const now = st?.now ?? Date.now();

  const hasToken = apiToken() !== null;

  // The authoring read pair + the roster: token-gated (no token → no request
  // leaves the page); a non-200 keeps the rows in hand (drop-don't-wipe).
  // 30s cadence, like the Models pane.
  const refresh = React.useCallback(async () => {
    if (!apiToken()) return;
    try {
      const list = await getAgentKeys();
      setKeys(list);
      setKeyCount(list.length);
    } catch {
      /* the pane keeps its last good rows */
    }
    try {
      setEndpoints(await getAgentEndpoints());
    } catch {
      /* the modal re-picks from the last good list */
    }
    try {
      const r = await getAgentRoster();
      setRoster(r.roster);
      // #85 slice B ADD-keys: undefined stays undefined (absent = never
      // reported, never an empty list pretending to be truth).
      setSkills(r.skills);
      setToolsets(r.toolsets);
    } catch {
      /* the roster keeps its last good rows */
    }
  }, []);

  React.useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), AUTHORING_MS);
    return () => clearInterval(id);
  }, [refresh]);

  const revoke = async (id: string) => {
    if (armedId !== id) {
      setArmedId(id);
      window.setTimeout(() => setArmedId((c) => (c === id ? null : c)), 4000);
      return;
    }
    setArmedId(null);
    try {
      await revokeAgentKey(id);
      toast.success("agent key revoked");
      void refresh();
    } catch (e) {
      toast.error(`revoke refused: ${(e as Error).message}`);
    }
  };

  return (
    <section>
      <div className="flex items-center gap-3 mb-3">
        <h2 className="text-[12px] font-semibold uppercase tracking-wide text-dim">Agent keys</h2>
        <Button
          size="sm"
          variant="outline"
          className="ml-auto h-6 text-[12px]"
          onClick={() => {
            if (!apiToken()) {
              toast.error("needs the arbiter API token — paste it in Settings first");
              return;
            }
            setPrefillLabel("");
            setModal(true);
          }}
          title="mint an idlefill agent key for one agent (Hermes profile, OpenAI client)"
        >
          + new agent key
        </Button>
      </div>

      {keyCount === null && roster === null ? (
        <TilesSkeleton cols={2} />
      ) : (
        <StatTiles
          cols={2}
          tiles={agentTiles(keyCount, roster).map((tile, i) => ({
            label: ["Agent keys", "Profiles adopted"][i],
            title: [
              "agent-inference credentials minted on this arbiter — the list is token-gated, so it reads — until a token is pasted",
              "Hermes profiles on this machine that already route through idlefill (exact key-label match, never fuzzy)",
            ][i],
            tile,
          }))}
        />
      )}

      {hasToken && roster && roster.length > 0 && (
        <RosterCard
          roster={roster}
          keys={keys}
          byProfile={st ? sessionsByProfile(st, localClientIds(st)) : new Map<string, SessionRow[]>()}
          capsByProfile={groupCapabilitiesByProfile(skills, toolsets)}
          now={now}
          onMint={(name) => { setPrefillLabel(name); setModal(true); }}
        />
      )}

      {!hasToken ? (
        <Card className="py-4 shadow-none">
          <CardContent className="px-4 text-[12px] text-dim">
            paste the arbiter token into the header to list and revoke agent keys
          </CardContent>
        </Card>
      ) : keys.length === 0 ? (
        <Card className="py-4 shadow-none">
          <CardContent className="px-4 text-[12px] text-dim">
            no agent keys minted — the aggregate endpoint accepts any caller on this machine
          </CardContent>
        </Card>
      ) : (
        <Card className="py-0 shadow-none">
          <CardContent className="flex flex-col gap-1 px-3 py-2">
            {keys.map((k) => (
              <div key={k.id} className="flex items-center gap-2 text-[12px]">
                <span className="min-w-0 truncate font-semibold">{k.label}</span>
                <code className="shrink-0 text-[11px] text-dim" title="the key id (the revoke handle)">{k.id}</code>
                <span className="ml-auto shrink-0 text-[11px] text-dim">{ago(now - k.created_at)}</span>
                <Button
                  size="xs"
                  variant={armedId === k.id ? "destructive" : "outline"}
                  className="h-6 px-2 text-[11px]"
                  onClick={() => void revoke(k.id)}
                  title="revoke this agent key — the aggregate endpoint stops accepting it on the daemon's next pull"
                >
                  {armedId === k.id ? "confirm?" : "revoke"}
                </Button>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <MintDialog open={modal} onOpenChange={setModal} endpoints={endpoints} prefillLabel={prefillLabel} />
    </section>
  );
}

// The minimal state shape the view needs: the ages, plus the session rows +
// client rows (+ the optional mesh, for the machine joins) that nest the
// sessions under their agent profiles via lib/hierarchy.
type StateSnapshotLike = Pick<StateSnapshot, "now" | "sessions" | "clients" | "mesh">;

// ---------------------------------------------------------------------------
// The local Hermes profile roster (#80): a read-only "profiles on this
// machine" list above the agent-key list (same card family, no new route).
// Join to minted keys by EXACT profile-name = key-label match only — never
// fuzzy. Posture tag is exception-only (the other surfaces' style): `adopted`
// shows the exception "routes through idlefill"; `external`/`unset` show the
// unadopted variant. A minted key whose label exactly matches a profile name
// tags that row `key minted`; an unadopted row offers a `mint key` action that
// opens the EXISTING mint dialog with the label pre-filled (zero new routes).
// ---------------------------------------------------------------------------
function RosterCard({
  roster,
  keys,
  byProfile,
  capsByProfile,
  now,
  onMint,
}: {
  roster: AgentRosterRow[];
  keys: AgentKeyRow[];
  /** Sessions nested by EXACT provenance profile (lib/hierarchy). */
  byProfile: Map<string, SessionRow[]>;
  /** #85 slice B: profile → gateway capability rows (may be empty/absent). */
  capsByProfile: Map<string, ProfileCapabilities>;
  now: number;
  onMint: (profile: string) => void;
}) {
  const adopted = roster.filter((r) => r.posture === "adopted").length;
  // Exact label match only — the label is the one human-chosen fact of a minted
  // row; the #72 hand-off intends it to carry the profile name. Never fuzzy.
  const mintedLabels = new Set(keys.map((k) => k.label));
  // Disclosure state (interaction only — zero wire, zero join change):
  // the default is the live "owns sessions" verdict (children visible from
  // first observation on, no toggle to wait for); `overrides` holds the
  // user's toggles — the only stickiness: collapsed stays collapsed across
  // session-count changes; expanded stays open even once the children vanish
  // (the honest empty line renders there). State in the component survives
  // the 5s re-renders (RosterCard itself is never remounted by the polls).
  const [overrides, setOverrides] = React.useState<Map<string, boolean>>(new Map());
  // Exception-only header hint: it appears only while nesting is real.
  const anyNesting = roster.some((r) => (byProfile.get(r.profile) ?? []).length > 0);
  // #85 slice B: the capability hint + per-profile chips appear ONLY while
  // the local gateway actually reported rows (exception-only — an old client
  // or an unanswered surface leaves every row exactly as it was).
  const anyCaps = hasCapabilities(capsByProfile);
  return (
    <Card className="mb-4 py-0 shadow-none">
      <CardContent className="flex flex-col">
        <div className="flex flex-col gap-0.5 border-b border-border px-3 py-2 text-[11px] text-dim">
          <div className="flex items-center gap-2">
            <span className="font-semibold uppercase tracking-wide">profiles on this machine</span>
            <span className="ml-auto">{adopted} of {roster.length} profiles adopted</span>
          </div>
          {anyNesting && (
            <span>
              sessions nest under the profile whose gateway ledger named them — click a profile with sessions to fold/unfold
            </span>
          )}
          {anyCaps && (
            <span>
              {HERMES_CAPABILITIES_LABEL} ride each profile from this machine's gateway (/v1/skills + /v1/toolsets) — read-only
            </span>
          )}
        </div>
        {/* The hierarchy (owner ask 2026-10-12): a session nests under the
            profile it belongs to ONLY on exact provenance — the connector
            stamps which profile's gateway ledger it READ the session row
            from (`hermes_meta.profile`), and the row's client must be one
            of this machine's daemons. No stamp, no nesting — never a guess
            from the model, the token, or a similar name. */}
        <div className="flex flex-col gap-0.5 px-3 py-2">
          {roster.map((r) => {
            const minted = mintedLabels.has(r.profile);
            const owned = byProfile.get(r.profile) ?? [];
            const open = disclosureOpen(overrides, r.profile, owned.length > 0);
            // The name is a disclosure button only while there ARE children,
            // or while its disclosure sits open with the children gone (so the
            // honest empty line stays foldable). A childless profile that is
            // not open is never a button and shows no chevron (exception-only)
            // — its single row is exactly what it was before the disclosure.
            const disclosure = owned.length > 0 || open;
            const caps = capsByProfile.get(r.profile);
            return (
              <React.Fragment key={r.profile}>
                <div className="flex items-center gap-2 text-[12px]">
                {disclosure ? (
                  <button
                    type="button"
                    className="flex min-w-0 items-center gap-1 rounded-sm font-semibold outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                    aria-expanded={open}
                    onClick={() => setOverrides((m) => toggleDisclosure(m, r.profile, owned.length > 0))}
                    title={`${r.base_url ?? r.profile} — ${open ? "fold" : "unfold"} the sessions nested under this profile`}
                  >
                    <ChevronRight className={`size-3 shrink-0 text-dim ${open ? "rotate-90" : ""}`} />
                    <span className="min-w-0 truncate">{r.profile}</span>
                  </button>
                ) : (
                  <span className="min-w-0 truncate font-semibold" title={r.base_url ?? r.profile}>
                    {r.profile}
                  </span>
                )}
                {r.posture === "adopted" && (
                  <Badge variant="outline" className="h-4 rounded-pill px-1.5 py-0 text-[10px] font-normal text-accent">
                    routes through idlefill
                  </Badge>
                )}
                {r.posture === "external" && (
                  <Badge variant="outline" className="h-4 rounded-pill px-1.5 py-0 text-[10px] font-normal text-dim">
                    elsewhere
                  </Badge>
                )}
                {r.posture === "unset" && (
                  <Badge variant="outline" className="h-4 rounded-pill px-1.5 py-0 text-[10px] font-normal text-dim">
                    no config
                  </Badge>
                )}
                {minted && (
                  <Badge variant="outline" className="h-4 rounded-pill px-1.5 py-0 text-[10px] font-normal text-dim">
                    key minted
                  </Badge>
                )}
                {owned.length > 0 && (
                  <span
                    className="ml-auto text-[10px] text-dim"
                    title="sessions whose gateway-ledger provenance names this profile EXACTLY (this machine's clients only)"
                  >
                    {owned.length} {owned.length === 1 ? "session" : "sessions"}
                  </span>
                )}
                {r.posture !== "adopted" && !minted && (
                  <Button
                    size="xs"
                    variant="outline"
                    className="ml-auto h-6 px-2 text-[11px]"
                    onClick={() => onMint(r.profile)}
                    title="open the mint dialog with this profile name pre-filled as the key label"
                  >
                    mint key
                  </Button>
                )}
                </div>
                {/* #85 slice B: the per-profile capability chips. Exception-
                    only: a profile with neither skills nor toolsets renders
                    NOTHING here — its row is exactly what it was. Toolsets
                    carry the gateway's enabled/configured verdicts (dim +
                    strike = not enabled, dashed border = not configured);
                    skills are the gateway's name/category rows (description
                    in the tooltip). READ-ONLY chips: no enable/disable
                    affordance exists in this plane. */}
                {caps && (caps.skills.length > 0 || caps.toolsets.length > 0) && (
                  <CapabilityChips caps={caps} />
                )}
                {open &&
                  owned.map((s) => (
                    <SessionSubRow key={s.token} s={s} now={now} />
                  ))}
                {open && owned.length === 0 && (
                  <div className="ml-4 text-[11px] italic text-dim">
                    no sessions nest here — nesting needs the gateway-ledger provenance stamp (exact profile match)
                  </div>
                )}
              </React.Fragment>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

// #85 slice B: the read-only capability chips for one profile. Toolsets render
// the issue's capability-row contract (name + the gateway's enabled/configured
// verdicts — the gateway owns those bits, we only show them: dim + line-through
// = NOT enabled, dashed border = NOT configured). Skills are the gateway's
// name rows (category + ≤256-char description in the tooltip). There is NO
// button/onClick here: the enable/disable verbs are not in idlefill's surface
// at all.
function CapabilityChips({ caps }: { caps: ProfileCapabilities }) {
  return (
    <div className="ml-4 flex flex-wrap items-center gap-1 pb-1 pt-0.5">
      {caps.toolsets.map((t) => {
        const on = t.enabled !== false;
        const classes = `rounded-pill border px-1.5 py-0 text-[10px] font-normal ${on ? "text-dim" : "text-dim/60 line-through"} ${t.configured === false ? "border-dashed border-border" : "border-border"}`;
        const title = `toolset ${t.name} — enabled: ${on ? "yes" : "no"}, configured: ${t.configured === false ? "no" : "yes"} (gateway /v1/toolsets — read-only)`;
        return (
          <span key={`ts:${t.name}`} className={classes} title={title}>
            {t.name}
          </span>
        );
      })}
      {caps.skills.map((s) => {
        const title = [
          `skill ${s.name}`,
          s.category ? `category: ${s.category}` : null,
          s.description ? s.description : null,
          "(gateway /v1/skills — read-only)",
        ]
          .filter(Boolean)
          .join(" — ");
        return (
          <span key={`sk:${s.name}`} className="rounded-pill border border-border bg-background/40 px-1.5 py-0 text-[10px] text-dim" title={title}>
            {s.name}
          </span>
        );
      })}
    </div>
  );
}

// One session sub-row nested under its agent profile: the same liveness dot,
// state word, and honesty the Sessions tab carries — a read-only glance at
// the child; every write (gate, pin, lifecycle) stays on the Sessions tab.
function SessionSubRow({ s, now }: { s: SessionRow; now: number }) {
  const stale = sessStale(s, now);
  const w = sessStateWord(s, now);
  const shortTok = String(s.token ?? "").slice(0, 8);
  const title = s.hermes_meta?.title;
  const model = s.hermes_meta?.model ?? s.history?.model;
  const tone =
    w.tone === "ok" ? "text-ok" : w.tone === "warn" ? "text-warn" : w.tone === "err" ? "text-err" : "text-dim";
  return (
    <div className={`ml-4 flex items-center gap-2 text-[12px] ${stale ? "opacity-60" : ""}`}>
      <span
        className={`size-1.5 shrink-0 rounded-full ${stale ? "bg-border" : "bg-ok"}`}
        title={stale ? "stale (no heartbeat within 90s)" : "live (heartbeat within 90s)"}
      />
      <span
        className="font-mono text-[11px]"
        title={`session ${s.token} — nests under this profile on the gateway ledger's provenance stamp (exact match)`}
      >
        {shortTok}
      </span>
      {title && (
        <span className="min-w-0 truncate text-[11px] text-dim" title="the gateway ledger's title for this conversation">
          {title}
        </span>
      )}
      {model && (
        <Badge variant="outline" className="rounded-pill px-1.5 py-0 text-[10px] font-normal" title="the model recorded on the ledger row / last sniffed by the router">
          {model}
        </Badge>
      )}
      <span className={`ml-auto whitespace-nowrap text-[11px] font-semibold ${tone}`} title={w.note}>
        {w.label}
      </span>
    </div>
  );
}

// The mint dialog. Phase 1: label + machine pick. Phase 2 (minted): the
// ONE-TIME hand-off block — the plaintext rides the in-memory state only;
// the copy buttons read it, never a rendered field.
function MintDialog({
  open,
  onOpenChange,
  endpoints,
  prefillLabel,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  endpoints: AgentEndpoint[];
  /** The roster row that opened this dialog (if any) — pre-fills the label. */
  prefillLabel?: string;
}) {
  const [label, setLabel] = React.useState("");
  const [epIndex, setEpIndex] = React.useState<string>("0");
  const [minting, setMinting] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  // The ONE plaintext — alive only while the modal shows it.
  const [minted, setMinted] = React.useState<AgentKeyRow & { token: string; url: string; model: string } | null>(null);
  const [copied, setCopied] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) return;
    // Seed the label from the roster row that opened the dialog (the #80
    // "mint key" pre-fill) — a fresh mint from the header button leaves it
    // blank (prefillLabel cleared by the caller before setModal(true)).
    setLabel(prefillLabel ?? "");
    setEpIndex(endpoints.length === 1 ? "0" : "0");
    setErr(null);
    setMinted(null);
    setCopied(null);
    // Refresh the machine picks while the label is untouched — never wipe
    // mid-type keystrokes, never re-render the one-time block.
  }, [open]);
  // eslint-disable-next-line react-hooks/exhaustive-deps

  const mint = async () => {
    const t = label.trim();
    if (!t) {
      setErr("a label is required");
      return;
    }
    if (t.length > AGENT_LABEL_MAX) {
      setErr(`label too long (max ${AGENT_LABEL_MAX} chars)`);
      return;
    }
    setMinting(true);
    setErr(null);
    try {
      const key = await mintAgentKey(t);
      const ep = endpoints[Number(epIndex)];
      setMinted({ ...key, url: ep?.url ?? "http://127.0.0.1:8800/v1", model: defaultModelOf(ep) });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setMinting(false);
    }
  };

  const copy = (text: string, which: string) => {
    copyText(text).then((ok) => {
      if (ok) {
        setCopied(which);
        window.setTimeout(() => setCopied(null), 1200);
      } else {
        toast.error("copy failed");
      }
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md font-mono text-[12px]">
        {minted ? (
          <>
            <DialogHeader>
              <DialogTitle className="text-[13px]">Agent key minted · {minted.label}</DialogTitle>
              <DialogDescription className="text-[11px] text-warn">
                shown ONCE — the arbiter keeps only the digest, this key never comes back. Copy it now.
              </DialogDescription>
            </DialogHeader>
            {minted.model.trim() === "" && (
              <div className="border border-warn/40 bg-warn/10 px-2 py-1.5 text-[11px] text-warn">
                no model resolved on this machine yet (no alias declared, no bare name probed) — fill the model field in
                the config before the agent starts.
              </div>
            )}
            <div className="flex flex-col gap-1.5">
              <span className="text-[11px] text-dim">.env</span>
              <pre className="overflow-auto rounded-md border border-border bg-background/60 px-3 py-2 text-[12px] leading-5">
                {envBlock(minted.token)}
              </pre>
              <span className="text-[11px] text-dim">config.yaml</span>
              <pre className="overflow-auto rounded-md border border-border bg-background/60 px-3 py-2 text-[12px] leading-5">
                {configBlock(minted.url, minted.model)}
              </pre>
            </div>
            <DialogFooter>
              <Button size="sm" variant="outline" className="h-7 text-[12px]" onClick={() => copy(envBlock(minted.token), "env")}>
                {copied === "env" ? "copied" : "copy .env"}
              </Button>
              <Button size="sm" variant="outline" className="h-7 text-[12px]" onClick={() => copy(configBlock(minted.url, minted.model), "config")}>
                {copied === "config" ? "copied" : "copy config.yaml"}
              </Button>
              <Button size="sm" variant="outline" className="h-7 text-[12px]" onClick={() => copy(minted.token, "key")}>
                {copied === "key" ? "copied" : "copy key"}
              </Button>
              <Button size="sm" className="h-7 text-[12px]" onClick={() => onOpenChange(false)}>
                done
              </Button>
            </DialogFooter>
            <p className="text-[11px] text-dim">
              Put the .env line in the agent's env, and the config.yaml block in the agent's Hermes config. The config
              references the key via <code>{KEY_ENV_VAR}</code> (the secret stays in the .env, never inlined). The agent
              presents this key to IDLEFILL at {minted.url}; IDLEFILL authenticates to the engine with the row
              credential.
            </p>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle className="text-[13px]">new agent key</DialogTitle>
              <DialogDescription className="text-[11px]">
                the agent presents this key at the aggregate endpoint. It is an AGENT-INFERENCE credential — a different
                credential from the arbiter's control token in the header.
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-3">
              <label className="flex flex-col gap-1">
                <span className="text-dim">label (≤{AGENT_LABEL_MAX} chars)</span>
                <Input className="h-7 text-[12px]" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. accounting-agent" maxLength={AGENT_LABEL_MAX} />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-dim">machine (the loopback aggregate port its daemon reports)</span>
                <Select value={epIndex} onValueChange={setEpIndex}>
                  <SelectTrigger size="sm" className="h-7 w-full text-[12px]">
                    <SelectValue placeholder="— no online machine reported an aggregate port —" />
                  </SelectTrigger>
                  <SelectContent>
                    {endpoints.length === 0 ? (
                      <SelectItem value="0" disabled className="text-[12px]">
                        — no online machine reported an aggregate port —
                      </SelectItem>
                    ) : (
                      endpoints.map((e, i) => (
                        <SelectItem key={i} value={String(i)} className="text-[12px]">
                          {e.client} · {e.url}
                        </SelectItem>
                      ))
                    )}
                  </SelectContent>
                </Select>
              </label>
              {err && <div className="border border-err/40 bg-err/10 px-2 py-1.5 text-[11px] text-err">{err}</div>}
            </div>
            <DialogFooter>
              <Button size="sm" variant="outline" className="h-7 text-[12px]" onClick={() => onOpenChange(false)}>
                cancel
              </Button>
              <Button size="sm" className="h-7 text-[12px]" disabled={minting || label.trim() === ""} onClick={() => void mint()}>
                {minting ? "minting…" : "mint key"}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
