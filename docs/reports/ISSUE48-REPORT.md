# Issue #48 — sessions-tab visual cleanup: verified and closed

The R1–R9 code landed in `3941e25` (2026-10-02, direct-to-main wave).
This is the acceptance pass the issue's definition of done required —
the code was on main but never audited against the ledger.

## Ledger re-check (code, main `0afdb66`)

- **R1** duplicate header — gone: the count line sits where the header
  band was; the word `SESSIONS` appears once (the tab). Screenshot:
  confirmed.
- **R2** conflicting status — header word is SCOPED (`arbiter idle`)
  and the ring spins only while this machine holds a running poll
  (`desktop/IdlefillDesktop.swift:2775-2782`).
- **R3** double indicator — decorative dot removed; the state WORD is
  the single affordance, with `.accessibilityLabel("status …")` so the
  color+text rule holds for VoiceOver. Screenshot: confirmed
  word-only rows.
- **R4** host ambiguity — `mac-sam` renders as a bordered chip with a
  `.help()` tooltip. Screenshot: confirmed.
- **R5** Pause vs Active — the button is a real control: filled panel
  background, visible border, `Spacer(minLength: 16)` gap from the
  state word (`:2284-2296`).
- **R6** stranded count — `2 sessions` left-aligned, bound to its noun.
  Screenshot: confirmed.
- **R7** contrast — WCAG AA computed on the palette against both
  backgrounds: worst pair `err`-on-panel 5.16:1, secondary `dim` 6.15 /
  5.62:1, `text` 12.26 / 11.21:1. All ≥ 4.5. The old 0.55 row-opacity
  trick (which dragged text to 2.7:1) was replaced by a color swap on
  the name (`:2302-2306`).
- **R8** alignment — one centered axis: the whole row HStack is
  center-aligned (`:2220-2224`).
- **R9** empty void — empty state carries the minting hint with the
  real proxy port: `point one here: /model http://127.0.0.1:<port>/s/<token>`
  (`:2182-2197`).

## Harness + gates at this close-out

- `desktop/sessions-test.sh` — green: `SESSIONS-DT-HARNESS-PASS`
  (projection unchanged; this slice is view-layer only, as specced).
- Live app is the current edge build (`edge-main-87146cd`); the
  after-screenshot was captured from the running window
  (`screencapture -l<winID>`, the window-id pattern, not a region
  grab). Attached: `docs/reports/sessions-tab-after.png` (added in
  `0afdb66`); before-photo: `docs/reports/sessions-tab.png` on
  `9a87330`.
- Novice pass on the after-capture: zero new question marks — the
  verifier reads exactly: tab SESSIONS (active, underlined), header
  `idlefill · desktop` + scoped green `arbiter idle`, `2 sessions`,
  two rows (name, host chip, last-request line, single green state
  word, Pause control). No duplicate header, no dot+word pairs, no
  ambiguity between label and button.
- CI on `0afdb66`: edge gate + full-suite workflow both `success`.

## Verdict

R1–R9 resolved; definition of done met. Closing.
