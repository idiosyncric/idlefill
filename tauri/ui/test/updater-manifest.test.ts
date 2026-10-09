/**
 * updater-manifest.test.ts — the signed-updater `latest.json` dry-run
 * harness (issue #75 build wave, docs/architecture/shell-updater.md).
 *
 * This is the no-key proof of the manifest PLUMBING. It assembles the
 * `latest.json` shape the way scripts/release.sh will (from the release
 * version, the bundle URL, and the `.sig` file content) using STAND-IN
 * artifacts, then validates the JSON structure against the Tauri v2
 * updater contract (D3). It runs under `NODE_ENV=test npm run test`
 * with NO signing key and NO network: the GET + parse checks need no
 * real signature (the Sparkle dry-run convention).
 *
 * The pure assembly + validation rules here mirror the Rust
 * `tauri/src-tauri/src/updater.rs::latest_json` / `is_sig_b64` 1:1, so
 * the same contract is pinned in both planes (cargo test + node --test).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// The D3 manifest shape (Tauri v2 updater contract). The `signature`
// field is the base64 (STANDARD) of the `.sig` FILE CONTENT — the
// tauri-cli writes the `.sig` as one base64 line (the minisign
// signature box), and the client base64-decodes the field back to that
// text. A PATH or a URL is rejected by the client; so is here.
// ---------------------------------------------------------------------------

type Platform = { url: string; signature: string };
type Manifest = {
  version: string;
  pub_date?: string;
  notes?: string;
  platforms: Record<string, Platform>;
};

const SEMVER_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

// The `.sig` field check: one line, STANDARD base64 alphabet, non-empty.
// Mirrors updater.rs::is_sig_b64.
function isSigB64(s: string): boolean {
  const t = s.trim();
  if (t.length === 0 || /\s/.test(t)) return false;
  return /^[A-Za-z0-9+/=]+$/.test(t);
}

// Assemble `latest.json` from the release inputs. Mirrors
// updater.rs::latest_json. Returns null on a fail-closed input.
function assembleLatestJson(
  version: string,
  platforms: Array<[string, string, string]>, // [platform, url, signature]
  notes: string | null,
  pubDate: string | null,
): Manifest | null {
  const v = version.trim().replace(/^v/, "").trim();
  if (v.length === 0) return null;
  if (!SEMVER_RE.test(v)) return null;
  if (platforms.length === 0) return null;
  const platformsJson: Record<string, Platform> = {};
  for (const [platform, url, signature] of platforms) {
    if (platform.trim().length === 0) return null;
    if (url.trim().length === 0) return null;
    if (!isSigB64(signature)) return null;
    platformsJson[platform] = { url, signature };
  }
  const m: Manifest = { version: v, platforms: platformsJson };
  if (pubDate) {
    if (pubDate.length === 0) return null;
    m.pub_date = pubDate;
  }
  if (notes) m.notes = notes;
  return m;
}

// Validate the D3 JSON structure (the shape the client parses).
function validateLatestJson(m: Manifest): void {
  assert.equal(typeof m.version, "string");
  assert.ok(SEMVER_RE.test(m.version), `version is not SemVer: ${m.version}`);
  assert.equal(typeof m.platforms, "object");
  assert.ok(Object.keys(m.platforms).length > 0, "no platforms");
  for (const [platform, p] of Object.entries(m.platforms)) {
    assert.ok(platform.trim().length > 0, "empty platform key");
    assert.equal(typeof p.url, "string");
    assert.ok(p.url.trim().length > 0, `empty url for ${platform}`);
    assert.equal(typeof p.signature, "string");
    assert.ok(isSigB64(p.signature), `signature for ${platform} is not one base64 line`);
    // The field base64-decodes back to the multi-line minisign box.
    const raw = Buffer.from(p.signature, "base64").toString("utf8");
    assert.ok(raw.includes("\n"), `signature for ${platform} did not decode to a multi-line .sig box`);
  }
}

// A stand-in `.sig` file: the base64 (STANDARD) of a 4-line minisign
// signature box (untrusted comment, keynum b64, sig b64, trusted
// comment). No real key — this is the dry-run stand-in.
function makeStandInSig(): string {
  const box =
    "untrusted comment: signature from tauri secret key\n" +
    Buffer.alloc(32, 0x41).toString("base64") + // 32-byte keynum (b64)
    "\n" +
    Buffer.alloc(64, 0x42).toString("base64") + // 64-byte sig (b64)
    "\n" +
    "timestamp:1760000000\tfile:Idlefill.app.tar.gz\n";
  return Buffer.from(box, "utf8").toString("base64"); // one line = the field
}

test("dry-run: assemble + validate latest.json from stand-in artifacts", () => {
  const dir = mkdtempSync(join(tmpdir(), "idlefill-updater-dry-"));
  try {
    // The stand-in artifacts the release pass collects (no key needed).
    const sig = makeStandInSig();
    writeFileSync(join(dir, "Idlefill.app.tar.gz.sig"), sig, "utf8");
    writeFileSync(join(dir, "Idlefill.app.tar.gz"), Buffer.from("stand-in bundle"), "binary");
    const sigFromFile = readFileSync(join(dir, "Idlefill.app.tar.gz.sig"), "utf8");
    assert.ok(existsSync(join(dir, "Idlefill.app.tar.gz")));

    const url =
      "https://git.samwarth.com/sam/idlefill/releases/download/latest/Idlefill.app.tar.gz";
    const m = assembleLatestJson("1.0.3", [["darwin-aarch64", url, sigFromFile]], "Release #3", "2026-10-09T12:00:00Z");
    assert.ok(m, "assemble failed");
    validateLatestJson(m);
    assert.equal(m!.version, "1.0.3");
    assert.equal(m!.pub_date, "2026-10-09T12:00:00Z");
    assert.equal(m!.notes, "Release #3");
    const p = m!.platforms["darwin-aarch64"];
    assert.ok(p.url.endsWith("Idlefill.app.tar.gz"));
    assert.equal(p.signature, sigFromFile);
    // The client contract is exactly these top-level keys.
    assert.deepEqual(Object.keys(m!).sort(), ["notes", "platforms", "pub_date", "version"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dry-run: the leading v is stripped (tag v3 -> 1.0.3)", () => {
  const m = assembleLatestJson("v1.0.3", [["darwin-aarch64", "https://x/Idlefill.app.tar.gz", makeStandInSig()]], null, null);
  assert.ok(m);
  assert.equal(m!.version, "1.0.3");
  assert.equal(m!.pub_date, undefined);
  assert.equal(m!.notes, undefined);
  validateLatestJson(m!);
});

test("dry-run: fail-closed on bad inputs (no manifest, no publish)", () => {
  const sig = makeStandInSig();
  const P: Array<[string, string, string]> = [["darwin-aarch64", "https://x/Idlefill.app.tar.gz", sig]];
  // Non-SemVer version.
  assert.equal(assembleLatestJson("not-semver", P, null, null), null);
  // No platforms.
  assert.equal(assembleLatestJson("1.0.0", [], null, null), null);
  // Empty platform key / empty url / empty signature.
  assert.equal(assembleLatestJson("1.0.3", [["", P[0][1], sig]], null, null), null);
  assert.equal(assembleLatestJson("1.0.3", [["darwin-aarch64", "", sig]], null, null), null);
  assert.equal(assembleLatestJson("1.0.3", [["darwin-aarch64", "https://x/y", ""]], null, null), null);
  // A PATH and a URL are not base64 .sig content (the '/' rule).
  assert.equal(assembleLatestJson("1.0.3", [["darwin-aarch64", "https://x/y", "~/keys/sig.txt"]], null, null), null);
  assert.equal(assembleLatestJson("1.0.3", [["darwin-aarch64", "https://x/y", "https://x/sig"]], null, null), null);
  // A multi-line .sig pasted raw (unencoded) is rejected.
  assert.equal(assembleLatestJson("1.0.3", [["darwin-aarch64", "https://x/y", "line1\nline2"]], null, null), null);
});
