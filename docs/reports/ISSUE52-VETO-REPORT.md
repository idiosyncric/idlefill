# #52 slice 3 — the monotonic busy veto (inert until the threshold is set)

## The knob (unset by design)
`metrics_llamaswap_busy_gpu_percent` is a named config knob with NO
default. It is the owner's single number that turns the llama-swap veto
ON. **It is still unset by the owner.** Absent = the llama-swap kind has
no busy predicate, so `load_busy` is absent and the verdict reads
byte-for-byte as pre-#52. The veto is therefore **inert for llama-swap
today**. The single number that turns it on is this one knob — set it to
a value on `gpu_util_percent` (0-100) above which a fresh read vetoes.
Non-positive / garbage input is refused (unset), never coerced.

## Per-kind predicates (D4)
- **strata:** `live.state` not in {idle, stopped, none} → busy. Needs no
  number — live now (the D4 experiment path).
- **llama-swap:** `gpu_util_percent` ABOVE the knob → busy. Knob unset →
  no predicate → `load_busy` absent (inert).
- **oMLX:** no predicate (identity/residency, not load). Always absent.

## The verdict (D2)
`idle = (not degraded and idle_for >= idle_seconds) and not load_busy`.
A fresh `load_busy` true flips `idle` true→false and the grant gate
denies with a named `load_busy` reason (the operator sees WHICH axis
held the grant back). `load_busy` false never forces idle; absent never
vetoes and never un-vetoes. The feed-degraded fail-closed is untouched —
the load axis has no path into `signal_degraded`.

## Freshness (D3)
`load_busy` is present only on a FRESH read (the `metrics_load_stale_s`
window, default 45 s). A stale read publishes the data keys + `load_age_s`
but no `load_busy` — unknown, not false.

## Wire keys (D5)
`load_busy` is an ADD key on the signal block and the #51 engine sample
line (same names on both). Absent = unset. The mesh snapshot stays
byte-for-byte (D7): `serverSignal` reads the raw basis; only the local
read surfaces honor the veto.

## Files changed
`server/src/load.ts` (strata collector + `loadBusyFor` + freshness gate),
`server/src/arbiter.ts` (`loadView` hook, `serverSignalVetoed`, grant gate
+ `load_busy` reason), `server/src/config.ts` + `types.ts` (the knob +
`load_busy`), `server/src/index.ts` (wires knob + window + `loadView`),
`server/src/api.ts` (the `/api/state` surfaces honor the veto),
`server/src/metrics.ts` (sample-line key), `server/test/busy-veto.test.ts`
(new), `server/test/load-capture.test.ts` (strata collector wired),
`server/package.json` (test list).

## Harness + build
- `NODE_ENV=test npm run test` (server workspace): **349/349 pass, 0 fail.**
- `NODE_ENV=test npx tsc --noEmit -p server/tsconfig.json`: **clean (0).**
- busy-veto.test.ts: no knob → no `load_busy` + verdict unchanged; fresh
  strata busy vetoes (reason `load_busy`); stale busy read is unknown and
  does not veto; llama-swap knob set, gpu above vetoes / below (and at)
  does not; a busy read never makes a busy engine read idle; a fresh
  `load_busy` false never forces idle; dead /metrics + busy knob never
  degrades; config knob has no default and refuses non-positive/garbage.
- The single root-suite failure (`client/ --version`) is a pre-existing
  worktree artifact (the worktree root has no `node_modules/.bin/tsx`);
  it is in `client/` (untouched here) and fails on clean main in a worktree.
