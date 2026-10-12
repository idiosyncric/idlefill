/**
 * Pure-helper tests for `idlefill agent` (cli.md D7, issue #92 S5): the
 * argv table, the roster rendering with the dashboard's honesty axis
 * (no roster key = a NAMED ABSENCE, fetched-empty = a true 0 naming the
 * zero-config posture), the aggregate-endpoint/port rules (ported from
 * client/src/agent-roster.ts — the authority), the connect plan (line
 * surgery: unrelated keys, comments and quoting ride through
 * byte-for-byte), the credential guards (userinfo URL = refusal that
 * never echoes the URL; unparseable config = named refusal, never a
 * write), and the connect→disconnect round trip on a real fixture
 * profile (timestamped backup BEFORE the write, prior config restored).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  aggregateEndpointUrl,
  normalizeProfileName,
  parseAgentArgs,
  planConnect,
  planDisconnect,
  profileBackupNames,
  renderRosterRows,
  resolveAggregatePort,
  rosterAbsentText,
  rosterEmptyText,
  targetsAggregatePort,
  writeProfileWithBackup,
} from '../src/agent.js';

// ---------------------------------------------------------------------------
// argv
// ---------------------------------------------------------------------------

const ok = (argv: string[]) => {
  const p = parseAgentArgs(argv);
  assert.ok(p.ok, p.ok ? '' : p.error);
  return p as Extract<typeof p, { ok: true }>;
};

test('bare group token means list; connect/disconnect carry exactly one profile', () => {
  assert.equal(ok([]).cmd, 'list');
  assert.equal(ok(['list']).cmd, 'list');
  const c = ok(['connect', 'web-dev']);
  assert.deepEqual(c.positional, ['web-dev']);
  const d = ok(['disconnect', 'probe-agent']);
  assert.deepEqual(d.positional, ['probe-agent']);
});

test('every usage mistake is named with the usage line', () => {
  assert.ok(!parseAgentArgs(['frobnicate']).ok);
  assert.ok(!parseAgentArgs(['list', 'extra']).ok);
  assert.ok(!parseAgentArgs(['connect']).ok);
  assert.ok(!parseAgentArgs(['connect', 'a', 'b']).ok);
  assert.ok(!parseAgentArgs(['disconnect', 'a', '--force']).ok);
});

test('profile names are ONE directory name — traversal and hidden entries refused', () => {
  assert.deepEqual(normalizeProfileName('web-dev'), { ok: true, name: 'web-dev' });
  assert.ok(!normalizeProfileName('../outside').ok);
  assert.ok(!normalizeProfileName('a/b').ok);
  assert.ok(!normalizeProfileName('a\\b').ok);
  assert.ok(!normalizeProfileName('.').ok);
  assert.ok(!normalizeProfileName('..').ok);
  assert.ok(!normalizeProfileName('.hidden').ok, 'the roster never publishes hidden entries');
  assert.ok(!normalizeProfileName('  ').ok);
  assert.ok(!normalizeProfileName('x ').ok);
});

// ---------------------------------------------------------------------------
// The aggregate endpoint — the value the roster classifies on
// ---------------------------------------------------------------------------

test('the aggregate endpoint url is the roster loopback shape; junk ports refused', () => {
  assert.equal(aggregateEndpointUrl(8800), 'http://127.0.0.1:8800/v1');
  assert.equal(aggregateEndpointUrl(0), null);
  assert.equal(aggregateEndpointUrl(65536), null);
  assert.equal(aggregateEndpointUrl(88.5), null);
});

test('targetsAggregatePort: loopback hosts only, exact port (ported rule)', () => {
  assert.ok(targetsAggregatePort('http://127.0.0.1:8800/v1', 8800));
  assert.ok(targetsAggregatePort('http://localhost:8800/v1', 8800));
  assert.ok(targetsAggregatePort('http://127.0.0.5:8800/v1', 8800));
  assert.ok(targetsAggregatePort('http://[::1]:8800/v1', 8800));
  assert.ok(!targetsAggregatePort('http://127.0.0.1:8801/v1', 8800), 'a different loopback port is external');
  assert.ok(!targetsAggregatePort('http://10.10.10.6:8800/v1', 8800), 'another machine is external');
  assert.ok(!targetsAggregatePort('http://strata.example.com/v1', 8800));
  assert.ok(!targetsAggregatePort('not a url', 8800));
});

// ---------------------------------------------------------------------------
// Roster rendering — the honesty axis (agent-stats.ts posture, terminal voice)
// ---------------------------------------------------------------------------

test('roster rows render in plain posture voice', () => {
  const out = renderRosterRows(
    [
      { profile: 'web-dev', posture: 'adopted', provider: 'idlefill', base_url: 'http://127.0.0.1:8800/v1' },
      { profile: 'strata-user', posture: 'external', provider: 'custom:strata', base_url: 'https://strata.example.com/v1' },
      { profile: 'probe-agent', posture: 'unset' },
    ],
    'm1max',
  );
  assert.match(out[0], /1 of 3 profiles adopted on this machine \(reported by the daemon "m1max"\)/);
  assert.ok(out.some((l) => l.includes('web-dev') && l.includes('routes through idlefill') && l.includes('http://127.0.0.1:8800/v1')));
  assert.ok(out.some((l) => l.includes('strata-user') && l.includes('routes elsewhere') && l.includes('https://strata.example.com/v1')));
  assert.ok(out.some((l) => l.includes('probe-agent') && l.includes('no config')));
});

test('no roster key is a NAMED ABSENCE — never a fake zero', () => {
  const t = rosterAbsentText();
  assert.match(t, /no Hermes roster reported/);
  assert.match(t, /named absence, not a zero/);
});

test('a fetched-empty roster is a true 0 naming the zero-config posture', () => {
  const t = rosterEmptyText();
  assert.match(t, /roster WAS fetched and came back empty: a true zero/);
  assert.match(t, /zero-config posture/);
});

// ---------------------------------------------------------------------------
// resolveAggregatePort — runtime config read, never argv
// ---------------------------------------------------------------------------

test('aggregate_port comes from the client config; 0 and junk are named refusals', () => {
  assert.equal(resolveAggregatePort({ IDLEFILL_CLIENT_CONFIG: '{"aggregate_port": 8801}' }), 8801);
  assert.equal(resolveAggregatePort({ IDLEFILL_CLIENT_CONFIG: '{}' }), 8800, 'absent = the 8800 fleet default');
  assert.throws(() => resolveAggregatePort({ IDLEFILL_CLIENT_CONFIG: '{"aggregate_port": 0}' }), /NO aggregate endpoint/);
  assert.throws(() => resolveAggregatePort({ IDLEFILL_CLIENT_CONFIG: '{"aggregate_port": "fast"}' }), /not a number/);
  assert.throws(() => resolveAggregatePort({ IDLEFILL_CLIENT_CONFIG: 'not json' }), /not valid JSON/);
});

// ---------------------------------------------------------------------------
// connect plan — line surgery + the credential guards
// ---------------------------------------------------------------------------

const ORIGINAL = [
  '# profile config — this comment rides through',
  'model:',
  '  default: "Some Model"',
  '  provider: custom:strata   # inline comment stays',
  'workspace: ~/projects/thing',
  'providers:',
  '  strata:',
  '    api: https://strata.example.com/v1',
  '    key_env: STRATA_KEY   # never read, never followed',
  'theme: dark',
  '',
].join('\n');

test('connect inserts the model base_url and carries every other byte through', () => {
  const p = planConnect(ORIGINAL, 8800);
  assert.equal(p.action, 'write');
  assert.ok(p.action === 'write');
  const expected = [
    '# profile config — this comment rides through',
    'model:',
    '  base_url: http://127.0.0.1:8800/v1',
    '  default: "Some Model"',
    '  provider: custom:strata   # inline comment stays',
    'workspace: ~/projects/thing',
    'providers:',
    '  strata:',
    '    api: https://strata.example.com/v1',
    '    key_env: STRATA_KEY   # never read, never followed',
    'theme: dark',
    '',
  ].join('\n');
  assert.equal(p.newText, expected);
  assert.equal(p.prior, 'https://strata.example.com/v1');
});

test('connect replaces an existing model.base_url in place (indent kept, neighbours untouched)', () => {
  const text = ['model:', '  provider: llama-swap', '  base_url: http://elsewhere:1234/v1', 'keep: me'].join('\n');
  const p = planConnect(text, 8800);
  assert.ok(p.action === 'write');
  assert.equal(
    p.newText,
    ['model:', '  provider: llama-swap', '  base_url: http://127.0.0.1:8800/v1', 'keep: me'].join('\n'),
  );
  assert.equal(p.prior, 'http://elsewhere:1234/v1');
});

test('connect on a missing config (empty text) writes only the minimal model block', () => {
  const p = planConnect('', 8800);
  assert.ok(p.action === 'write');
  assert.equal(p.newText, 'model:\n  base_url: http://127.0.0.1:8800/v1\n');
  assert.equal(p.prior, null);
});

test('an already-adopted profile is `unchanged` — no write, no backup (provider-block endpoint counts)', () => {
  const text = [
    'model:',
    '  provider: idlefill',
    'providers:',
    '  idlefill:',
    '    base_url: http://127.0.0.1:8800/v1',
    '    key_env: IDLEFILL_API_KEY',
  ].join('\n');
  const p = planConnect(text, 8800);
  assert.ok(p.action === 'unchanged');
});

test('endpoint URLs at any depth are the posture set — a model block stays REQUIRED (roster rule)', () => {
  // providers.*.base_url targets the port but there is NO model block:
  // the roster would still classify this `unset`, so connect writes the block.
  const text = ['providers:', '  idlefill:', '    base_url: http://127.0.0.1:8800/v1'].join('\n');
  const p = planConnect(text, 8800);
  assert.ok(p.action === 'write');
  assert.ok(p.newText.includes('model:\n  base_url: http://127.0.0.1:8800/v1'));
});

test('a userinfo-bearing URL is REFUSED and never echoed back', () => {
  const text = ['model:', '  base_url: http://user:s3cr3t@127.0.0.1:8800/v1'].join('\n');
  const p = planConnect(text, 8800);
  assert.ok(p.action === 'refuse');
  assert.ok(p.action === 'refuse');
  assert.match(p.reason, /userinfo/);
  assert.match(p.reason, /refused, not rewritten and not redacted/);
  assert.ok(!p.reason.includes('s3cr3t'), 'the credential never appears in the refusal');
  assert.ok(!p.reason.includes('user:s3cr3t@127.0.0.1'), 'not even the host part of the URL');
});

test('unparseable config = a named refusal, never a write', () => {
  const cases: Array<[string, RegExp]> = [
    ['model:\n\u0000 junk', /binary bytes/],
    ['model:\n\tprovider: tabs', /tab-indented/],
    ['model:\n  a: 1\nmodel:\n  b: 2', /more than one top-level model/],
    ['model: some-inline-scalar', /inline scalar/],
    ['model:\n  base_url: \x07', /control characters/],
  ];
  for (const [text, re] of cases) {
    const p = planConnect(text, 8800);
    assert.ok(p.action === 'refuse', JSON.stringify(text));
    assert.ok(p.action === 'refuse');
    assert.match(p.reason, re);
  }
});

test('the connect refusal text says nothing was written (zero mutation)', () => {
  const p = planConnect('model:\n\u0000', 8800);
  assert.ok(p.action === 'refuse');
  assert.match(p.reason, /nothing was written/);
});

// ---------------------------------------------------------------------------
// disconnect plan — restore the PRIOR config, never invent one
// ---------------------------------------------------------------------------

const CONNECTED = planConnect(ORIGINAL, 8800).action === 'write' ? (planConnect(ORIGINAL, 8800) as { newText: string }).newText : '';

test('disconnect restores the newest backup that PRE-DATES the connect', () => {
  const p = planDisconnect(CONNECTED, [{ name: 'config.yaml.bak-20261012T120000Z', text: ORIGINAL }], 8800);
  assert.ok(p.action === 'restore');
  assert.equal(p.restoreText, ORIGINAL);
  assert.equal(p.backupName, 'config.yaml.bak-20261012T120000Z');
});

test('the backup scan is newest-first and skips backups that are NOT a prior config', () => {
  const backups = [
    { name: 'config.yaml.bak-20261012T140000Z', text: CONNECTED }, // already routes here — not "prior"
    { name: 'config.yaml.bak-20261012T130000Z', text: 'model:\n\u0000 corrupt' }, // unparseable — skipped
    { name: 'config.yaml.bak-20261012T120000Z', text: ORIGINAL }, // the real prior config
  ];
  const p = planDisconnect(CONNECTED, backups, 8800);
  assert.ok(p.action === 'restore');
  assert.equal(p.backupName, 'config.yaml.bak-20261012T120000Z');
  assert.equal(p.restoreText, ORIGINAL);
});

test('a profile that does not route here is named `not-adopted` — nothing to restore, nothing written', () => {
  const p = planDisconnect(ORIGINAL, [{ name: 'config.yaml.bak-20261012T120000Z', text: ORIGINAL }], 8800);
  assert.ok(p.action === 'not-adopted');
});

test('with no backup carrying a prior config, disconnect REFUSES rather than invent an endpoint', () => {
  const none = planDisconnect(CONNECTED, [], 8800);
  assert.ok(none.action === 'no-usable-backup');
  assert.match(none.endpoint, /127\.0\.0\.1:8800/);
  const allBad = planDisconnect(CONNECTED, [{ name: 'config.yaml.bak-20261012T120000Z', text: CONNECTED }], 8800);
  assert.ok(allBad.action === 'no-usable-backup');
  assert.equal(allBad.scanned, 1);
});

test('profileBackupNames sees only this command\'s timestamped backups', () => {
  assert.deepEqual(
    profileBackupNames([
      'config.yaml',
      'config.yaml.bak-20261012T153000Z',
      'config.yaml.bak-junk',
      'config.yaml.bak-20261012T153000',
      'other.yaml.bak-20261012T153000Z',
      'backups',
    ]),
    ['config.yaml.bak-20261012T153000Z'],
  );
});

// ---------------------------------------------------------------------------
// Real-fs round trip on a fixture profile — backup BEFORE the write,
// unrelated keys preserved, the prior config restored.
// ---------------------------------------------------------------------------

test('connect → disconnect round trip restores the ORIGINAL bytes and keeps every backup', () => {
  const dir = mkdtempSync(join(tmpdir(), 'idlefill-agent-cli-'));
  try {
    const profileDir = join(dir, 'fixture-profile');
    mkdirSync(profileDir);
    const file = join(profileDir, 'config.yaml');
    writeFileSync(file, ORIGINAL);

    // connect: plan + backup-then-write.
    const cp = planConnect(ORIGINAL, 8800);
    assert.ok(cp.action === 'write');
    const now = new Date('2026-10-12T15:30:00.123Z');
    const backup1 = writeProfileWithBackup(file, cp.newText, now);
    assert.equal(backup1, join(profileDir, 'config.yaml.bak-20261012T153000Z'));
    assert.equal(readFileSync(backup1, 'utf-8'), ORIGINAL, 'the backup carries the OLD bytes');
    assert.equal(readFileSync(file, 'utf-8'), cp.newText);

    // The written config re-classifies adopted under the roster rule.
    assert.ok(planConnect(readFileSync(file, 'utf-8'), 8800).action === 'unchanged');

    // disconnect: newest-first scan of the real backup names, restore the prior config.
    const names = profileBackupNames(readdirSync(profileDir));
    const backups = names.map((name) => ({ name, text: readFileSync(join(profileDir, name), 'utf-8') }));
    const dp = planDisconnect(readFileSync(file, 'utf-8'), backups, 8800);
    assert.ok(dp.action === 'restore');
    const backup2 = writeProfileWithBackup(file, dp.restoreText, new Date('2026-10-12T16:00:00Z'));
    assert.equal(readFileSync(file, 'utf-8'), ORIGINAL, 'the round trip lands on the ORIGINAL bytes');
    assert.equal(readFileSync(backup2 as string, 'utf-8'), cp.newText, 'the connected bytes are kept as the newest backup');
    assert.deepEqual(profileBackupNames(readdirSync(profileDir)), [
      'config.yaml.bak-20261012T153000Z',
      'config.yaml.bak-20261012T160000Z',
    ]);
    // Unrelated keys: the original comment and the key_env reference never moved.
    assert.ok(readFileSync(file, 'utf-8').includes('profile config — this comment rides through'));
    assert.ok(readFileSync(file, 'utf-8').includes('key_env: STRATA_KEY'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('connecting a profile without a config.yaml creates it — no backup of a file that never existed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'idlefill-agent-cli-'));
  try {
    const file = join(dir, 'config.yaml');
    const p = planConnect('', 8800);
    assert.ok(p.action === 'write');
    const backup = writeProfileWithBackup(file, p.newText, new Date('2026-10-12T15:30:00Z'));
    assert.equal(backup, null);
    assert.equal(readFileSync(file, 'utf-8'), 'model:\n  base_url: http://127.0.0.1:8800/v1\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
