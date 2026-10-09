# Shell updater — issue #75 (grill, 2026-10-09)

## What this doc amends

This doc is the shell updater plane for the Tauri shell
(`tauri/src-tauri`, built by `tauri/build.sh`). It inherits
`docs/architecture/tauri-cutover.md` (LOCKED, #69) as the constraint.
The amendments are stated once, here, and again in the Amendment
section at the top of that doc.

SUPERSEDED (two clauses, both inside D7 of `tauri-cutover.md`):

1. The D7 opening line: "LOCKED: no updater of any kind in the
   artifact." The shell now carries a signed updater channel
   (`tauri-plugin-updater`, Tauri v2). The daemon and the arbiter
   carry none.
2. Q-b's artifact clause inside D7: "NOTHING on releases. No app zip,
   no appcast, no signing." The release now carries the shell's
   updater artifacts: `latest.json` and the signed
   `Idlefill.app.tar.gz`. The Q-b sentence "the app is built from the
   checkout everywhere" stands for the daemon and the arbiter, and
   stands as the shell's manual path (`update.sh`). It no longer
   stands as the shell's only path.

UNCHANGED and REUSED (cited, not re-derived): D1 (one artifact,
window + tray, the window close does not quit the app), D2 (the
runtime external page, CSP unset, the ATS exception ships), D3 (the
document-start token seam, write-only), D4 (lifecycle parity and the
settings window shape — the settings window gains an Update section,
the shape and the capability posture stand), D5 (deep links, the
single-instance plugin), D6 (blank-origin behavior, the Q-a one-shot
auto-reload), D7's retirement inventory (every retired Swift plane stays
retired, and the `--version` marker contract survives), D8 (the
`tauri/` tree plan), D9 (the CI and test gates), Q-c (single tray
click), Q-d (one LaunchAgent).

