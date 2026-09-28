#!/usr/bin/env node
/**
 * Test fixture executor: exits 0 and writes a SUCCESS result line WITHOUT
 * token counts ({ ok: true, score: 1 }). It also pushes a large request
 * body through the payload's proxy_base_url so the daemon's proxy byte
 * estimate (req bytes / 4) is a real, non-zero number — the success path
 * must FALL BACK to it when the result lacks the LLM-reported counts.
 *
 * usage: node no-tokens-exec.mjs <payload_file> <result_file>
 */
import { readFileSync, writeFileSync } from 'node:fs';

const [payloadFile, resultFile] = process.argv.slice(2);
let payload = {};
try {
  payload = JSON.parse(readFileSync(payloadFile, 'utf-8'));
} catch {
  /* fixture default */
}

if (payload.proxy_base_url) {
  const body = 'x'.repeat(8192);
  await fetch(`${payload.proxy_base_url}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  }).catch(() => {
    /* the proxy may 502 (no real upstream) — the request byte count is still logged */
  });
}

writeFileSync(resultFile, JSON.stringify({ ok: true, score: 1 }) + '\n');
process.exit(0);
