#!/usr/bin/env node
/**
 * idlefill adapter: noop (issue #13 acceptance fixture).
 *
 * Proves the adapter registry end to end: a project naming
 * `adapter: "noop"` runs one job with ZERO edits to client/src. It declares
 * its own payload vocabulary (payload_fields: ["target","note"]) — anything
 * else the queue line carries must NOT reach the payload file — sleeps a
 * configurable moment, and writes a success result line with token counts.
 *
 * Contract (same as every adapter):
 *   payload_file  JSON: { job_id, target, note, model, proxy_base_url }
 *   result_file   ONE JSON line:
 *                 { ok: true, job_id, tokens_out, tokens_in, echo }
 *
 * Env: IDLEFILL_NOOP_SLEEP_MS (default 0) — how long to sleep.
 */

import { readFileSync, writeFileSync } from 'node:fs';

const [payloadFile, resultFile] = process.argv.slice(2);
if (!payloadFile || !resultFile) {
  console.error('usage: eval.mjs <payload_file> <result_file>');
  process.exit(2);
}

const payload = JSON.parse(readFileSync(payloadFile, 'utf-8'));
const sleepMs = Number(process.env.IDLEFILL_NOOP_SLEEP_MS ?? 0);

const started = Date.now();
while (Date.now() - started < sleepMs) {
  // busy wait — no timers needed for a fixture
}

const result = {
  ok: true,
  job_id: payload.job_id,
  tokens_out: 42,
  tokens_in: 7,
  // echo proves the declared fields arrived; undeclared keys must be absent.
  echo: { target: payload.target ?? null, note: payload.note ?? null },
};
writeFileSync(resultFile, JSON.stringify(result) + '\n');
