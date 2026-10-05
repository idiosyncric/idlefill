/**
 * revision.test.ts — issue #49: the daemon's boot revision (code-staleness).
 *
 *   - resolveRevision reads `git rev-parse HEAD` at the repo root resolved
 *     from the module dir (the same {repo} anchoring as version.ts): the
 *     real repo yields the real HEAD in BOTH the dev layout (client/src)
 *     and the dist layout (client/dist).
 *   - best-effort by contract: no git, a non-repo dir, or a failing git
 *     yields undefined — never a throw, never a crash path at startup.
 *   - the register body (the real ClientDaemon against the fake arbiter)
 *     carries `revision` as a TOP-LEVEL field alongside version/protocol,
 *     and it equals the repo HEAD at test time.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { resolveRevision } from '../src/revision.js';
import { ClientDaemon } from '../src/index.js';
import type { ClientConfig } from '../src/config.js';
import { startFakeArbiter } from './fake-arbiter.js';

const here = dirname(fileURLToPath(import.meta.url));
// client/ is the package dir; the repo root is one level up (the test file
// lives in client/test, mirroring how src/ and dist/ both sit in client/).
const clientPkg = join(here, '..');
const repoRoot = join(clientPkg, '..');

function gitHead(): string {
  return execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim();
}

// ---------------------------------------------------------------------------
// Resolution

test('resolveRevision: the dev layout (client/src) reads the repo HEAD', () => {
  const r = resolveRevision(join(clientPkg, 'src'));
  assert.equal(r, gitHead(), 'the dev layout resolves the repo-root HEAD');
});

test('resolveRevision: the dist layout (client/dist) resolves the same root as dev', () => {
  const viaSrc = resolveRevision(join(clientPkg, 'src'));
  const viaDist = resolveRevision(join(clientPkg, 'dist'));
  assert.equal(viaDist, viaSrc, 'both layouts anchor the same repo root');
});

test('resolveRevision: no git checkout → undefined (never throws)', () => {
  const empty = mkdtempSync(join(tmpdir(), 'idlefill-rev-nogit-'));
  try {
    // A scratch dir tree with no .git anywhere near the candidates.
    assert.equal(resolveRevision(join(empty, 'client', 'src')), undefined);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test('resolveRevision: a failing git (missing binary) → undefined', () => {
  assert.equal(resolveRevision(join(clientPkg, 'src'), 'definitely-not-a-git-xyz'), undefined);
});

// ---------------------------------------------------------------------------
// The handshake field on the wire

test('the daemon registers with a top-level revision = the repo HEAD at start', async () => {
  const head = gitHead();
  const arb = await startFakeArbiter();
  const dir = mkdtempSync(join(tmpdir(), 'idlefill-rev-d-'));
  const cfg: ClientConfig = {
    server_url: arb.url,
    token: 't',
    client_name: 'revision-test-client',
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
      // 50ms pollMs per the version-handshake precedent (the pending sleep
      // must drain so the worker exits; the re-register is idempotent).
      pollMs: 50,
      log: { info: () => {} },
    });
    await d.start();
    const body = arb.lastRegister as Record<string, unknown>;
    assert.equal(body.name, 'revision-test-client');
    assert.equal(
      body.revision,
      head,
      'the register body carries the FULL boot SHA the code loaded from',
    );
    assert.match(String(body.revision), /^[0-9a-f]{40}$/, 'a full 40-char SHA (within the ≤64 sanitize rule)');
    await d.stop();
  } finally {
    await arb.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
