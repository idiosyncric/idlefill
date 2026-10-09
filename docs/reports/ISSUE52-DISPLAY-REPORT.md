# Issue #52 slice 2 — display report

Built 2026-10-09 on branch `issue-52-display` (from main HEAD `3ce1dcb`).
Companion: `ISSUE52-CAPTURE-REPORT.md` (slice 1, the data half). This slice shows the engine load read on the InferenceServers cards. **The idle verdict is unchanged.** The two-axes rule holds: the idle word is a verdict, the load read is a measurement. They never merge into one word.

## What shipped

### 1. The load read rides `/api/state` on the row (the missing link)

Slice 1 captured the reading onto the #51 sample line and the `IdleSignal`
type. The `/api/state` row `signal` block (serverView) mapped only verdict
fields, so the dashboard never saw the reading. This slice threads the tick's
own read (`loadView` in `server/src/index.ts`) into the row `signal` block via
one new optional `ApiDeps.loadSignal` hook. Absent (no collector for the kind,
or never read) = the spread is empty = the signal block stays byte-for-byte as
before. `metrics_load_stale_s` also rides `/api/state` (ADD key) so the display
labels staleness against the arbiter's window.

### 2. The dashboard load read beside the idle word

`dashboard/src/lib/load-read.ts` (new, pure): `loadRead(sig, staleS)` returns
`null` when `load_source` is absent (the view renders nothing), else the
source label + the present parts (`gpu N%`, `N tok/s`, the model name).
Exception-only: an absent key renders nothing. Never a zero. Never "n/a"
noise. `load_age_s` above the window flags the read stale (the view dims it.
The values still show). `InferenceServers.tsx`: the read renders on its own
line beside the idle word + the routing dot. A separate element. The idle word
markup is untouched. Design tokens only (`text-dim`, `opacity-60`).

### 3. Tests

`dashboard/test/load-read.test.ts` (node:test + tsx, the repo test style):
absent keys render nothing (null. A null signal too. A named source with no
parts shows only the source), the present case renders the expected strings,
staleness against the window, and the partial read shows only the present
keys. The server suite (including the slice 1 verdict byte-identity tests and
the `/api/state` shape tests) runs unchanged and green.

## Test evidence

- `NODE_ENV=test npm run test` (root) — green: server 286/286, client 159/159, adapters 19/19, dashboard 4/4
- `NODE_ENV=test npx tsc --noEmit` (dashboard) — clean
- `NODE_ENV=test npx tsc --noEmit` (server) — clean
- `NODE_ENV=test npm run build` — green. The served bundle (`dashboard/dist`) is committed

## Still PROPOSED

- The D4 wave: the busy veto, strata `in_flight`, llama-swap `model_loaded` from `/v1/models`
- GPU memory display (the keys ride the wire. The card shows the compact read: source, GPU util, rate, model)
