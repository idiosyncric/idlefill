# Issue #68 brief (mirror of the Forgejo issue body)

## Ask (owner, 2026-10-06)

The connector/pipe color scheme from the Sessions flow view (#67) — plus the other state colors on the dashboard — must become **configurable in Settings**. The user asked to file this so the #67 build ships with known defaults and the knob comes after.

## Scope

- One theme/state map for the whole dashboard (not just flow pipes): current tokens already live in CSS vars (the dashboard themes with them — grep `--` vars in `server/public/index.html` head). #67 adds semantic flow states (idle, queued, thinking-green, output-blue, toolcalls-purple). Those join the same map.
- Settings: an editable state→color map (color inputs per named state, live preview of one sample pipe/node row), persisted server-side (the arbiter's config/state pattern. It must reach every machine's dashboard — the arbiter is the shared web surface, per #61 the desktop hosts it).
- Defaults from the current palette. A named preset list (current, high-contrast, colorblind-safe per PRODUCT-style WCAG posture: state by hue + shape + label, never color alone — the dashboard already uses dot+word for running/idle) is a stretch goal. The editable map is the contract.
- Sanitizer posture: hex colors only (`#rgb`/`#rrggbb`), bounded list, drop-don't-reject on malformed input. Colors NEVER carry a token or secret — pure CSS-safe values. Store separately from any auth surface.
- Where the map is applied: arbiter publishes it as an ADD-key on `/api/state` (or a small `/api/theme` GET, pick the cheaper fit — the dashboard already polls state). The page applies it by setting CSS custom properties at boot + on change. Both themes (dark/light) keep a separate entry if the current stylesheet distinguishes them.

## Acceptance

- Change a color in Settings → the live dashboard reflects it on next poll without a restart. It persists across reload and arbiter restart.
- A malformed injected value (via API test) drops that key, keeps the default, never breaks the page (no CSS injection: values validated to the hex grammar).
- #67's flow states appear in the map by their exact semantic names.

## Depends on

#67 (the flow states must exist to name them). File now so #67's author exposes the exact names rather than hardcoding colors in one place — the build rule: #67 must define every new color as a named CSS var from day one. This issue then only adds the editor + persistence.
