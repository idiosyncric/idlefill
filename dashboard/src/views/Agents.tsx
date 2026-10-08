import * as React from "react";
import { toast } from "sonner";
import {
  Card,
  CardContent,
} from "@/components/ui/card";
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
import { copyText } from "@/lib/clipboard";
import {
  apiToken,
  getAgentKeys,
  getAgentEndpoints,
  mintAgentKey,
  revokeAgentKey,
  type AgentEndpoint,
  type AgentKeyRow,
} from "@/lib/api";
import { ago } from "@/lib/format";

// ---------------------------------------------------------------------------
// Agent keys (#68 server plane, #72 dashboard flow): idlefill's own
// credential for agents (a Hermes profile, any OpenAI client).
// CREDENTIAL MAP: the header's gate-token field + hand-off pair = the
// CONTROL-API token (writes to this arbiter); an agent key minted here = the
// AGENT-INFERENCE credential (the agent presents it at the aggregate
// endpoint). Two different credentials — never merged.
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
  const [endpoints, setEndpoints] = React.useState<AgentEndpoint[]>([]);
  const [modal, setModal] = React.useState(false);
  const [armedId, setArmedId] = React.useState<string | null>(null);
  const now = st?.now ?? Date.now();

  const hasToken = apiToken() !== null;

  // The authoring read pair: token-gated (no token → no request leaves the
  // page); a non-200 keeps the rows in hand (drop-don't-wipe). 30s cadence,
  // like the Models pane.
  const refresh = React.useCallback(async () => {
    if (!apiToken()) return;
    try {
      setKeys(await getAgentKeys());
    } catch {
      /* the pane keeps its last good rows */
    }
    try {
      setEndpoints(await getAgentEndpoints());
    } catch {
      /* the modal re-picks from the last good list */
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
              toast.error("needs the arbiter API token — paste it in the header first");
              return;
            }
            setModal(true);
          }}
          title="mint an idlefill agent key for one agent (Hermes profile, OpenAI client)"
        >
          + new agent key
        </Button>
      </div>

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

      <MintDialog open={modal} onOpenChange={setModal} endpoints={endpoints} />
    </section>
  );
}

// The minimal state shape the view needs (only for the ages).
type StateSnapshotLike = { now: number };

// The mint dialog. Phase 1: label + machine pick. Phase 2 (minted): the
// ONE-TIME hand-off block — the plaintext rides the in-memory state only;
// the copy buttons read it, never a rendered field.
function MintDialog({
  open,
  onOpenChange,
  endpoints,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  endpoints: AgentEndpoint[];
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
    setLabel("");
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
