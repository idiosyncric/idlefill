/**
 * nav.test.ts — the nav model is a CONTRACT against the retired legacy
 * dashboard (server/public/index.html). The cutover (2026-10-08) made the
 * React workspace the served dashboard; the legacy page stays on disk as
 * the reference for the surfaces it carried. If a view id or a Resources
 * sub-view that the legacy page had disappears from src/nav.ts, this test
 * fails: dropping a surface becomes a conscious act, not a silent loss.
 *
 * Run: npm test (dashboard workspace) — tsx --test.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NAV_IDS, RES_SUBTABS } from '../src/nav.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const legacy = readFileSync(join(__dirname, '..', '..', 'server', 'public', 'index.html'), 'utf-8');

function attrSet(html: string, attr: string): Set<string> {
  const out = new Set<string>();
  const re = new RegExp(`${attr}="([^"]+)"`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) out.add(m[1]!);
  return out;
}

test('every legacy view survives as a React nav id', () => {
  const legacyViews = attrSet(legacy, 'data-view');
  assert.ok(legacyViews.size >= 4, `legacy page carries its view set (got ${legacyViews.size})`);
  for (const v of legacyViews) {
    assert.ok((NAV_IDS as readonly string[]).includes(v), `legacy view "${v}" is missing from NAV_IDS`);
  }
});

test('every legacy Resources sub-view survives in RES_SUBTABS', () => {
  const legacySubs = attrSet(legacy, 'data-subview');
  assert.ok(legacySubs.size >= 4, `legacy page carries its sub-view set (got ${legacySubs.size})`);
  for (const s of legacySubs) {
    assert.ok(RES_SUBTABS.some((t) => t.id === s), `legacy sub-view "${s}" is missing from RES_SUBTABS`);
  }
});
