# GRILL REPORT — Tauri shell updater: one signed channel on the Forgejo release endpoint

**Doc:** `docs/architecture/shell-updater.md` (new), plus the
AMENDMENT block added to `docs/architecture/tauri-cutover.md`
(2026-10-09). D1-D7 in the mesh.md format. D1-D6 LOCKED, Q-e
PROPOSED (the signing host). No src, config, or test file touched.
No key was generated and no secret was written by this grill. Type:
wayfinder:grilling. Source: Forgejo issue #75. Amends the LOCKED
`tauri-cutover.md` D7 (the updater-retirement clauses) only. It cites
the predecessor as the inherited constraint.

## What landed

The decision doc settles the issue's named decisions against code
read on disk at HEAD `4369a37` and the live probes below. The shell
gains one signed channel. The daemon and the arbiter stay on the
checkout path. `update.sh` keeps its job as the manual path.

## Replaces from `tauri-cutover.md`, stated as amendments

Two clauses inside D7 are SUPERSEDED (the amendment block in the
predecessor names them):

1. The D7 opening line: "LOCKED: no updater of any kind in the
   artifact." SUPERSEDED: the shell gains a signed updater channel
   (`tauri-plugin-updater`). The daemon and the arbiter carry none.
2. Q-b's artifact clause inside D7: "NOTHING on releases. No app
   zip, no appcast, no signing." SUPERSEDED for the shell: a release
   now carries `latest.json` and the signed `Idlefill.app.tar.gz`.
   Q-b's checkout clause stands for the daemon and the arbiter, and
   `update.sh` stays the shell's manual path. It no longer stands as
   the shell's only path.

Everything else in the predecessor (D1, D2, D3, D4, D5, D6, D7's
retirement inventory including the `--version` marker contract, D8,
D9, Q-c, Q-d) stands UNCHANGED and is REAFFIRMED in the amendment
block, cited as the inherited constraint.

## Verified facts (2026-10-09, this machine, HEAD 4369a37)

- `tauri/src-tauri/tauri.conf.json`: `version` is `1.0.0` (line 4),
  `plugins` carries only `deep-link` (lines 24-29),
  `bundle.createUpdaterArtifacts` is unset (lines 16-23).
- Absence claim: `tauri-plugin-updater` / `tauri-updater` get zero
  hits in `tauri/src-tauri/Cargo.toml` and `Cargo.lock` (grep at
  HEAD). The updater plane does not exist in the tree yet. This is
  new code to build.
