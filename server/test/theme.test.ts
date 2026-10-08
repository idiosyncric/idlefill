/**
 * theme.test.ts — the operator-tuned dashboard color scheme (#68).
 *
 * Covers:
 *   - the sanitizer: drop-don't-reject (an unknown key drops, a malformed
 *     value drops that key and keeps the prior value, an all-bad payload
 *     keeps the prior map — it never clears to empty)
 *   - the persistence round-trip (setTheme → a fresh StateStore loads the
 *     same map; the state file is the only persistence)
 *   - the ADD-key shape on GET /api/state (absent when unset, present with
 *     the nine-token shape once set) against a real Fastify app
 *
 * Run: npm test (server workspace) — tsx --test.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApi } from '../src/api.js';
import { Arbiter } from '../src/arbiter.js';
import { StateStore } from '../src/state.js';
import { IdleDetector } from '../src/idle.js';
import { THEME_DEFAULTS, THEME_TOKEN_KEYS } from '../src/types.js';
import type { ServerConfig } from '../src/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOKEN = 'theme-token-123';
const auth = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' } as const;

function makeHarness(dir: string): { arbiter: Arbiter; cfg: ServerConfig } {
  const cfg: ServerConfig = {
    listen: 0,
    api_tokens: [TOKEN],
    llama_swap_url: 'http://fake',
    activity_path: '/api/metrics/activity',
    log_glob: '',
    idle_seconds: 300,
    poll_ms: 60_000,
    lease_ttl_seconds: 1800,
    lease_ttl_safety_factor: 2,
    lease_ttl_floor_seconds: 60,
    max_concurrent_leases: 1,
    job_fail_threshold: 5,
    job_cooldown_seconds: 300,
    projects: [{ name: 'career-ops', paused: false, daily_token_cap: 10_000 }],
    state_file: join(dir, 'state.json'),
  };
  const store = new StateStore(cfg.state_file);
  const det = new IdleDetector({
    fetchActivity: async () => [],
    logMtime: () => null,
    llama_swap_url: cfg.llama_swap_url,
    activity_path: cfg.activity_path,
    log_glob: '',
    idle_seconds: cfg.idle_seconds,
  });
  return { arbiter: new Arbiter(store, cfg, det), cfg };
}

test('setTheme sanitizes: drop-don-not-reject and seeds the full nine-token shape', () => {
  const dir = mkdtempSync(join(tmpdir(), 'idlefill-theme-'));
  const { arbiter } = makeHarness(dir);
  // A fresh write seeds from the :root defaults, then applies the good keys.
  const res = arbiter.setTheme({
    ok: '#ff0000',
    'not-a-token': '#123456', // unknown key → dropped
    warn: 'red; } body{}', // malformed value → dropped, keeps prior (default)
  });
  assert.equal(res.applied, 1, 'only the conforming ok value applies');
  assert.deepEqual(res.dropped, ['not-a-token'], 'the unknown key is reported as dropped');
  // The effective map carries the applied value + every other token at its default.
  assert.equal(res.theme.colors.ok, '#ff0000');
  assert.equal(res.theme.colors.warn, THEME_DEFAULTS.warn, 'the malformed value keeps the prior (default) value');
  assert.equal('not-a-token' in res.theme.colors, false, 'the unknown key never enters the map');
  // The map is the full nine-token shape.
  for (const k of THEME_TOKEN_KEYS) assert.ok(k in res.theme.colors, `token ${k} present`);
  assert.ok(res.theme.updated_at.length > 0, 'updated_at is an ISO string');
  rmSync(dir, { recursive: true, force: true });
});

test('setTheme keeps the prior map on an all-bad payload (never clears to empty)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'idlefill-theme-'));
  const { arbiter } = makeHarness(dir);
  arbiter.setTheme({ ok: '#ff0000', bg: '#101010' });
  const before = { ...arbiter.theme()!.colors };
  // A payload with only bad values: every key drops, the prior map stands.
  const res = arbiter.setTheme({ ok: 'not-a-color', dim: undefined, err: null, bogus: '#111111' });
  assert.equal(res.applied, 0, 'nothing conforms');
  const after = arbiter.theme()!.colors;
  assert.deepEqual(after, before, 'the prior map is preserved verbatim (never cleared to empty)');
  assert.equal('bogus' in after, false, 'the unknown key never enters the map');
  rmSync(dir, { recursive: true, force: true });
});

test('setTheme persists the map to the state file (round-trip)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'idlefill-theme-'));
  const stateFile = join(dir, 'state.json');
  const { arbiter } = makeHarness(dir);
  arbiter.setTheme({ ok: '#ff0000', accent: '#11aaff' });
  // A FRESH store over the same file re-hydrates the identical map.
  const reloaded = new StateStore(stateFile);
  assert.ok(reloaded.state.theme, 'the theme key is persisted');
  assert.deepEqual(reloaded.state.theme!.colors, arbiter.theme()!.colors, 'the reloaded map matches the written map');
  assert.equal(reloaded.state.theme!.colors.ok, '#ff0000');
  assert.equal(reloaded.state.theme!.colors.accent, '#11aaff');
  rmSync(dir, { recursive: true, force: true });
});

test('GET /api/state: the theme ADD key is absent when unset, present once set', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'idlefill-theme-api-'));
  const { arbiter, cfg } = makeHarness(dir);
  const app = buildApi({ arbiter, cfg, publicDir: join(__dirname, 'fixtures', 'dashboard') });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  try {
    // Unset: anonymous /api/state carries no theme key.
    const unset = await (await fetch(`${base}/api/state`)).json() as { theme?: unknown };
    assert.equal('theme' in unset, false, 'the ADD key is absent when the theme is unset');
    // Set it (token-gated like every settings write).
    const put = await fetch(`${base}/api/theme`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ colors: { ok: '#ff0000' } }),
    });
    assert.equal(put.status, 200, 'the theme write 200s');
    const putBody = (await put.json()) as { ok: boolean; colors: Record<string, string>; updated_at: string };
    assert.equal(putBody.ok, true);
    assert.equal(putBody.colors.ok, '#ff0000', 'the effective map carries the applied value');
    assert.equal(putBody.colors.warn, THEME_DEFAULTS.warn, 'the other keys keep their defaults');
    // Anonymous /api/state now carries the theme ADD key.
    const now = await (await fetch(`${base}/api/state`)).json() as { theme?: { colors: Record<string, string> } };
    assert.ok(now.theme, 'the ADD key is present once set');
    assert.equal(now.theme!.colors.ok, '#ff0000');
    assert.equal(Object.keys(now.theme!.colors).length, THEME_TOKEN_KEYS.length, 'the full nine-token shape');
    // A malformed value 200s and keeps the prior value (no 400, no break).
    const bad = await fetch(`${base}/api/theme`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ colors: { ok: 'red; } body{}' } }),
    });
    assert.equal(bad.status, 200, 'a malformed value does not 400 (it drops and keeps the prior value)');
    const badBody = (await bad.json()) as { colors: Record<string, string> };
    assert.equal(badBody.colors.ok, '#ff0000', 'ok keeps the prior value');
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
