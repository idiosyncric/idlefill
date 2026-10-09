/**
 * agent-roster.test.ts — issue #80: the daemon's LOCAL Hermes profile
 * classifier (client/src/agent-roster.ts).
 *
 * Fixture-tree tests (the issue's acceptance list):
 *   - adopted     : a profile whose config names the daemon's OWN aggregate
 *     port (loopback host + that exact port) as an endpoint URL.
 *   - external    : a model block present but routing elsewhere (a foreign
 *     URL / a different loopback port).
 *   - unset       : no config.yaml at all, or a config with no model block.
 *   - the whole key absent when the profiles directory is missing (the
 *     register body then omits agent_roster).
 *   - a credential-looking userinfo is OMITTED from the published base_url.
 *   - never throws: a stray non-directory entry, an unreadable/empty config,
 *     a hidden entry — all handled without a heartbeat break.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanHermesProfilesAt, targetsAggregatePort } from '../src/agent-roster.js';

const HERE = 8800; // the daemon's own bound aggregate port

/** Build a fixture profiles tree and return its root. */
function makeProfiles(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'idlefill-roster-'));
  for (const [profile, yaml] of Object.entries(files)) {
    const dir = join(root, profile);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'config.yaml'), yaml);
  }
  return root;
}

// A realistic adopted config: the idlefill endpoint lives under
// providers.idlefill.base_url (model.provider names a different engine, no
// model.base_url) — exactly the shape of this Mac's web-dev profile.
const ADOPTED_YAML = [
  'model:',
  '  default: Qwen3.8-27B',
  '  provider: llama-swap',
  'providers:',
  '  llama-swap:',
  '    api: http://100.105.225.1:11434/v1',
  '  idlefill:',
  '    name: idlefill',
  `    base_url: http://127.0.0.1:${HERE}/v1`,
  '    key_env: IDLEFILL_API_KEY',
  'agent:',
  '  reasoning_effort: xhigh',
].join('\n');

// External: a custom provider points at a foreign (tailnet) engine.
const EXTERNAL_YAML = [
  'model:',
  '  default: Qwen3.8-Flash-Next',
  '  provider: custom',
  '  base_url: https://strata.samwarth.com/v1',
  'terminal:',
  '  enabled: true',
].join('\n');

// External (a DIFFERENT loopback port — another local engine, not idlefill):
const EXTERNAL_LOCAL_OTHER_PORT_YAML = [
  'model:',
  '  default: dgx/spark',
  '  provider: custom',
  '  base_url: http://127.0.0.1:11435/s/flash/v1',
].join('\n');

// unset: a config with a model block but NO model.base_url and NO endpoints
// naming the aggregate port. (A model block present → not "no config".)
const NO_ENDPOINT_YAML = [
  'model:',
  '  default: Qwen3.8-27B',
  '  provider: llama-swap',
].join('\n');

test('targetsAggregatePort: loopback host + exact port = true; else false', () => {
  assert.equal(targetsAggregatePort(`http://127.0.0.1:${HERE}/v1`, HERE), true);
  assert.equal(targetsAggregatePort('http://localhost:8800/v1', 8800), true);
  assert.equal(targetsAggregatePort('http://[::1]:8800/v1', 8800), true);
  // wrong port → false (a different local engine)
  assert.equal(targetsAggregatePort('http://127.0.0.1:11435/v1', HERE), false);
  // a non-loopback host on the right port → false (another machine)
  assert.equal(targetsAggregatePort('http://100.105.225.1:8800/v1', HERE), false);
  // malformed → false (fail closed)
  assert.equal(targetsAggregatePort('not-a-url', HERE), false);
  // a disabled (0) aggregate port can never classify adopted
  assert.equal(targetsAggregatePort(`http://127.0.0.1:0/v1`, 0), false);
});

