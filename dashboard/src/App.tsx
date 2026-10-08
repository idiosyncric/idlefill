import * as React from "react";
import {
  Activity,
  BarChart3,
  Command,
  LayoutDashboard,
  Server,
} from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
} from "@/components/ui/sidebar";
import { NavMain, type NavItem } from "@/components/nav-main";
import { SiteHeader } from "@/components/site-header";
import { Input } from "@/components/ui/input";
import { Toaster } from "@/components/ui/sonner";
import { toast } from "sonner";
import { getState, apiToken, setApiToken, type StateSnapshot } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { Button } from "@/components/ui/button";
import { InferenceServers } from "@/views/InferenceServers";

// The sidebar nav (shadcn sidebar-16 shape). Every parent item is itself a
// view: picking "Resources" lands on its Overview. The chevron beside it
// toggles the sub-tab list — a sub-tab shows that sub-view directly.
type ResTab = "overview" | "servers" | "machines" | "projects" | "models";
const RES_SUBTABS: { id: ResTab; title: string }[] = [
  { id: "overview", title: "Overview" },
  { id: "servers", title: "Inference servers" },
  { id: "machines", title: "Machines" },
  { id: "projects", title: "Projects" },
  { id: "models", title: "Models" },
];

const NAV: NavItem[] = [
  { id: "overview", title: "Overview", icon: LayoutDashboard },
  {
    id: "resources",
    title: "Resources",
    icon: Server,
    items: RES_SUBTABS.map((t) => ({ id: t.id, title: t.title })),
  },
  { id: "sessions", title: "Sessions", icon: Activity },
  { id: "usage", title: "Usage", icon: BarChart3 },
];

const VIEW_KEY = "idlefill.viewTab";
const RES_KEY = "idlefill.resTab";
const SUB_OPEN_KEY = "idlefill.navSubOpen";

const VIEW_IDS = NAV.map((n) => n.id);

