import * as React from "react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Toaster } from "@/components/ui/sonner";
import { toast } from "sonner";
import { getState, apiToken, setApiToken, type StateSnapshot } from "@/lib/api";
import { InferenceServers } from "@/views/InferenceServers";

const VIEWS = ["overview", "resources", "sessions", "usage"] as const;
type View = (typeof VIEWS)[number];
const RES_SUBTABS = ["servers", "machines", "projects", "models"] as const;
type ResTab = (typeof RES_SUBTABS)[number];

const VIEW_KEY = "idlefill.viewTab";
const RES_KEY = "idlefill.resTab";

function readView(): View {
  const hash = location.hash.replace(/^#/, "");
  const stored = localStorage.getItem(VIEW_KEY) as View | null;
  const legacy = hash === "projects" || hash === "models" ? hash : stored;
  if (legacy === "projects" || legacy === "models") {
    localStorage.setItem(RES_KEY, legacy);
    return "resources";
  }
  if ((VIEWS as readonly string[]).includes(hash)) return hash as View;
  if (stored && (VIEWS as readonly string[]).includes(stored)) return stored;
  return "overview";
}

export function App() {
  const [view, setView] = React.useState<View>(readView);
  const [resTab, setResTab] = React.useState<ResTab>(() => (localStorage.getItem(RES_KEY) as ResTab) ?? "servers");
  const [st, setSt] = React.useState<StateSnapshot | null>(null);
  const [stErr, setStErr] = React.useState<string | null>(null);
  const [tokenDraft, setTokenDraft] = React.useState(apiToken() ?? "");

  // 5s poll, like the legacy dashboard (the WS push plane comes later).
  React.useEffect(() => {
    let alive = true;
    const pull = () =>
      getState()
        .then((s) => {
          if (!alive) return;
          setSt(s);
          setStErr(null);
        })
        .catch((e: Error) => alive && setStErr(e.message));
    pull();
    const id = setInterval(pull, 5000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const pickView = (v: string) => {
    const next = v as View;
    if (!(VIEWS as readonly string[]).includes(next)) return;
    setView(next);
    localStorage.setItem(VIEW_KEY, next);
    location.hash = next;
  };
  const pickResTab = (t: string) => {
    const next = t as ResTab;
    if (!(RES_SUBTABS as readonly string[]).includes(next)) return;
    setResTab(next);
    localStorage.setItem(RES_KEY, next);
  };

  const globalWord = st
    ? st.idle.degraded
      ? { label: "Degraded", cls: "text-err" }
      : st.idle.idle
        ? { label: "Idle", cls: "text-ok" }
        : { label: "Busy", cls: "text-warn" }
    : { label: "state unreachable", cls: "text-err" };

  return (
    <div className="min-h-screen">
      <header className="flex items-center gap-3 border-b border-border px-5 py-3">
        <span className="font-semibold">idlefill · arbiter</span>
        <span className="text-dim">background-work gate for the local LLM server</span>
        <span className={`ml-auto text-[12px] font-semibold ${globalWord.cls}`}>{globalWord.label}</span>
        <div className="flex items-center gap-1.5">
          <Input
            type="password"
            className="h-6 w-48 text-[12px]"
            placeholder="arbiter API token (enables writes)"
            value={tokenDraft}
            onChange={(e) => setTokenDraft(e.target.value)}
            onBlur={() => {
              setApiToken(tokenDraft.trim() || null);
              toast.success("token stored in this browser");
            }}
          />
          {apiToken() && <span className="text-[11px] text-ok">stored ✓</span>}
        </div>
      </header>

      <nav className="flex flex-wrap items-center gap-2 px-5 pt-3">
        <Tabs value={view} onValueChange={pickView}>
          <TabsList className="h-7 gap-0.5 bg-transparent p-0">
            {VIEWS.map((v) => (
              <TabsTrigger key={v} value={v} className="h-6 rounded-sm px-2.5 text-[12px] data-[state=active]:border data-[state=active]:border-border data-[state=active]:bg-card">
                {v}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        {view === "resources" && (
          <Tabs value={resTab} onValueChange={pickResTab}>
            <TabsList className="h-7 gap-0.5 bg-transparent p-0">
              {RES_SUBTABS.map((t) => (
                <TabsTrigger key={t} value={t} className="h-6 rounded-sm px-2.5 text-[12px] data-[state=active]:border data-[state=active]:border-border data-[state=active]:bg-card">
                  {t === "servers" ? "inference servers" : t}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        )}
      </nav>

      <main className="px-5 py-4">
        {stErr && (
          <div className="mb-3 border border-err/40 bg-err/10 px-3 py-2 text-[12px] text-err">
            state unreachable: {stErr} — the arbiter is down or the token was rejected.
          </div>
        )}
        {view === "resources" && resTab === "servers" && <InferenceServers st={st} />}
        {view === "resources" && resTab !== "servers" && (
          <div className="text-dim text-[12px] py-10 text-center">
            the {resTab} sub-tab still lives in the legacy dashboard (localhost:8787) — it gets its own rethink next.
          </div>
        )}
        {view !== "resources" && (
          <div className="text-dim text-[12px] py-10 text-center">
            the {view} view still lives in the legacy dashboard (localhost:8787) — the React app starts with Resources → Inference servers.
          </div>
        )}
      </main>

      <Toaster position="top-center" richColors={false} closeButton={false} />
    </div>
  );
}
