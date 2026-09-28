#!/usr/bin/env node
/**
 * Test fixture executor: exits 0 and writes a SUCCESS result line carrying
 * LLM-reported token counts (tokens_out: 777 / tokens_in: 33). It also
 * pushes a large request body through the payload's proxy_base_url (the
 * daemon's loopback proxy) so the proxy's byte estimate (~body/4) is BIGGER
 * than the reported tokens — proving the result-file numbers win over the
 * byte heuristic.
 *
 * usage: node token-exec.mjs <payload_file> <result_file>
 */
import { readFileSync, writeFileSync } from 'node:fs';

const [payloadFile, resultFile] = process.argv.slice(2);
let payload = {};
try {
  payload = JSON.parse(readFileSync(payloadFile, 'utf-8'));
} catch {
  /* fixture default */
}

// Force the proxy's byte estimate well above the reported token counts.
if (payload.proxy_base_url) {
  const body = 'x'.repeat(8192);
  await fetch(`${payload.proxy_base_url}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  }).catch(() => {
    /* proxy may 502 (no real upstream) — the byte counts are still logged */
  });
}

writeFileSync(resultFile, JSON.stringify({ ok: true, tokens_out: 777, tokens_in: 33, score: 1 }) + '\n');
process.exit(0);
