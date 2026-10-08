// The dashboard color scheme (#68): the nine :root CSS tokens the theme plane
// edits. DEFAULT_THEME is an exact mirror of index.css :root (read from the
// file — the two surfaces stay identical). The apply step sets each present
// key as a CSS custom property on <html>; the :root defaults stay the
// fallback (an absent key keeps the default). Dark theme only.

// The nine tokens, each with the display label the Settings view shows.
export const THEME_KEYS: readonly { key: string; label: string }[] = [
  { key: "bg", label: "background" },
  { key: "panel", label: "panel" },
  { key: "border", label: "border" },
  { key: "text", label: "text" },
  { key: "dim", label: "dimmed" },
  { key: "ok", label: "ok" },
  { key: "warn", label: "warn" },
  { key: "err", label: "error" },
  { key: "accent", label: "accent" },
] as const;

// The :root defaults (index.css :root). A "reset to defaults" write posts
// this map; an unset key in a saved theme keeps this value in the browser.
export const DEFAULT_THEME: Record<string, string> = {
  bg: "#0d1117",
  panel: "#161b22",
  border: "#30363d",
  text: "#c9d1d9",
  dim: "#8b949e",
  ok: "#3fb950",
  warn: "#d29922",
  err: "#f85149",
  accent: "#58a6ff",
};

const HEX_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

// Whether a string is a conforming CSS hex color (the sanitizer's grammar —
// the dashboard guards its own writes with the same rule the server enforces).
export function isHexColor(v: unknown): v is string {
  return typeof v === "string" && HEX_RE.test(v);
}

/**
 * Apply a theme map to the document: set each present key as a CSS custom
 * property on <html>. Absent keys are left untouched — the :root defaults
 * stay the fallback. This is the apply channel the state poll drives (boot +
 * every poll): the utilities reference var(--token) via Tailwind v4 @theme
 * inline, so the root override cascades.
 */
export function applyTheme(colors?: Record<string, string>): void {
  if (!colors) return;
  const root = document.documentElement;
  for (const [key, value] of Object.entries(colors)) {
    if (isHexColor(value)) root.style.setProperty(`--${key}`, value);
  }
}
