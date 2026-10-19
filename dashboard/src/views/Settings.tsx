import * as React from "react";
import { toast } from "sonner";
import { RotateCcw, Save } from "lucide-react";
import { Card, CardHeader, CardTitle, CardAction, CardContent, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import {
  setTheme,
  apiToken,
  setApiToken,
  readLocalHermesGateway,
  writeLocalHermesGateway,
  runClientEgressTest,
  type HermesGatewayStatus,
  type EgressTestResult,
  type StateSnapshot,
} from "@/lib/api";
import { THEME_KEYS, DEFAULT_THEME, isHexColor, applyTheme } from "@/lib/theme";
import { copyText } from "@/lib/clipboard";

// ---------------------------------------------------------------------------
// Settings → the operator-tuned color scheme (#68) PLUS the Hermes-gateway
// connector card (#84) below it. One row per token: the
// label, a native color picker, a hex text input, and the live current
// value. A live preview row shows a state-sample dot + word in the chosen
// color so the operator sees the effect before saving. "reset to defaults"
// posts the :root defaults (the exact index.css values). Save is token-
// gated (the qsToken pattern) — the write rides the arbiter's api token,
// and the response carries the effective map after the arbiter sanitizes.
// Flat by default: tonal panel + hairline, zero shadow (DESIGN.md).
// ---------------------------------------------------------------------------

// The value shown for a token: the saved theme (if any) else the :root default.
function currentFor(key: string, saved?: Record<string, string>): string {
  return saved?.[key] ?? DEFAULT_THEME[key];
}

export function Settings({ st }: { st: StateSnapshot | null }) {
  const saved = st?.theme?.colors;
  // The editable draft: one entry per token. Seeded from the saved theme (or
  // the :root defaults when unset). The draft is what Save posts; the live
  // preview reads it, so the operator sees the change before it reaches the
  // arbiter.
  const seed = (s?: Record<string, string>) =>
    Object.fromEntries(THEME_KEYS.map(({ key }) => [key, currentFor(key, s)]));
  const [draft, setDraft] = React.useState<Record<string, string>>(() => seed(undefined));
  const [saving, setSaving] = React.useState(false);
  // Re-seed when the persisted theme arrives or changes (the draft is seeded
  // at mount, when st is still null — without this the saved theme would never
  // display). Guard: never clobber an in-progress edit (the operator typed
  // since the last seed). The poll's 5s tick is the only thing that changes
  // `saved`, so this fires exactly when truth moves.
  const lastSeedRef = React.useRef<string>("");
  const editedRef = React.useRef(false);
  const savedSerialized = saved ? JSON.stringify(saved) : "";
  React.useEffect(() => {
    if (savedSerialized === lastSeedRef.current) return; // nothing new
    if (editedRef.current) return; // protect the in-progress edit
    setDraft(seed(saved));
    lastSeedRef.current = savedSerialized;
  }, [savedSerialized, saved]);

  const requireToken = (): boolean => {
    if (apiToken()) return true;
    toast.error("needs the arbiter API token — paste it in the API token card below first");
    return false;
  };

  const set = (key: string, value: string) => {
    editedRef.current = true;
    setDraft((d) => ({ ...d, [key]: value }));
  };

  const dirty = THEME_KEYS.some(({ key }) => draft[key] !== currentFor(key, saved));

  const doSave = async (payload: Record<string, string>, label: string) => {
    if (!requireToken()) return;
    setSaving(true);
    try {
      const res = await setTheme(payload);
      applyTheme(res.colors); // the apply channel: reflect the effective map now
      setDraft(Object.fromEntries(THEME_KEYS.map(({ key }) => [key, res.colors[key] ?? DEFAULT_THEME[key]])));
      lastSeedRef.current = JSON.stringify(res.colors); // the fresh truth; no re-seed needed
      editedRef.current = false;
      toast.success(`${label}${res.applied > 0 ? ` · ${res.applied} token(s) set` : ""}`);
    } catch (e) {
      toast.error(`save failed: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section>
      <div className="flex items-center gap-3 mb-3">
        <h2 className="text-[12px] font-semibold uppercase tracking-wide text-dim">Settings</h2>
        <p className="text-[12px] text-dim">
          the arbiter API token, the color scheme, the agent hand-off, and the per-machine connectors.
        </p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-[12px] font-semibold uppercase tracking-wide text-dim">Color scheme</CardTitle>
          <CardAction className="flex items-center gap-2">
            <Button
              size="xs"
              variant="outline"
              disabled={saving}
              onClick={() => {
                doSave(Object.fromEntries(THEME_KEYS.map(({ key }) => [key, DEFAULT_THEME[key]])), "reset to defaults");
              }}
            >
              <RotateCcw className="size-3" /> reset to defaults
            </Button>
            <Button
              size="xs"
              disabled={saving || !dirty}
              onClick={() => doSave(draft, "saved")}
            >
              <Save className="size-3" /> {saving ? "saving…" : "save"}
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-1.5">
            {THEME_KEYS.map(({ key, label }) => {
              const value = draft[key];
              const valid = isHexColor(value);
              return (
                <React.Fragment key={key}>
                  <div className="grid grid-cols-[9rem_1fr_auto] items-center gap-3 rounded-sm border border-border bg-panel px-3 py-2">
                    <span className="text-[12px]">{label}</span>
                    <div className="flex items-center gap-2">
                      <input
                        type="color"
                        value={isHexColor(value) ? value : DEFAULT_THEME[key]}
                        onChange={(e) => set(key, e.target.value)}
                        aria-label={`${label} color picker`}
                        className="h-6 w-8 cursor-pointer rounded-sm border border-border bg-transparent"
                      />
                      <Input
                        value={value}
                        onChange={(e) => set(key, e.target.value)}
                        aria-label={`${label} hex value`}
                        spellCheck={false}
                        className={`h-6 w-28 font-mono text-[12px] ${valid ? "" : "text-err"}`}
                      />
                      {!valid && <span className="text-[11px] text-err">not a #hex</span>}
                    </div>
                    {/* The live preview: a state-sample dot + word in the chosen color. */}
                    <span className="flex items-center gap-2 text-[12px]">
                      <span
                        className="inline-block size-2.5 rounded-full"
                        style={{ backgroundColor: valid ? value : "transparent" }}
                      />
                      <span style={{ color: valid ? value : undefined }}>running</span>
                    </span>
                  </div>
                  {key !== THEME_KEYS[THEME_KEYS.length - 1].key && <Separator className="my-1" />}
                </React.Fragment>
              );
            })}
          </div>
        </CardContent>
        <CardFooter>
          <p className="text-[11px] text-dim">
            a token left at its default keeps the :root value. an unset theme shows the defaults on every reload.
          </p>
        </CardFooter>
      </Card>

      {/* The gate-token field — moved out of the every-view header chrome on
          the owner ask 2026-10-19: entering the token is a settings task, so
          the field lives on this tab only. */}
      <ApiTokenSection />

      {/* Hand-off pair — moved out of the every-view header chrome on the
          owner ask 2026-10-19: a config hand-off is a settings task, so the
          two buttons live on this tab only. */}
      <HandoffSection />

      {/* #84: the Hermes-gateway connector card, per ONLINE local client
          (loopback page origin only — the card talks to the client's own
          loopback proxy, same posture as the Projects local-config editor). */}
      <HermesGatewaySection st={st} />

      {/* Egress self-test: the ACTIVE connectivity probe per ONLINE local
          client — one click asks the daemon "can YOUR sockets reach the
          arbiter and every engine row?" (the 2026-10-18 lesson: passive
          views stayed green while a local firewall denied every outbound
          connect; only the forwarding daemon itself can answer that). */}
      <EgressSelfTestSection st={st} />
    </section>
  );
}

// ---------------------------------------------------------------------------
// Gate-token field (owner ask 2026-10-19: Settings-tab only, never header
// chrome). The arbiter API token THIS browser holds: reads work anonymously,
// every write carries it. Save writes it to localStorage only — the arbiter
// never serves the value back over any route (the hand-off card below is the
// copy side of the same credential). Clear forgets it: reads keep working,
// writes stop. Enter in the field commits the same way as the save button.
// ---------------------------------------------------------------------------

function ApiTokenSection() {
  const [draft, setDraft] = React.useState(apiToken() ?? "");
  const [stored, setStored] = React.useState<string | null>(apiToken());

  const apply = (token: string | null) => {
    setApiToken(token);
    setStored(token);
  };
  const commit = () => {
    const t = draft.trim();
    apply(t || null);
    if (t) setDraft(t);
    toast.success(t ? "token stored in this browser" : "token cleared");
  };

  const dirty = draft.trim() !== (stored ?? "");
  return (
    <div className="mt-3 flex flex-col gap-2">
      <h3 className="text-[12px] font-semibold uppercase tracking-wide text-dim">API token</h3>
      <Card className="py-2 shadow-none">
        <CardHeader className="flex-row items-center gap-2 px-3 py-0">
          <CardTitle className="text-[13px] font-semibold">Arbiter API token</CardTitle>
          <CardAction className="flex items-center gap-2">
            {stored && <span className="text-[11px] text-ok">stored ✓</span>}
            {stored && (
              <Button
                variant="outline"
                size="xs"
                title="forget the token in this browser — reads keep working, writes stop"
                onClick={() => {
                  apply(null);
                  setDraft("");
                  toast.success("token cleared");
                }}
              >
                clear
              </Button>
            )}
            <Button size="xs" disabled={!dirty} onClick={commit}>
              save
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent className="flex flex-col gap-1.5 px-3 py-2">
          <Input
            type="password"
            className="h-6 w-full max-w-72 font-mono text-[12px]"
            placeholder="arbiter API token (enables writes)"
            value={draft}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && dirty) commit();
            }}
          />
          <p className="text-[11px] text-dim">
            paste the arbiter's API token to enable writes on every tab. it is kept in this browser only —
            the arbiter never serves it back. empty + save forgets it.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Hand-off pair (owner ask 2026-10-19: Settings-tab only, never header
// chrome). The two values an agent config needs to reach this arbiter —
// server_url and the API token. One button per value (the paste targets are
// two different config fields, so one combined button would force the
// operator to split the string by hand). `copy url` copies location.origin —
// the origin the page is provably served from; dev bakes the proxy target
// in (__IDLEFILL_DEV_API__, see vite.config.ts) because the page's own
// origin there is Vite, not the arbiter. The token is copied, never
// rendered: it is the value THIS browser already holds — the arbiter never
// serves it over any route. "copied" / "copy failed" / "paste it in Settings
// first" rides the button label for ~1.4s, then the label resets.
// ---------------------------------------------------------------------------

function HandoffSection() {
  const [urlFlash, setUrlFlash] = React.useState<string | null>(null);
  const [tokFlash, setTokFlash] = React.useState<string | null>(null);

  const flash = (set: (s: string | null) => void, msg: string) => {
    set(msg);
    window.setTimeout(() => set(null), 1400);
  };
  const doCopy = (text: string | null, missing: string, set: (s: string | null) => void) => {
    if (!text) {
      flash(set, missing);
      return;
    }
    copyText(text).then((ok) => flash(set, ok ? "copied" : "copy failed"));
  };

  return (
    <div className="mt-3 flex flex-col gap-2">
      <h3 className="text-[12px] font-semibold uppercase tracking-wide text-dim">Agent hand-off</h3>
      <Card className="py-2 shadow-none">
        <CardHeader className="flex-row items-center gap-2 px-3 py-0">
          <CardTitle className="text-[13px] font-semibold">This arbiter's URL and API token</CardTitle>
          <CardAction className="flex items-center gap-2">
            <Button
              variant="outline"
              size="xs"
              title="copy this arbiter's URL — what an agent's server_url points at"
              onClick={() => doCopy(__IDLEFILL_DEV_API__ ?? window.location.origin, "no url", setUrlFlash)}
            >
              {urlFlash ?? "copy url"}
            </Button>
            <Button
              variant="outline"
              size="xs"
              title="copy the arbiter API token stored in this browser — what an agent's token points at"
              onClick={() => doCopy(apiToken(), "paste it in Settings first", setTokFlash)}
            >
              {tokFlash ?? "copy token"}
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent className="px-3 py-2">
          <p className="text-[11px] text-dim">
            the two values an agent config needs to reach this arbiter: server_url and the API token. the
            token is copied, never shown — it is the value THIS browser already holds; the arbiter never
            serves it over any route. a loopback URL only answers this machine; a remote agent needs the
            tailnet URL.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Egress self-test card. POSTs the client's loopback /client/egress-test
// (same edit-token posture as the connector card); renders one honest line
// per target: ANY HTTP status = the path works (the status is shown, the
// verdict is ok); a connection errno names itself. Read-only on every
// target (bounded GETs), never on the 5 s poll — only on click.
// ---------------------------------------------------------------------------

function EgressSelfTestSection({ st }: { st: StateSnapshot | null }) {
  const hosted = (st?.clients ?? [])
    .filter((c) => c.proxy_port && st && st.now - (c.last_seen ?? 0) < 90_000)
    .sort((a, b) => a.name.localeCompare(b.name));
  if (!pageOriginLoopback() || hosted.length === 0) return null;
  return (
    <div className="mt-3 flex flex-col gap-2">
      <h3 className="text-[12px] font-semibold uppercase tracking-wide text-dim">Egress self-test</h3>
      {hosted.map((c) => (
        <EgressSelfTestCard key={c.name} name={c.name} port={c.proxy_port!} />
      ))}
    </div>
  );
}

function EgressSelfTestCard({ name, port }: { name: string; port: number }) {
  const [running, setRunning] = React.useState(false);
  const [res, setRes] = React.useState<{ at: number; ok: boolean; results: EgressTestResult[] } | null>(null);
  const [err, setErr] = React.useState<string | null>(null);

  const run = async () => {
    if (!apiToken()) {
      setErr("the test needs the arbiter token — paste it in Settings first");
      return;
    }
    setRunning(true);
    setErr(null);
    try {
      setRes(await runClientEgressTest(port));
    } catch (e) {
      setRes(null);
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  };

  return (
    <Card className="py-2 shadow-none">
      <CardHeader className="flex-row items-center gap-2 px-3 py-0">
        <CardTitle className="text-[13px] font-semibold">{name}</CardTitle>
        <span className="text-[11px] text-dim">127.0.0.1:{port}</span>
        <CardAction>
          <Button size="sm" variant="outline" onClick={() => void run()} disabled={running}>
            {running ? "probing…" : "run egress test"}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-0.5 px-3 py-2">
        {err && <div className="text-[11px] text-err">{err}</div>}
        {!err && res === null && !running && (
          <div className="text-[11px] text-dim">asks THIS machine's daemon whether its own sockets reach the arbiter, its engines and its target — run it when an agent's traffic stalls but every tile looks green</div>
        )}
        {res && (
          <>
            <div className={`text-[11px] font-semibold ${res.ok ? "text-ok" : "text-err"}`} title="the verdict is the daemon's own egress: ANY HTTP reply proves the path; a connection errno means the socket itself could not complete">
              {res.ok ? "egress ok" : "egress blocked"}
              <span className="ml-1 font-normal text-dim">· {res.results.length} {res.results.length === 1 ? "target" : "targets"}</span>
            </div>
            {res.results.map((r, i) => (
              <div key={`${r.label}-${i}`} className="flex items-center gap-2 text-[11px]" title={`${r.kind}: ${r.url}`}>
                <span className={`size-1.5 shrink-0 rounded-full ${r.ok ? "bg-ok" : "bg-err"}`} />
                <span className="min-w-0 truncate">{r.label}</span>
                <span className={`ml-auto whitespace-nowrap ${r.ok ? "text-dim" : "text-err"}`}>
                  {r.ok ? `HTTP ${r.status} · ${r.ms}ms` : `${r.code} · ${r.ms}ms`}
                </span>
              </div>
            ))}
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// #84: the Hermes-gateway connector card. Enable + per-profile API keys for
// the #73/#83 enrichment connector, edited through the LOCAL client's
// loopback surface (GET never returns key VALUES — only which profiles
// carry one; a stored key stays hidden, blank keeps it, Clear removes it).
// Save answers restart_required: the connector is built at daemon boot, so
// the card never restarts anything itself.
// ---------------------------------------------------------------------------

function pageOriginLoopback(): boolean {
  const h = location.hostname;
  return h === "localhost" || h.startsWith("127.") || h === "[::1]" || h === "::1";
}

function HermesGatewaySection({ st }: { st: StateSnapshot | null }) {
  const hosted = (st?.clients ?? [])
    .filter((c) => c.proxy_port && st && st.now - (c.last_seen ?? 0) < 90_000)
    .sort((a, b) => a.name.localeCompare(b.name));
  if (!pageOriginLoopback() || hosted.length === 0) return null;
  return (
    <div className="mt-3 flex flex-col gap-2">
      <h3 className="text-[12px] font-semibold uppercase tracking-wide text-dim">Hermes gateway connector</h3>
      {hosted.map((c) => (
        <HermesGatewayEditor key={c.name} name={c.name} port={c.proxy_port!} />
      ))}
    </div>
  );
}

function HermesGatewayEditor({ name, port }: { name: string; port: number }) {
  const [status, setStatus] = React.useState<HermesGatewayStatus | null>(null);
  const [enabled, setEnabled] = React.useState(false);
  const [keys, setKeys] = React.useState<Record<string, string>>({});
  const [clears, setClears] = React.useState<Record<string, boolean>>({});
  const [saving, setSaving] = React.useState(false);
  const [msg, setMsg] = React.useState<{ text: string; cls: string } | null>(null);

  const load = async () => {
    if (!apiToken()) {
      setMsg({ text: "the edit needs the arbiter token — paste it in Settings first", cls: "text-err" });
      return;
    }
    try {
      const st = await readLocalHermesGateway(port);
      setStatus(st);
      setEnabled(st.enabled);
      setKeys({});
      setClears({});
    } catch (e) {
      setMsg({ text: `the local client at 127.0.0.1:${port} is unreachable: ${(e as Error).message}`, cls: "text-err" });
    }
  };
  React.useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [port]);

  const stored = new Set(status?.stored_profiles ?? []);
  const dirty =
    status !== null &&
    (enabled !== status.enabled ||
      Object.values(keys).some((v) => v.trim() !== "") ||
      Object.values(clears).some(Boolean));

  const save = async () => {
    if (!apiToken()) {
      setMsg({ text: "the edit needs the arbiter token — paste it in Settings first", cls: "text-err" });
      return;
    }
    const body: { enabled?: boolean; keys?: Record<string, string | null> } = {};
    if (status && enabled !== status.enabled) body.enabled = enabled;
    const patch: Record<string, string | null> = {};
    for (const p of status?.profiles ?? []) {
      if (clears[p]) patch[p] = null;
      else if (keys[p]?.trim()) patch[p] = keys[p].trim();
    }
    if (Object.keys(patch).length > 0) body.keys = patch;
    if (Object.keys(body).length === 0) return;
    setSaving(true);
    setMsg({ text: "saving…", cls: "text-dim" });
    try {
      const res = await writeLocalHermesGateway(port, body);
      setMsg({
        text: res.restart_required ? "saved — restart the client daemon to apply" : "saved",
        cls: "text-warn",
      });
      setKeys({});
      setClears({});
      const fresh = await readLocalHermesGateway(port).catch(() => null);
      if (fresh) {
        setStatus(fresh);
        setEnabled(fresh.enabled); // the boot truth stands until a restart
      }
    } catch (e) {
      setMsg({ text: `refused: ${(e as Error).message}`, cls: "text-err" });
    } finally {
      setSaving(false);
    }
  };

  const gw = status?.gateway;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-[13px] font-semibold">{name}</CardTitle>
        <CardAction className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-[12px]">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            enabled
          </label>
          <Button size="xs" disabled={saving || !dirty} onClick={() => void save()}>
            <Save className="size-3" /> {saving ? "saving…" : "save"}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        {status === null ? (
          <p className="text-[12px] text-dim">loading…</p>
        ) : (
          <div className="flex flex-col gap-1.5">
            <div className="grid grid-cols-[9rem_1fr] items-center gap-3 rounded-sm border border-border bg-panel px-3 py-2 text-[12px]">
              <span className="text-dim">posture</span>
              <span className="flex flex-wrap items-center gap-2">
                {status.enabled ? (
                  <span className="text-ok">connector on{status.env_switch ? " (env)" : ""}</span>
                ) : (
                  <span className="text-dim">connector off</span>
                )}
                {gw ? (
                  gw.reachable ? (
                    <span className="text-ok">gateway reachable · v{gw.version ?? "?"} · {gw.ledger_size ?? 0} rows</span>
                  ) : (
                    <span className="text-err">gateway DOWN</span>
                  )
                ) : (
                  <span className="text-dim">no poll round yet</span>
                )}
              </span>
            </div>
            <div className="grid grid-cols-[9rem_1fr] items-center gap-3 rounded-sm border border-border bg-panel px-3 py-2 text-[12px]">
              <span className="text-dim">base url</span>
              <span className="font-mono">{status.base_url}</span>
            </div>
            {status.profiles.map((p) => (
              <div key={p} className="grid grid-cols-[9rem_1fr_auto] items-center gap-3 rounded-sm border border-border bg-panel px-3 py-2 text-[12px]">
                <span className="truncate" title={p}>{p}</span>
                <Input
                  type="password"
                  className="h-6 max-w-64 font-mono text-[12px]"
                  value={keys[p] ?? ""}
                  placeholder={stored.has(p) ? "••• stored — blank keeps it" : "no key stored"}
                  spellCheck={false}
                  autoComplete="off"
                  onChange={(e) => setKeys((k) => ({ ...k, [p]: e.target.value }))}
                />
                {stored.has(p) ? (
                  <label className="flex items-center gap-1.5 text-dim">
                    <input
                      type="checkbox"
                      checked={clears[p] ?? false}
                      onChange={(e) => setClears((c) => ({ ...c, [p]: e.target.checked }))}
                    />
                    clear
                  </label>
                ) : (
                  <span />
                )}
              </div>
            ))}
            {msg && <p className={`text-[12px] ${msg.cls}`}>{msg.text}</p>}
          </div>
        )}
      </CardContent>
      <CardFooter>
        <p className="text-[11px] text-dim">
          keys save to {status?.key_file ?? "the key file"} (0600) — never shown, never sent anywhere but this client; the gateway
          answers per Hermes profile. enable + keys apply on the next daemon restart.
        </p>
      </CardFooter>
    </Card>
  );
}
