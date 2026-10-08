// The nav model, single source: App.tsx renders it, nav.test.ts pins it.
//
// The id SET is a contract with the retired legacy dashboard
// (server/public/index.html, the body.view-* / data-view families): the
// React app must name every surface the old page had — a view dropped
// from this list is a surface that no longer exists anywhere. nav.test.ts
// fails when the two drift, so a rename or removal is a conscious act.
// `settings` is a React-only addition (the theme editor, #68) — a superset,
// so the drift test (legacy ⊆ React) still passes.

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
