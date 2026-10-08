// The nav model, single source: App.tsx renders it, the server serves it.
// The view id set is the dashboard's contract: `settings` is a
// React-only addition (the theme editor, #68) on top of the cutover
// (2026-10-08) surface set (overview/resources/sessions/usage).

export type NavId = "overview" | "resources" | "sessions" | "usage" | "settings";
export const NAV_IDS: readonly NavId[] = ["overview", "resources", "sessions", "usage", "settings"];

export type ResTab = "overview" | "servers" | "machines" | "projects" | "models" | "agents";
export const RES_SUBTABS: { id: ResTab; title: string }[] = [
  { id: "overview", title: "Overview" },
  { id: "servers", title: "Inference servers" },
  { id: "machines", title: "Machines" },
  { id: "projects", title: "Projects" },
  { id: "models", title: "Models" },
  { id: "agents", title: "Agents" },
];