- `scripts/release.sh` at HEAD is notes-only: lines 3-7 ("release
  NOTES only — no app zip, no appcast, no signing"), lines 20-22
  (the Sparkle machinery retired at the #69 cutover), the pass is
  validate (38-46) / drop auto-release (64-82) / create (84-94) /
  read back (96-99). No staging, no artifact stage, no live feed
  verification. `~/idlefill-release-staging` is absent on this
  machine.
- Live feed, anonymous GET:
  `https://git.samwarth.com/sam/idlefill/releases/download/latest/appcast.xml`
  → **200** (the `latest` pseudo-tag resolves to the newest release
  `edge-main-033413a`, created 2026-10-08T18:18:31Z. The newest release carries the carried-forward Sparkle assets).
  `https://git.samwarth.com/sam/idlefill/releases/download/latest/latest.json`
  → **404** (the asset does not exist yet: the expected
  pre-first-release state, not a route error). Negative control:
  `https://git.samwarth.com/sam/idlefill/releases/latest/download/latest.json`
  (GitHub-style route) → **404** (the Forgejo/Gitea route 404s, as
  the Sparkle work found).
- Toolchain: `~/.cargo/bin/cargo-tauri` (2.11.4) exposes
  `signer generate` and `signer sign`. `sign` takes
  `-f/--private-key-path` and the `TAURI_SIGNING_PRIVATE_KEY` env.
  `minisign-0.9.1` is in the cargo registry (the keypair is
  minisign-based, no keychain involved).
- Installed bundler source (the artifact-name citation):
  `tauri-bundler-2.10.1` `src/bundle/updater_bundle.rs:66` —
  `format!("{}.tar.gz", <the .app path>)` (from
  `src-tauri/target/release/bundle/macos/Idlefill.app` the payload is
  `Idlefill.app.tar.gz`, the `.sig` beside it).
  `src/bundle/settings.rs:155-175` — `UpdaterSettings` carries
  `pubkey: String` and `v1_compatible: bool`.
- `tauri/build.sh` already merges a JSON patch over
  `tauri.conf.json` at build time (lines 49-54, the `TAURI_CONFIG`
  seam) and takes `IDLEFILL_VERSION` as SemVer (lines 11-13). The
  `--version` marker contract is alive in the tree
  (`tauri/src-tauri/src/lib.rs:733`: "survives the updater's death
  (D7)").
- `uname -m` → `arm64`. The platform key for this machine is
  `darwin-aarch64`.

## Corrections (issue body claims re-verified)

1. The issue says `scripts/release.sh` "already runs the full
   pipeline: build → package → `generate_appcast` → publish to the
   Forgejo release (persistent staging at `~/idlefill-release-staging/`,
   carry-forward of old files) → live feed verification." That is the
   pre-#69 state. At HEAD `4369a37` the cutover stripped the artifact
   pass: the script is notes-only (citations above), and
   `~/idlefill-release-staging` is absent on this machine. The Tauri
   artifact stages and the live verification pass are NEW code in
   `release.sh`, and the staging dir is created by the first run. The
   issue's carry-forward and dry-run conventions are adopted from the
   retired Sparkle work (the skill recipe), not from the live script.
2. The feed URL `https://git.samwarth.com/sam/idlefill/releases/download/latest/latest.json`
   is currently 404 (the asset does not exist). The route shape is
   verified live over the same route's existing asset
   (`latest/appcast.xml` → 200). The 404 is the expected
   pre-first-release state, not a defect.
3. The issue's proposed manifest keys (`version`, per-platform `url`,
   `signature`) match the installed Tauri v2 contract
   (`tauri-bundler 2.10.1`. The client looks up the `platforms` entry). The doc names the exact field names
   (`version` / `pub_date` / `notes` / `platforms."<os>-<arch>".url`
   / `.signature`) so the build wave writes one shape.

## Decisions

- D1 LOCKED: scope is the shell only. The daemon and the arbiter
  stay on the checkout path (`git pull` + `launchctl kickstart`).
  `update.sh` stays the manual/checkout path.
- D2 LOCKED: the feed is the existing Forgejo release endpoint. Two
  anonymous GETs, no auth header, no token in the client. The feed
  URL is the `latest` pseudo-tag shape (the GitHub-style route 404s
  on Forgejo, verified live). Carry-forward: the newest release
  carries `latest.json` plus the bundle.
- D3 LOCKED: the artifacts. `latest.json` (version,
  `platforms."darwin-aarch64".url`, `.signature` = the `.sig`
  content, optional `pub_date` + `notes`) and the signed
  `Idlefill.app.tar.gz` (the macOS payload from the bundler,
  `updater_bundle.rs:66`). `release.sh` gains fail-closed stages:
  key check → signed build (`createUpdaterArtifacts` on, only on the release pass, through the existing `TAURI_CONFIG` merge) → collect the
  pair → assemble the manifest → attach (Forgejo multipart field
  `attachment`) → carry-forward through a persistent staging dir →
  anonymous live verification (200 + parse + version match + bundle
  200).
- D4 LOCKED: keys. minisign keypair, generated once with
  `cargo-tauri signer generate`. The private key:
  `~/.config/idlefill/tauri-signing.key` (0600, outside the repo,
  operator host, accessed through `TAURI_SIGNING_PRIVATE_KEY`). The
  public key: `tauri.conf.json` `plugins.updater.pubkey` as content
  (in the repo, public). `endpoints` = the feed URL.
  `createUpdaterArtifacts` is set on the release pass only, never
  committed, so keyless checkout builds keep working.
- D5 LOCKED: the version scheme is `1.0.<N>` (N = the release
  number, tag `v<N>` unchanged). `1.0.0` is the pre-update baseline.
  The `--version` marker (the commit sha) is orthogonal and
  survives.
- D6 LOCKED: the settings window gains an exception-only Update
  section. "Check for updates…" (the GUI-only trigger. No check at launch, and no timer), an "Install and restart" row only when an
  update is found, a status line during download/install. The
  relaunch path is checked against the D1 tray-keepalive by
  acceptance.
- Q-e PROPOSED: the signing host. The first release signs on the
  operator host. Later releases default to the operator host (no key
  on the CI runner). Provisioning the key on urza is the alternative.
  The owner decides.

## Blocked on the owner

- Key generation: `cargo-tauri signer generate` on the operator
  host. The private key lands at `~/.config/idlefill/tauri-signing.key`
  (0600). The public key lands in `tauri.conf.json`
  `plugins.updater.pubkey`.
- The first signed run: the first `release.sh` pass with the key
  (emit the pair, assemble `latest.json`, publish, verify live).

A build wave can do without secrets: the plugin dependency and the
Rust commands, the settings UI rows, the `endpoints` block, the
`TAURI_CONFIG` merge mechanics, the `release.sh` stages (fail-closed
when the key is absent), the version-scheme plumbing, and the dry-run
harness (the temp-release round trip with stand-in artifacts).

## What did not happen

- No src, config, or test file was touched (the fence held: the
  only edits are the two docs and the index line in
  `docs/reports/README.md`).
- No key was generated. No secret was written. Nothing was pushed.