function readView(): string {
  const hash = location.hash.replace(/^#/, "");
  const stored = localStorage.getItem(VIEW_KEY);
  // Legacy deep links: #projects/#models were top-level tabs before the
  // Resources rethink; they now live as Resources sub-tabs.
  if (hash === "projects" || hash === "models") {
    localStorage.setItem(RES_KEY, hash);
    return "resources";
  }
  if (VIEW_IDS.includes(hash)) return hash;
  if (stored && VIEW_IDS.includes(stored)) return stored;
  return "overview";
}

function readResTab(): ResTab {
  const stored = localStorage.getItem(RES_KEY) as ResTab | null;
  if (stored && RES_SUBTABS.some((t) => t.id === stored)) return stored;
  return "overview";
}

// Which parents have their sub-list expanded. Default: open when the
// section is the active one. null = follow that default; a stored map
// remembers manual folds.
function readSubOpen(): Record<string, boolean> | null {
  try {
    const raw = localStorage.getItem(SUB_OPEN_KEY);
    return raw ? (JSON.parse(raw) as Record<string, boolean>) : null;
  } catch {
    return null;
  }
}

export function App() {
  const [view, setView] = React.useState<string>(readView);
  const [resTab, setResTab] = React.useState<ResTab>(readResTab);
  const [openMap, setOpenMap] = React.useState<Record<string, boolean> | null>(readSubOpen);
  const [st, setSt] = React.useState<StateSnapshot | null>(null);
  const [stErr, setStErr] = React.useState<string | null>(null);
  const [tokenDraft, setTokenDraft] = React.useState(apiToken() ?? "");
  // Hand-off pair: "copied" / "copy failed" / "paste it in first" rides the
  // button label for ~1.2s, then the label resets. null = resting.
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

  const subOpen = (item: NavItem) => {
    if (!item.items?.length) return false;
    if (openMap && item.id in openMap) return openMap[item.id];
    return view === item.id;
  };
  const toggleSub = (id: string, open: boolean) => {
    setOpenMap((m) => {
      const next = { ...(m ?? {}), [id]: open };
      localStorage.setItem(SUB_OPEN_KEY, JSON.stringify(next));
      return next;
    });
  };

  const pickView = (v: string) => {
    if (!VIEW_IDS.includes(v)) return;
    setView(v);
    localStorage.setItem(VIEW_KEY, v);
    location.hash = v;
    // The parent button is the section's Overview: entering Resources through
    // the parent always lands on Overview, whatever sub-tab was last open.
    if (v === "resources") {
      setResTab("overview");
      localStorage.setItem(RES_KEY, "overview");
    }
  };
  const pickResTab = (t: string) => {
    const next = t as ResTab;
    if (!RES_SUBTABS.some((x) => x.id === next)) return;
    setView("resources");
    localStorage.setItem(VIEW_KEY, "resources");
    setResTab(next);
    localStorage.setItem(RES_KEY, next);
    location.hash = "resources";
  };

  const globalWord = st
    ? st.idle.degraded
      ? { label: "Degraded", cls: "text-err" }
      : st.idle.idle
        ? { label: "Idle", cls: "text-ok" }
        : { label: "Busy", cls: "text-warn" }
    : { label: "state unreachable", cls: "text-err" };

  const crumb =
    view === "resources"
      ? ["Resources", RES_SUBTABS.find((t) => t.id === resTab)?.title ?? "Overview"]
      : [NAV.find((n) => n.id === view)?.title ?? "Overview"];

  return (
    <SidebarProvider className="min-h-svh">
      <AppSidebar
        view={view}
        resTab={resTab}
        openMap={openMap}
        subOpen={subOpen}
        toggleSub={toggleSub}
        pickView={pickView}
        pickResTab={pickResTab}
      />
      <SidebarInset>
        <SiteHeader crumb={crumb} globalWord={globalWord} />
        <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-5 py-2.5">
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
          {/* Hand-off pair: the two values an agent config needs to reach this
              arbiter — server_url and the API token. One button per value (the
              paste targets are two different config fields). The token is
              copied, never rendered: it is the value THIS browser already
              holds — the arbiter never serves it over any route. */}
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
            onClick={() => doCopy(apiToken(), "paste it in first", setTokFlash)}
          >
            {tokFlash ?? "copy token"}
          </Button>
        </div>
        <main className="flex-1 px-5 py-4">
          {stErr && (
            <div className="mb-3 border border-err/40 bg-err/10 px-3 py-2 text-[12px] text-err">
              state unreachable: {stErr} — the arbiter is down or the token was rejected.
            </div>
          )}
          {view === "resources" && resTab === "servers" && <InferenceServers st={st} />}
          {view === "resources" && resTab === "overview" && (
            <ResourceOverview st={st} onPickTab={pickResTab} />
          )}
          {(view === "resources" && (resTab === "machines" || resTab === "projects" || resTab === "models") ||
            view === "sessions" ||
            view === "usage" ||
            view === "overview") && (
            <div className="text-dim text-[12px] py-10 text-center">
              the {view === "resources" ? resTab : view} view still lives in the legacy dashboard
              (localhost:8787) — the React app starts with Resources → Inference servers.
            </div>
          )}
        </main>
        <Toaster position="top-center" richColors={false} closeButton={false} />
      </SidebarInset>
    </SidebarProvider>
  );
}

// The Resources landing (the view the parent button opens): the counts the
// arbiter already serves in /api/state, each row clicking through to its
// sub-tab. Skeletons, not spinners, while the first poll lands.
function ResourceOverview({
  st,
  onPickTab,
}: {
  st: StateSnapshot | null;
  onPickTab: (t: string) => void;
}) {
  const rows = [
    { id: "servers", label: "Inference servers", n: st ? st.servers.length : null },
    { id: "machines", label: "Machines", n: st ? st.clients.length : null },
    { id: "projects", label: "Projects", n: st ? st.projects.length : null },
    { id: "models", label: "Models", n: st ? st.model_aliases.length : null },
  ];
  return (
    <div className="flex flex-col gap-3">
      <p className="text-dim text-[12px]">
        the resources the arbiter governs. pick a row to open its sub-tab.
      </p>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {rows.map((r) => (
          <button
            key={r.id}
            type="button"
            onClick={() => onPickTab(r.id)}
            className="flex flex-col gap-1 rounded-md border border-border bg-panel px-3 py-2.5 text-left hover:bg-accent-bg"
          >
            <span className="text-[11px] text-dim">{r.label}</span>
            <span className="text-[20px] font-semibold leading-none">
              {r.n === null ? <span className="inline-block h-5 w-10 animate-pulse rounded-sm bg-border" /> : r.n}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function AppSidebar({
  view,
  resTab,
  subOpen,
  toggleSub,
  pickView,
  pickResTab,
}: {
  view: string;
  resTab: ResTab;
  openMap: Record<string, boolean> | null;
  subOpen: (item: NavItem) => boolean;
  toggleSub: (id: string, open: boolean) => void;
  pickView: (v: string) => void;
  pickResTab: (t: string) => void;
}) {
  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild>
              <button type="button" onClick={() => pickView("overview")}>
                <span className="flex aspect-square size-8 items-center justify-center rounded-sm bg-panel text-accent">
                  <Command />
                </span>
                <span className="grid flex-1 text-left leading-tight">
                  <span className="truncate font-semibold">idlefill · arbiter</span>
                  <span className="truncate text-xs text-dim">background-work gate for the local LLM server</span>
                </span>
              </button>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <NavMain
          items={NAV}
          activeId={view}
          activeSubId={view === "resources" ? resTab : null}
          isOpen={subOpen}
          onToggle={toggleSub}
          onPick={pickView}
          onPickSub={(_id, subId) => pickResTab(subId)}
        />
      </SidebarContent>
    </Sidebar>
  );
}
