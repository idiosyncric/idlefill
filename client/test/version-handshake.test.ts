/**
 * version-handshake.test.ts — the daemon's version story:
 *
 *   - resolveVersion: the ROOT package.json is the version source
 *     (the release tag v<X.Y.Z> is cut from it; client/package.json's own
 *     version is NOT — it must not shadow the root), anchored on the entry
 *     dir the same way config.ts resolves {repo}: both the dev layout
 *     (client/src) and the dist layout (client/dist) must resolve the root
 *     package; a missing/unreadable file yields DEV_VERSION (never throws).
 *   - WIRE_PROTOCOL: the named constant the handshake sends.
 *   - the register body (the real ClientDaemon against the fake arbiter)
 *     carries version + protocol as TOP-LEVEL fields.
 *
 * No long daemon run is needed for the register assertion: the fake
 * arbiter records every register body and the daemon's start() registers
 * immediately.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { resolveVersion, DEV_VERSION } from '../src/version.js';
import { WIRE_PROTOCOL, ClientDaemon } from '../src/index.js';
import type { ClientConfig } from '../src/config.js';
import { startFakeArbiter } from './fake-arbiter.js';

const here = dirname(fileURLToPath(import.meta.url));
// client/ is the package dir; the repo root is one level up (the test file
// lives in client/test, mirroring how src/ and dist/ both sit in client/).
const clientPkg = join(here, '..');
const repoRoot = join(clientPkg, '..');

function readRootVersion(): string {
  return JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf-8')).version as string;
}

// ---------------------------------------------------------------------------
// Version resolution

test('resolveVersion: the dev layout (client/src) reads the ROOT package.json', () => {
  // Anchor at the module dir the same way index.ts does in dev.
  const v = resolveVersion(join(clientPkg, 'src'));
  assert.equal(v, readRootVersion(), 'the dev layout resolves the root package');
  assert.notEqual(v, '0.0.0-dev');
});

test('resolveVersion: the dist layout (client/dist) reads the ROOT package.json', () => {
  const v = resolveVersion(join(clientPkg, 'dist'));
  assert.equal(v, readRootVersion(), 'the dist layout resolves the root package exactly like dev');
  assert.notEqual(v, '0.0.0-dev');
});

test('resolveVersion: a client-package.json does NOT shadow the root when a root exists', () => {
  // The property, not the current values: when BOTH a root and a client
  // package.json exist, the ROOT wins (the release tag is cut from it;
  // client/package.json's version is not the source). Model the real layout
  // — the module dir sits one level below the client package dir
  // (client/src or client/dist): root = moduleDir/../.., client = moduleDir/..
  const empty = mkdtempSync(join(tmpdir(), 'idlefill-version-shadow-'));
  try {
    const moduleDir = join(empty, 'root', 'client', 'src');
    mkdirSync(moduleDir, { recursive: true });
    const scratchRootVersion = '9.8.7-scratch';
    writeFileSync(join(empty, 'root', 'package.json'), JSON.stringify({ name: 'root', version: scratchRootVersion }));
    // Client package with its OWN, different version (the CLOSER file).
    writeFileSync(join(empty, 'root', 'client', 'package.json'), JSON.stringify({ name: 'client', version: '1.2.3-client' }));
    // Anchored at the module dir → the root version, not the client's.
    assert.equal(resolveVersion(moduleDir), scratchRootVersion, 'root package wins over the closer client package');
    // The client's own version is never returned while a root exists.
    assert.notEqual(resolveVersion(moduleDir), '1.2.3-client');
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test('resolveVersion: the client package version is ONLY a fallback (no root package.json)', () => {
  // A module dir whose ../ has the client package.json and whose ../.. has
  // NO package.json at all (partial checkout) resolves the client version.
  const empty = mkdtempSync(join(tmpdir(), 'idlefill-version-fallback-'));
  try {
    const moduleDir = join(empty, 'client', 'src');
    mkdirSync(moduleDir, { recursive: true });
    writeFileSync(join(empty, 'client', 'package.json'), JSON.stringify({ name: 'client', version: '4.5.6-client' }));
    // Anchor at the module dir: the root candidate (../..) does not exist →
    // the client candidate (..) is the fallback.
    assert.equal(resolveVersion(moduleDir), '4.5.6-client', 'no root package → the client package version is the fallback');
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test('resolveVersion: missing or unusable files → DEV_VERSION (never throws)', () => {
  const empty = mkdtempSync(join(tmpdir(), 'idlefill-version-'));
  try {
    assert.equal(resolveVersion(empty), DEV_VERSION, 'no package.json near the anchor');
    // Present but unreadable JSON → next candidate → DEV_VERSION.
    writeFileSync(join(empty, 'package.json'), '{ not json');
    assert.equal(resolveVersion(empty), DEV_VERSION);
    // A package.json with no usable version field → DEV_VERSION.
    writeFileSync(join(empty, 'package.json'), JSON.stringify({ name: 'x' }));
    assert.equal(resolveVersion(empty), DEV_VERSION);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The handshake fields on the wire

test('WIRE_PROTOCOL is a named integer constant (1 — no protocol history yet)', () => {
  assert.equal(WIRE_PROTOCOL, 1);
  assert.ok(Number.isInteger(WIRE_PROTOCOL));
});

// The --version affordance (dev path — the built path is verified against
// dist/ by the release gates; both print the SAME string).
function runTsVersion(cwd: string, args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolveP) => {
    const tsxBin = join(clientPkg, '..', 'node_modules', '.bin', 'tsx');
    const p = spawn(tsxBin, args, { cwd, env: { ...process.env } });
    let out = '';
    p.stdout?.on('data', (d) => (out += String(d)));
    p.stderr?.on('data', (d) => (out += String(d)));
    p.on('close', (code) => resolveP({ code: code ?? -1, out }));
  });
}

test('--version (dev path): tsx src/index.ts --version prints the root version and exits 0', async () => {
  if (!existsSync(join(clientPkg, '..', 'node_modules', '.bin', 'tsx'))) {
    throw new Error('tsx missing — npm install in the repo first');
  }
  const { code, out } = await runTsVersion(clientPkg, ['src/index.ts', '--version']);
  assert.equal(code, 0, `--version exits 0 (output: ${out.trim()})`);
  assert.equal(out.trim(), readRootVersion(), 'it prints the root package.json version, nothing else');
});

test('the daemon registers with top-level version + protocol fields', async () => {
  const arb = await startFakeArbiter();
  const dir = mkdtempSync(join(tmpdir(), 'idlefill-version-d-'));
  const cfg: ClientConfig = {
    server_url: arb.url,
    token: 't',
    client_name: 'version-test-client',
    ip: '',
    proxy_port: 0,
    llm_target: 'http://127.0.0.1:1',
    repo_root: dir,
    state_dir: join(dir, 'state'),
    state_file: join(dir, 'state.json'),
    projects: [],
  };
  try {
    const d = new ClientDaemon(cfg, {
      pollMs: 50, // repo test pattern (lease-loop, sigint): after stop() the
      // loop's pending sleep resolves in 50ms and exits — a long pollMs
      // would park an uncleared timer on the event loop and the worker
      // would never drain. The heartbeat re-register is idempotent (fake
      // arbiter), so a fast tick is harmless. start() registers immediately.
      log: { info: () => {} },
    });
    await d.start();
    const body = arb.lastRegister as Record<string, unknown>;
    assert.equal(body.name, 'version-test-client');
    assert.ok(
      typeof body.version === 'string' && (body.version as string).length > 0,
      `the register body carries a version string (got ${JSON.stringify(body.version)})`,
    );
    assert.equal(body.version, readRootVersion(), 'version = the root package.json version');
    assert.equal(body.protocol, WIRE_PROTOCOL, 'the register body carries the protocol constant');
    await d.stop();
  } finally {
    await arb.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
