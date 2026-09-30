# Vendored Sparkle (auto-update)

**Sparkle 2.10.0** (release 2026-09-13), vendored for the desktop app's
auto-updater. The framework is copied into the built app's
`Contents/Frameworks` by `desktop/build.sh` and linked into the executable;
`bin/` holds the release-side tooling used by `scripts/release.sh`.

## Provenance

- Upstream: https://sparkle-project.org/
- Tarball: https://github.com/sparkle-project/Sparkle/releases/download/2.10.0/Sparkle-2.10.0.tar.xz
- Tarball sha256: `c2bf58aa8387266ac179357b1415d6f2635f044da8be41042af32425dae6da0c`
- Verified against the tarball before vendoring (2026-09-29). Re-vendor by
  re-downloading the tarball, checking the sha256, and replacing
  `Sparkle.framework/` + `bin/` from the extracted archive.

Contents:

- `Sparkle.framework/` — the Sparkle framework (universal x86_64 + arm64,
  min OS 12.0). Bundled into the app, linked at compile time.
- `bin/generate_appcast` — generates + EdDSA-signs the `appcast.xml` feed
  from a directory of update zips (used by `scripts/release.sh`).
- `bin/generate_keys` — generates an ed25519 keypair (prints the public key
  for `SUPublicEDKey`).
- `bin/sign_update` — signs/verifies a single file or an appcast feed with
  an ed25519 key (key rotation re-signing).
- `bin/BinaryDelta` — delta-update generator (invoked by `generate_appcast`
  when producing .delta archives; kept for completeness).

## Ed25519 key (appcast signing)

The private key lives OUTSIDE the repo, at:

    ~/.config/idlefill/sparkle-ed-key.b64   (mode 0600, base64 of the 32-byte ed25519 seed)

It is created on first use by `scripts/release.sh` (Python `cryptography`,
which prints the derived public key for the operator to note down). The
public key is base64 of the 32-byte raw ed25519 public key (NOT the SPKI
ASN.1 DER form) and is injected into the built app's Info.plist as
`SUPublicEDKey` by `desktop/build.sh` (env `IDLEFILL_SUPUBLICEDKEY`).

**Regenerating / reading the public key from the seed:**

    python3 - <<'EOF'
    import base64
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
    seed = base64.b64decode(open(__import__('os').path.expanduser('~/.config/idlefill/sparkle-ed-key.b64')).read().strip())
    pub = Ed25519PrivateKey.from_private_bytes(seed).public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
    print(base64.b64encode(pub).decode())
    EOF

Or, with a Keychain key present: `bin/generate_keys -p`.

**Rotation procedure:** generate a NEW seed key, update the key file, re-run
`release.sh` (it re-signs the appcast with the new key and prints the new
public key), and ship the next build with the new `SUPublicEDKEY`. Note
plainly: an update signed with a new key is only accepted by installs whose
Info.plist carries that same new public key — i.e. only from the next build
onwards. Installs still carrying the old `SUPublicEDKey` will keep accepting
old-key-signed updates and reject the new-key ones.

## What is NOT here

The private key is never committed. `old_updates/` produced by
`generate_appcast` during a release is kept in the staging dir
(`~/idlefill-release-staging/`), not in the repo.