The retired Swift updater plane is not revived. This doc adds one
plane: a signed feed on the existing Forgejo release endpoint, the
same access pattern the retired Swift Sparkle plane proved live
(#21).

## Verified state at HEAD 4369a37 (2026-10-09, this machine)

- `tauri/src-tauri/tauri.conf.json`: `version` is `1.0.0` (line 4),
  `plugins` carries only `deep-link` (lines 24-29),
  `bundle.createUpdaterArtifacts` is unset (line 16-23).
- `tauri-plugin-updater` / `tauri-updater`: zero hits in
  `tauri/src-tauri/Cargo.toml` and `Cargo.lock` (grep, HEAD).
- `scripts/release.sh`: notes-only. Header lines 3-7: "release NOTES
  only — no app zip, no appcast, no signing". Lines 20-22: the
  Sparkle machinery "retired with the Swift shells". The pass is:
  validate the number (lines 38-46), drop the auto-created release
  (lines 64-82), create the release (lines 84-94), read it back
  (lines 96-99). No staging, no artifact stage, no live feed
  verification. `~/idlefill-release-staging` is absent on this
  machine.
- Live feed (anonymous GET, 2026-10-09):
  `https://git.samwarth.com/sam/idlefill/releases/download/latest/appcast.xml`
  → 200 (the `latest` pseudo-tag resolves to the newest release,
  `edge-main-033413a`, created 2026-10-08). The same route for
  `latest.json` → 404 (the asset does not exist yet: the expected
  pre-first-release state). Negative control: the GitHub-style route
  `https://git.samwarth.com/sam/idlefill/releases/latest/download/latest.json`
  → 404 (the Forgejo/Gitea route 404s, as the Sparkle work found).
- The newest release carries the carried-forward Sparkle assets
  (`appcast.xml`, `Idlefill 3.zip`, …): the carry-forward convention
  is live on this host today.
- Toolchain: `cargo-tauri 2.11.4` (`~/.cargo/bin/cargo-tauri
signer` exposes the `generate` and `sign` subcommands. `sign` takes
`-f/--private-key-path` and the
  `TAURI_SIGNING_PRIVATE_KEY` env). The keypair is minisign-based
  (`minisign-0.9.1` in the cargo registry). No keychain involvement.
- Architecture: `uname -m` → `arm64`. The platform key for this
  machine is `darwin-aarch64`.
- Installed bundler source (the citation for the artifact name):
  `tauri-bundler-2.10.1` `src/bundle/updater_bundle.rs:66` —
  `format!("{}.tar.gz", <the .app path>)`.
  `src/bundle/settings.rs:155-175` — `UpdaterSettings` carries
  `pubkey: String` and `v1_compatible: bool`.
- `tauri/build.sh` already merges a JSON patch over
  `tauri.conf.json` at build time (lines 49-54, the `TAURI_CONFIG`
  env seam) and takes `IDLEFILL_VERSION` as SemVer (lines 11-13).

## D1 — Scope: the shell channel only

LOCKED. The Tauri shell gains the signed updater channel. The daemon
and the arbiter stay on the checkout path: they run code straight
from the working tree (`tsx client/src/index.ts`), and a `git pull`
plus a `launchctl kickstart` gives them the new code (Q-b, unchanged
for them). `update.sh` stays the manual/checkout path for the shell
(pull, rebuild, rename-swap into /Applications, reinstall the app
agent — `update.sh` header, HEAD).

Rejected alternatives:

- A fleet-wide updater (daemon or arbiter packaging and
  auto-update): they need no binary distribution. The checkout path
  is their identity. Out of scope, D7.
- Reviving the Swift Sparkle plane: D7's retirement inventory stands
  byte-for-byte.

Trade-off: the shell gains one moving part (a signed download) and
keeps its full manual path. The other two planes gain nothing.

## D2 — Feed: the existing Forgejo release endpoint

LOCKED. The updater does two anonymous HTTPS GETs: the manifest
`latest.json`, then the signed bundle. No auth header, no token in
the client. The feed is a plain GET — the access pattern the retired
Swift Sparkle plane proved live (#21).

The feed URL (the manifest):

```
https://git.samwarth.com/sam/idlefill/releases/download/latest/latest.json
```

The `latest` pseudo-tag in the `{vTag}` slot resolves to the newest
release. The GitHub-style route `/releases/latest/download/` 404s on
Forgejo/Gitea (verified live 2026-10-09, both directions). The
feed resolves against the newest release only: every new release must
carry `latest.json` plus the bundle (the carry-forward rule the
appcast followed). The old `edge-main-*` releases carry no
`latest.json`, so they are inert to the feed.

The access posture is unchanged: the repo is public, ingress is
restricted to LAN/tailnet (urza's traefik to weakstone's Forgejo). No
new container, no new traefik route.

Rejected alternatives:

- The arbiter serves the feed: only warranted when the repo goes
  private and the feed must move behind auth. That is a named
  fallback (the arbiter mints the manifest at runtime), not work
  now.
- A third-party update host: no. The feed stays on the org's own
  host.

Trade-off: the release endpoint doubles as the feed. A bad release is
a bad feed. The operator controls both on one machine, and the
signature (D4) is the trust boundary.

## D3 — Artifacts: the two files the release gains

LOCKED. `scripts/release.sh` adds two artifacts, attached to the
same Forgejo release as the notes. Correction of the issue body: the
#69 cutover stripped the old artifact pass, so these stages are new
code, not an extension of an existing pass (the report lists this as
correction 1).

1. The signed update bundle: `Idlefill.app.tar.gz` (the macOS
   updater payload). The bundler emits it next to the `.app` when
   updater artifacts are on and the CLI signs the build
   (`tauri-bundler 2.10.1` `updater_bundle.rs:66`:
   `format!("{}.tar.gz", <the .app path>)` — from
   `src-tauri/target/release/bundle/macos/Idlefill.app` the artifact
   is `Idlefill.app.tar.gz`). The signature file sits beside it:
   `Idlefill.app.tar.gz.sig`. The name carries no space, so the
   download URL needs no percent-encoding (the Sparkle appcast needed
   it for `Idlefill 3.zip`).
2. The manifest: `latest.json`, assembled by `release.sh` from the
   release version, the bundle URL, and the `.sig` content. Shape
   (the Tauri v2 updater contract):

```json
{
  "version": "1.0.1",
  "pub_date": "2026-10-09T12:00:00Z",
  "notes": "Release #1",
  "platforms": {
    "darwin-aarch64": {
      "url": "https://git.samwarth.com/sam/idlefill/releases/download/latest/Idlefill.app.tar.gz",
      "signature": "<contents of Idlefill.app.tar.gz.sig>"
    }
  }
}
```

   - `version`: SemVer (a leading `v` is optional). The value the
     updater compares against the installed shell (D5).
   - `platforms` keys: `<os>-<arch>`. The shell is macOS arm64 today
     (`darwin-aarch64`, verified `uname -m` = arm64). The keys are
     additive: a future Intel build adds `darwin-x86_64` without
     touching the existing key.
   - `signature`: the content of the `.sig` file. A path or a URL is
     rejected by the client.
   - `notes`, `pub_date` (RFC 3339): optional, present.

The `url` uses the `latest` pseudo-tag shape. It matches the feed URL. It
survives an in-place republish of the release.

The `release.sh` stages (new code, in order. Each stage fails closed):

- The private key check: `TAURI_SIGNING_PRIVATE_KEY` absent (or the
  key file missing) → exit with a named error before anything touches
  Forgejo. No partial publish.
- Build the shell with updater artifacts on (D4): the release pass
  calls `tauri/build.sh` with `IDLEFILL_VERSION=1.0.<N>` (D5),
  `IDLEFILL_BUILD_MARKER=<short sha>`, and `createUpdaterArtifacts`
  turned on for that build through the existing `TAURI_CONFIG` merge
  seam (`tauri/build.sh:49-54`). The exact env or flag is a
  build-wave detail.
- Collect `Idlefill.app.tar.gz` + `Idlefill.app.tar.gz.sig` from
  `src-tauri/target/release/bundle/macos/`.
- Assemble `latest.json` (D3 shape) from the release number, the
  bundle URL, and the `.sig` content.
- Attach `latest.json` + `Idlefill.app.tar.gz` to the release
  (Forgejo asset upload: `POST /releases/{id}/assets`, multipart
  field `attachment` — the verified pitfall from the Sparkle work).
- Carry-forward: the newest release keeps the current `latest.json`
  plus the bundle. A persistent staging dir holds the pair (the
  Sparkle convention: `~/idlefill-release-staging`, absent today,
  created by the first run).
- Live verification. The #69 cutover removed the old pass. This stage re-adds
it:
  an anonymous GET of the feed URL returns 200 and parses, its
  `version` matches the release SemVer, and the bundle URL GETs 200.
  The verification is anonymous (no token): the feed's access shape.

Rejected alternative: tag-named bundle URLs (`/releases/download/v1/
Idlefill.app.tar.gz`). An in-place republish keeps the release name,
and the `latest` shape matches the feed URL and the Sparkle
precedent. One shape for the whole feed.

Dry-run recipe (verification, from the Sparkle skill): a
temp-release round trip — create a temp release, upload the stand-in
artifacts, fetch them through `releases/download/latest/`, delete the
release, assert zero residue. The GET 200 + parse checks need no real
signature. The minisign verification is proven in-app at the first
real install (D6).

## D4 — Keys: minisign, the private key outside the repo

LOCKED. The keypair is minisign-based, generated once with
`cargo-tauri signer generate` (CLI verified: the `signer generate`
and `signer sign` subcommands. No keychain is involved (the Sparkle keychain
hang does not apply here).

- The private key: `~/.config/idlefill/tauri-signing.key`, mode 0600,
  on the operator host. It never enters the repo (verified absent at
  HEAD). Build access is through `TAURI_SIGNING_PRIVATE_KEY`
  (content or path), set by the operator. No script ever writes it.
- The public key: `tauri.conf.json` `plugins.updater.pubkey`, as
  content (not a file path). The public key is public and lives in
  the repo. `UpdaterSettings` (installed `tauri-bundler 2.10.1`,
  `settings.rs:155-175`) carries `pubkey: String`.
- `plugins.updater.endpoints`: the feed URL (D2), as the one entry
  of the endpoints array. The updater tries the next endpoint only on
  a non-2XX response.
- `bundle.createUpdaterArtifacts`: set on the release pass only (the
  `TAURI_CONFIG` merge, D3), not in the committed `tauri.conf.json`.
  A committed `true` would fail every keyless build, and `update.sh`
builds on every checkout machine. The committed config stays key-free. The
release pass is the only signed build.

The public key cannot change later: the shell verifies with the key
it was built against. Rotation means a new keypair plus a rebuilt
shell (a new baseline). The keypair must exist before the first
release. Same rule as the retired Sparkle `SUPublicEDKey`.

Rejected alternatives:

- `createUpdaterArtifacts: true` committed: breaks the universal
  checkout build on every keyless machine.
- `v1_compatible` artifacts: the shell has no v1 history. Off.
- The key in a Forgejo secret for CI: that is the signing-host
  question (Q-e, PROPOSED). The doc names the operator host as the
  default.

Trade-off: one key on one host. Losing it breaks the updater until a
new keypair exists, and the new public key forces a shell rebuild.
The operator keeps the key at the named path (0600).

## D5 — Version scheme: `1.0.<N>`, cut at the release

LOCKED. The shell's `tauri.conf.json` `version` becomes `1.0.<N>`,
where N is the release number `release.sh` already validates
(integer ≥ 1, tag `v<N>` — the tag scheme and the validation are
unchanged, `release.sh:38-46`). The current `1.0.0` stands as the
pre-update baseline (the #69 cutover build). The first updater
release (v1) publishes `1.0.1`. The updater compares SemVer. A version equal
to or below the installed one is ignored.

`tauri/build.sh` already takes `IDLEFILL_VERSION` and merges it into
`version` through the `TAURI_CONFIG` env (lines 11-13, 49-54,
verified). The release pass passes `1.0.<N>`. No new build seam.

The `--version` marker contract survives unchanged (D7 inventory):
`idlefill <marker>` prints the commit sha (the build identity,
`lib.rs:733`). The SemVer is the update coordinate. The two are
orthogonal, and both survive.

Rejected alternatives:

- `0.0.<N>` (the Sparkle v0.0.x precedent): below the installed
  1.0.0 baseline. The updater would never fire.
- The bare release number (the live Sparkle appcast carries
  `sparkle:version` "3"): not SemVer. The Tauri client rejects it.
- The marker as the version: the commit sha is not SemVer.

Trade-off: one source of truth for the number (the release number),
and the marker keeps its job. The number is cut at the release, not
per commit.

## D6 — Settings UI: exception-only, GUI-triggered

LOCKED. The settings window (D4 shape stands: the small local window,
native commands over the locked-down IPC capability) gains an Update
section:

- "Check for updates…" — the GUI-only trigger. No check at launch,
  no timer, no watchdog. The check watchdog retired with the Swift
  plane and stays retired. Exception-Only (DESIGN.md).
- "Install and restart" — a row that renders only when an update is
  found. Exception-only, like the existing arbiter rows.
- A status line during the download and the install, driven by the
  updater's events.

Relaunch path: on macOS the updater's install replaces the app
bundle and relaunches it. D1's keepalive (the window close hides the app. The
app lives behind the tray) is checked against the relaunch
by acceptance: the new instance takes the tray (the single-instance
plugin, D5 stack, enforces one instance), the old process exits, and
the close-to-tray behavior holds on the new build.

Rejected alternatives:

- A check at launch or on a timer: the operator trigger stands
  (Exception-Only applies, and no watchdog of any kind exists).
- A tray "update available" word: the settings row is the surface.
  The tray word keeps one job (the arbiter state).

Trade-off: an update surfaces only when the operator opens Settings.
Stated, not hidden: that matches the single-operator posture and the
exception-only rule.

## D7 — Out of scope

- The daemon or arbiter updater. They stay on the checkout path until
  a separate decision says otherwise.
- A dedicated updater container or traefik route. Only warranted when
  the repo goes private and the feed moves behind auth (then the
  arbiter serves it, D2 fallback).
- Windows and Linux updater artifacts. The shell is macOS today. The
  manifest's per-platform keys are additive (D3).
- Key rotation. The public key is baked into the shell. Rotation means a new
keypair plus a rebuilt baseline (D4). Recorded, no work now.

## Rules (restated crisp)

1. One channel: the shell. The daemon and the arbiter stay on the
   checkout path. `update.sh` stays the manual path.
2. Two anonymous GETs: the manifest, then the bundle. No auth
   header, no token in the client.
3. The feed URL is the `latest` pseudo-tag shape. The GitHub-style
   route 404s on Forgejo.
4. The release carries `latest.json` plus the signed
   `Idlefill.app.tar.gz`. The newest release keeps both
   (carry-forward).
5. The signature is minisign. The private key lives at
   `~/.config/idlefill/tauri-signing.key` (0600, outside the repo).
   The public key lives in `tauri.conf.json` `plugins.updater.pubkey`
   (content, in the repo).
6. The SemVer is `1.0.<N>`. The tag is `v<N>`. The marker is the
   commit sha. All three survive.
7. The update UI is exception-only and GUI-triggered. No check at
   launch.

## What changes and what stays untouched

Changes: `tauri/src-tauri` (the plugin dependency, the updater
commands, the settings UI rows), `tauri/build.sh` (the release pass
turns `createUpdaterArtifacts` on and passes `1.0.<N>`),
`scripts/release.sh` (the artifact stages and the live verification),
`tauri.conf.json` (the `plugins.updater` block: `pubkey` after the
key exists, `endpoints` now), and the Forgejo release (two new assets
on the newest release).

Untouched: the daemon (`com.sam.idlefill.client`) and the arbiter
(`com.sam.idlefill.server`), `update.sh` (it keeps its job: the
manual path), the page (`dashboard/`, the arbiter's served surface),
the D1–D6 and D8–D9 mechanics, the `--version` marker contract, the
retired Swift planes, the daemon + arbiter LaunchAgent labels.

## Blocked on the owner

A build wave cannot do these two steps without the owner's
participation (the doc writes no secret and only names the steps):

1. Key generation: `cargo-tauri signer generate` on the operator
   host. The private key lands at
   `~/.config/idlefill/tauri-signing.key` (0600). The public key
output lands in `tauri.conf.json` `plugins.updater.pubkey`. The value is
public. The config commit is a normal build-wave commit
   that follows the generation).
2. The first signed run: the first `release.sh` pass with the key
   (it emits the bundle and the `.sig`, assembles `latest.json`,
   publishes, and verifies the live feed).

A build wave can do everything else without secrets: the plugin
dependency and the Rust commands, the settings UI rows, the
`endpoints` block, the `TAURI_CONFIG` merge mechanics, the
`release.sh` stages (fail-closed when the key is absent), the
version-scheme plumbing, and the dry-run harness (the temp-release
round trip with stand-in artifacts — the GET and parse checks need no
real signature).

## Open questions (owner input)

- **Q-e PROPOSED — the signing host.** The first release signs on
  the operator host (this Mac, the key's home, D4). Later releases:
  (a) the operator keeps signing locally (recommended: one key on
  one host, no key on the CI runner), or (b) the private key is
  provisioned on the CI runner (urza) so the tag-triggered pipeline
  signs. This is a security decision: the private key's placement on
  a CI host. The doc names (a) as the default until the owner decides
  otherwise.