test('fixture: adopted (own aggregate port under providers.idlefill.base_url)', () => {
  const root = makeProfiles({ web_dev: ADOPTED_YAML });
  try {
    const rows = scanHermesProfilesAt(root, HERE);
    assert.ok(Array.isArray(rows));
    assert.equal(rows!.length, 1);
    assert.equal(rows![0]!.profile, 'web_dev');
    assert.equal(rows![0]!.posture, 'adopted');
    assert.equal(rows![0]!.base_url, `http://127.0.0.1:${HERE}/v1`);
    assert.equal(rows![0]!.provider, 'llama-swap'); // the model block's provider
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fixture: external (a foreign URL) and (a different loopback port)', () => {
  const root = makeProfiles({ strata: EXTERNAL_YAML, other_port: EXTERNAL_LOCAL_OTHER_PORT_YAML });
  try {
    const rows = scanHermesProfilesAt(root, HERE);
    assert.ok(Array.isArray(rows));
    const s = rows!.find((r) => r.profile === 'strata')!;
    assert.equal(s.posture, 'external');
    assert.equal(s.base_url, 'https://strata.samwarth.com/v1');
    const o = rows!.find((r) => r.profile === 'other_port')!;
    assert.equal(o.posture, 'external', 'a different loopback port is NOT adopted');
    assert.equal(o.base_url, 'http://127.0.0.1:11435/s/flash/v1');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fixture: no config.yaml → unset (the profile is still listed)', () => {
  const root = mkdtempSync(join(tmpdir(), 'idlefill-roster-'));
  mkdirSync(join(root, 'probe-agent')); // a profile dir with NO config.yaml
  try {
    const rows = scanHermesProfilesAt(root, HERE);
    assert.ok(Array.isArray(rows));
    assert.equal(rows!.length, 1);
    assert.equal(rows![0]!.profile, 'probe-agent');
    assert.equal(rows![0]!.posture, 'unset');
    assert.equal(rows![0]!.base_url, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fixture: a config with no endpoint naming the aggregate port → external', () => {
  const root = makeProfiles({ bare: NO_ENDPOINT_YAML });
  try {
    const rows = scanHermesProfilesAt(root, HERE);
    assert.ok(Array.isArray(rows));
    // A model block is present but nothing routes through idlefill → external
    // (it is not "no config"; it has a model block that simply isn't adopted).
    assert.equal(rows![0]!.posture, 'external');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fixture: a credential-looking userinfo is OMITTED from the published base_url', () => {
  // An adopted endpoint that carries userinfo (user:pass@host) must publish
  // posture adopted but OMIT the base_url (the credential-looking part).
  const yaml = [
    'model:',
    '  provider: custom',
    'providers:',
    '  idlefill:',
    `    base_url: http://alice:secret@127.0.0.1:${HERE}/v1`,
  ].join('\n');
  const root = makeProfiles({ creds: yaml });
  try {
    const rows = scanHermesProfilesAt(root, HERE);
    assert.ok(Array.isArray(rows));
    assert.equal(rows![0]!.posture, 'adopted', 'the posture is still derived from the endpoint');
    assert.equal(rows![0]!.base_url, undefined, 'the userinfo URL is not published');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fixture: a missing profiles directory → undefined (the key is absent)', () => {
  const missing = join(mkdtempSync(join(tmpdir(), 'idlefill-roster-')), 'does-not-exist');
  assert.equal(scanHermesProfilesAt(missing, HERE), undefined);
});

test('fixture: a profiles dir that is a FILE (not a dir) → undefined', () => {
  const dir = mkdtempSync(join(tmpdir(), 'idlefill-roster-'));
  const f = join(dir, 'a-file');
  writeFileSync(f, 'not a dir');
  assert.equal(scanHermesProfilesAt(f, HERE), undefined, 'a non-directory root → absent');
  rmSync(dir, { recursive: true, force: true });
});

test('fixture: an empty profiles directory → undefined (no empty list published)', () => {
  const empty = mkdtempSync(join(tmpdir(), 'idlefill-roster-'));
  assert.equal(scanHermesProfilesAt(empty, HERE), undefined);
  rmSync(empty, { recursive: true, force: true });
});

test('fixture: a stray non-directory entry + a hidden entry are ignored, never a throw', () => {
  const root = mkdtempSync(join(tmpdir(), 'idlefill-roster-'));
  writeFileSync(join(root, 'stray-file'), 'x'); // a non-directory entry
  mkdirSync(join(root, '.hidden')); // a hidden entry — never published
  writeFileSync(join(root, '.hidden', 'config.yaml'), 'model:\n  provider: x\n');
  mkdirSync(join(root, 'real'));
  writeFileSync(join(root, 'real', 'config.yaml'), ADOPTED_YAML);
  try {
    const rows = scanHermesProfilesAt(root, HERE);
    assert.ok(Array.isArray(rows));
    assert.deepEqual(rows!.map((r) => r.profile), ['real'], 'only real profile dirs are listed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fixture: an unreadable / empty config is handled without a throw (unset or external)', () => {
  // An empty config.yaml: a model block is absent → the profile is listed but
  // has no model facts (unset posture for a config with no model block).
  const root = mkdtempSync(join(tmpdir(), 'idlefill-roster-'));
  mkdirSync(join(root, 'empty'));
  writeFileSync(join(root, 'empty', 'config.yaml'), '');
  try {
    const rows = scanHermesProfilesAt(root, HERE);
    assert.ok(Array.isArray(rows));
    assert.equal(rows![0]!.profile, 'empty');
    assert.equal(rows![0]!.posture, 'unset', 'an empty config has no model block');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
