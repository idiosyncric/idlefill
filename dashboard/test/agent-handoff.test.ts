/**
 * agent-handoff.test.ts — the mint hand-off's Hermes-shape contract
 * (owner ask 2026-10-21: check the block against the CURRENT Hermes config
 * reader). Pins what lib/agent-handoff.ts emits:
 *   - every providers.idlefill key sits in Hermes' _KNOWN_PROVIDER_KEYS
 *     (hermes_cli/config_providers.py) — an unknown key is silently IGNORED
 *     with a warning, so a drift here fails the agent at request time;
 *   - the endpoint key is `base_url` (first-priority among base_url/url/api)
 *     and the provider default is `model` (first-priority among
 *     model/default_model) — both spellings are accepted by the reader;
 *     this is the spelling the proven live blocks use;
 *   - the credential is a key_env reference only — never an inlined key;
 *   - the session-affinity header the block names is EXACTLY the header the
 *     aggregate router reads (client/src/session-gate.ts SESSION_ID_HEADER).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  KEY_ENV_VAR,
  SESSION_AFFINITY_HEADER,
  configBlock,
  defaultModelOf,
  envBlock,
} from '../src/lib/agent-handoff';

// Pasted from the reader's authority: Hermes v0.22.2
// hermes_cli/config_providers.py _KNOWN_PROVIDER_KEYS (+ the camelCase alias
// names it accepts, which we must never emit). Drift here means Hermes grew
// a key the mint block may want — read the source, then update both.
const HERMES_KNOWN_PROVIDER_KEYS = new Set([
  'provider',
  'name', 'api', 'url', 'base_url', 'api_key', 'key_env', 'api_key_env', 'key_cmd',
  'api_mode', 'transport', 'model', 'default_model', 'models', 'models_discovered',
  'context_length', 'rate_limit_delay', 'request_timeout_seconds', 'stale_timeout_seconds',
  'discover_models', 'extra_body', 'extra_headers', 'capabilities', 'ssl_ca_cert', 'ssl_verify',
  'catalog_provider', 'session_affinity_header',
]);

const URL = 'http://127.0.0.1:8800/v1';
const MODEL = 'Qwen3.8-Flash-Next';

/** The `providers.idlefill:` block's direct child keys (2-space then 4-space indent). */
function providerKeys(yaml: string): string[] {
  const lines = yaml.split('\n');
  const start = lines.indexOf('  idlefill:');
  assert.ok(start >= 0, 'the block declares providers.idlefill');
  const keys: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith('    ')) break; // left the provider block (or its nested maps)
    const m = line.match(/^ {4}([A-Za-z_][A-Za-z0-9_]*)\s*:/);
    if (m) keys.push(m[1] as string);
  }
  return keys;
}

test('configBlock emits only keys Hermes reads (the _KNOWN_PROVIDER_KEYS pin)', () => {
  for (const k of providerKeys(configBlock(URL, MODEL))) {
    assert.ok(HERMES_KNOWN_PROVIDER_KEYS.has(k), `providers.idlefill key "${k}" is unknown to Hermes — it would be silently ignored`);
  }
});

test('configBlock uses the reader-preferred spellings: base_url + model + key_env', () => {
  const b = configBlock(URL, MODEL);
  assert.match(b, /^ {4}base_url: http:\/\/127\.0\.0\.1:8800\/v1$/m); // first-priority URL key
  assert.doesNotMatch(b, /^ {4}api: /m); // the v12-writer spelling — NOT needed, base_url wins the lookup
  assert.match(b, /^ {4}model: Qwen3\.8-Flash-Next$/m); // first-priority default key
  assert.doesNotMatch(b, /^ {4}default_model: /m); // the accepted alias — we emit the canonical one
  assert.match(b, new RegExp(`^ {4}key_env: ${KEY_ENV_VAR}$`, 'm'));
  assert.doesNotMatch(b, /api_key/); // the plaintext NEVER rides the yaml (nor its alias key)
});

test('configBlock carries the session-affinity header the aggregate router reads', () => {
  // client/src/session-gate.ts: export const SESSION_ID_HEADER = 'x-hermes-session-id'
  assert.equal(SESSION_AFFINITY_HEADER, 'x-hermes-session-id');
  assert.match(configBlock(URL, MODEL), /^ {4}session_affinity_header: x-hermes-session-id$/m);
});

test('configBlock keeps the proven block shape: model routing + transport + models map', () => {
  const b = configBlock(URL, MODEL);
  assert.ok(b.startsWith('model:\n  default: Qwen3.8-Flash-Next\n  provider: idlefill\nproviders:\n'), 'top-level model block first');
  assert.match(b, /^ {4}name: idlefill$/m);
  assert.match(b, /^ {4}api_mode: chat_completions$/m); // canonical name, never the `openai` alias
  assert.match(b, /^ {4}models:\n {6}Qwen3\.8-Flash-Next: \{\}$/m);
  assert.match(b, /^ {4}models_discovered: true$/m);
});

test('configBlock: an unresolved model is the REPLACE_ME sentinel at all three fields', () => {
  const b = configBlock(URL, '   ');
  assert.match(b, /^ {2}default: REPLACE_ME$/m);
  assert.match(b, /^ {4}model: REPLACE_ME$/m);
  assert.match(b, /^ {6}REPLACE_ME: \{\}$/m);
});

test('envBlock carries the key under the env var the config references, newline-terminated', () => {
  assert.equal(envBlock('idlk_deadbeef'), `${KEY_ENV_VAR}=idlk_deadbeef\n`);
  assert.ok(configBlock(URL, MODEL).includes(KEY_ENV_VAR), 'the yaml key_env names the same var the .env sets');
});

test('defaultModelOf: the name rides verbatim; a blank/non-string model reads as empty (the warning gate)', () => {
  assert.equal(defaultModelOf({ url: URL, model: ' a ' } as never), ' a ');
  assert.equal(defaultModelOf({ url: URL, model: '   ' } as never), '');
  assert.equal(defaultModelOf({ url: URL, model: '' } as never), '');
  assert.equal(defaultModelOf({ url: URL, model: 7 } as never), '');
  assert.equal(defaultModelOf(undefined), '');
});
