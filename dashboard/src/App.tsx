import * as React from "react";
import {
  Activity,
  BarChart3,
  Command,
  LayoutDashboard,
  Server,
  Settings as SettingsIcon,
  Waypoints,
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
import { NAV_IDS, RES_SUBTABS, type ResTab } from "@/nav";
import { encodeTabFocus, machineKey, parseHash, serverKey, MACHINE_PREFIX, SERVER_PREFIX } from "@/lib/hash-nav";
import { Toaster } from "@/components/ui/sonner";
import { getState, type StateSnapshot } from "@/lib/api";
import { InferenceServers } from "@/views/InferenceServers";
import { Overview } from "@/views/Overview";
import { Sessions } from "@/views/Sessions";
import { Machines } from "@/views/Machines";
import { Projects } from "@/views/Projects";
import { Models } from "@/views/Models";
import { Agents } from "@/views/Agents";
import { Usage } from "@/views/Usage";
import { Settings } from "@/views/Settings";
import { applyTheme } from "@/lib/theme";

// The Mesh view pulls in the React Flow runtime (~half the old bundle);
// lazy-loaded so the graph never weighs on the Overview first paint. The
// Suspense fallback is the same "waiting" line the view shows on load.
const Mesh = React.lazy(() => import("@/views/Mesh").then((m) => ({ default: m.Mesh })));

// The sidebar nav (shadcn sidebar-16 shape). Every parent item is itself a
// view: picking "Resources" lands on its Overview. The chevron beside it
// toggles the sub-tab list — a sub-tab shows that sub-view directly.
const NAV: NavItem[] = [
  { id: "overview", title: "Overview", icon: LayoutDashboard },
  {
    id: "resources",
    title: "Resources",
    icon: Server,
    items: RES_SUBTABS.map((t) => ({ id: t.id, title: t.title })),
  },
  { id: "mesh", title: "Mesh", icon: Waypoints },
  { id: "sessions", title: "Sessions", icon: Activity },
  { id: "usage", title: "Usage", icon: BarChart3 },
  { id: "settings", title: "Settings", icon: SettingsIcon },
];

const VIEW_KEY = "idlefill.viewTab";
const RES_KEY = "idlefill.resTab";
const SUB_OPEN_KEY = "idlefill.navSubOpen";

const VIEW_IDS: readonly string[] = NAV_IDS;

function readView(): string {
  const raw = location.hash.replace(/^#/, "");
  const stored = localStorage.getItem(VIEW_KEY);
  // Deep links to a Resources sub-tab: #projects/#models were top-level
  // tabs before the Resources rethink; every sub-tab id lands on
  // Resources now (overview stays the top-level view — same id). A
  // focus-carrying hash (#machines/focus/…) lands the same way: parseHash
  // peels the focus segment (lib/hash-nav.ts) and the tab grammar below is
  // byte-for-byte the old one for every bare id.
  const { tab } = parseHash(raw);
  if (tab !== null) {
    localStorage.setItem(RES_KEY, tab);
    return "resources";
  }
  if (VIEW_IDS.includes(raw)) return raw;
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
  // A focus carried by the hash ("#machines/focus/machine/urza"): the key
  // lives HERE — App-owned, single source — and only the sub-tab view whose
  // scheme prefix matches ever receives it (gated at render below, so a
  // servers focus can never move a Machines row and vice versa). The target
  // view consumes it exactly once (consumeFocus); the hash is then rewritten
  // to the bare sub-tab so a refresh opens the tab without re-flashing.
  const [focus, setFocus] = React.useState<{ key: string } | null>(() => {
    const p = parseHash(location.hash);
    return p.tab !== null && p.focus !== null ? { key: p.focus } : null;
  });
  const [openMap, setOpenMap] = React.useState<Record<string, boolean> | null>(readSubOpen);
  const [st, setSt] = React.useState<StateSnapshot | null>(null);
  const [stErr, setStErr] = React.useState<string | null>(null);

  // 5s poll, like the legacy dashboard (the WS push plane comes later). The
  // apply channel for the color scheme (#68): at boot and on every poll, if
  // the snapshot carries theme.colors, set each present key as a CSS custom
  // property on <html> (the :root defaults stay the fallback — an absent key
  // keeps the default).
  React.useEffect(() => {
    let alive = true;
    const pull = () =>
      getState()
        .then((s) => {
          if (!alive) return;
          setSt(s);
          setStErr(null);
          applyTheme(s.theme?.colors);
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

  // The hash is a first-class input (deep links, and the focus rewrite
  // below): every change routes through parseHash. A sub-tab id (bare or
  // focus-carrying) lands exactly like the initial load does (readView); a
  // bare view id routes to that view; empty/unknown hashes change nothing
  // (the stored tabs stand — same as the boot fallback). pickView/pickResTab
  // and the cross-tab picks write the hash themselves; the handler re-asserts
  // the same state — idempotent, never a fight.
  React.useEffect(() => {
    const onHash = () => {
      const raw = location.hash.replace(/^#/, "");
      const p = parseHash(location.hash);
      if (p.tab !== null) {
        setView("resources");
        setResTab(p.tab);
        localStorage.setItem(RES_KEY, p.tab);
        setFocus(p.focus !== null ? { key: p.focus } : null);
      } else if (VIEW_IDS.includes(raw)) {
        setView(raw);
        localStorage.setItem(VIEW_KEY, raw);
        setFocus(null);
        // resTab is NOT reset here: only the explicit parent click (pickView)
        // lands Resources on Overview; a bare #resources hash just names the
        // section and the stored sub-tab stands — today's boot behavior.
      }
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // A view consumed its focus: drop the App state (the highlight rings are
  // the VIEWS' transient local state, self-clearing) and rewrite the hash to
  // the bare sub-tab — via replaceState on purpose: no extra history entry,
  // no hashchange echo, and a refresh of the rewritten URL opens the tab
  // with no focus to re-flash.
  const consumeFocus = React.useCallback(() => {
    setFocus(null);
    const p = parseHash(location.hash);
    if (p.tab !== null && p.focus !== null) history.replaceState(null, "", `#${p.tab}`);
  }, []);

  // The two cross-tab deep links (hierarchy → hierarchy, layout-only): the
  // focus key is minted by the ONE scheme (lib/hash-nav.ts), the hash rides
  // the encodeTabFocus grammar, the tab switch writes the same localStorage
  // pair a normal sidebar pick writes.
  const gotoServerCard = (serverId: string) => {
    const key = serverKey(serverId);
    setView("resources");
    localStorage.setItem(VIEW_KEY, "resources");
    setResTab("servers");
    localStorage.setItem(RES_KEY, "servers");
    location.hash = encodeTabFocus("servers", key);
    setFocus({ key });
  };
  const gotoMachineRow = (machine: string) => {
    const key = machineKey(machine);
    setView("resources");
    localStorage.setItem(VIEW_KEY, "resources");
    setResTab("machines");
    localStorage.setItem(RES_KEY, "machines");
    location.hash = encodeTabFocus("machines", key);
    setFocus({ key });
  };

  const pickView = (v: string) => {
    if (!VIEW_IDS.includes(v)) return;
    setFocus(null); // a normal pick never carries a focus — no stale key lingers
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
    setFocus(null); // a normal pick never carries a focus (the hash stays bare)
    setView("resources");
    localStorage.setItem(VIEW_KEY, "resources");
    setResTab(next);
    localStorage.setItem(RES_KEY, next);
    // The hash mirrors the sub-tab (no focus) — the deep-link grammar's
    // resting form, so the bar holds a URL that reopens exactly this view.
    // The sub-tab "overview" is the one id the grammar resolves to the TOP
    // level (readView precedence), so it writes the section id instead.
    location.hash = next === "overview" ? "resources" : next;
  };

  // Prefix gating (the no-cross-tab-leakage fence): each view receives only
  // its own scheme's key — a "server/…" focus never reaches the Machines
  // view, a "machine/…" focus never reaches a server card. A key matching
  // no prefix reaches NO view at all; normal picks clear the focus state.
  const machineFocus = focus !== null && focus.key.startsWith(MACHINE_PREFIX) ? focus.key : null;
  const serverFocus = focus !== null && focus.key.startsWith(SERVER_PREFIX) ? focus.key : null;

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
        {/* The gate-token field moved to the Settings tab (owner ask
            2026-10-19), same reasoning as the hand-off pair: entering the
            token is a settings task, not chrome for every part of the UI.
            The "paste it in Settings first" toasts point there. */}
        <main className="flex-1 px-5 py-4">
          {stErr && (
            <div className="mb-3 border border-err/40 bg-err/10 px-3 py-2 text-[12px] text-err">
              state unreachable: {stErr} — the arbiter is down or the token was rejected.
            </div>
          )}
          {view === "overview" && <Overview st={st} />}
          {view === "mesh" && (
            <React.Suspense fallback={<div className="text-[12px] text-dim">loading the mesh graph…</div>}>
              <Mesh st={st} />
            </React.Suspense>
          )}
          {view === "sessions" && <Sessions st={st} />}
          {view === "usage" && <Usage />}
          {view === "resources" && resTab === "servers" && (
            <InferenceServers st={st} focusKey={serverFocus} onHostPick={gotoMachineRow} onConsumeFocus={consumeFocus} />
          )}
          {view === "resources" && resTab === "overview" && (
            <ResourceOverview st={st} onPickTab={pickResTab} />
          )}
          {view === "resources" && resTab === "machines" && (
            <Machines st={st} focusKey={machineFocus} onEnginePick={gotoServerCard} onConsumeFocus={consumeFocus} />
          )}
          {view === "resources" && resTab === "projects" && <Projects st={st} />}
          {view === "resources" && resTab === "models" && <Models st={st} />}
          {view === "resources" && resTab === "agents" && <Agents st={st} />}
          {view === "settings" && <Settings st={st} />}
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
  // The hierarchy counts (owner ask 2026-10-12): machines counts MACHINES
  // (this one + every mesh peer), not clients; agents counts the profile
  // rows the clients report (the roster ADD-key — absent on an old client
  // contributes 0, a known gap, never a silent undercount claim).
  const rows = [
    { id: "servers", label: "Inference servers", n: st ? st.servers.length : null },
    { id: "machines", label: "Machines", n: st ? 1 + (st.mesh?.peers.length ?? 0) : null },
    { id: "projects", label: "Projects", n: st ? st.projects.length : null },
    { id: "models", label: "Models", n: st ? st.model_aliases.length : null },
    {
      id: "agents",
      label: "Agents",
      n: st ? (st.clients ?? []).reduce((a, c) => a + (c.agent_roster?.length ?? 0), 0) : null,
    },
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
