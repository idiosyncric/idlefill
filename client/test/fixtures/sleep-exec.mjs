#!/usr/bin/env node
/**
 * Test fixture executor: reads the payload file, sleeps
 * IDLEFILL_TEST_SLEEP_MS (default 200ms), then writes the result line.
 * A SIGINT during the sleep kills the process (default node behavior) —
 * that is exactly what the sigint.test.ts scenario relies on.
 *
 * usage: node sleep-exec.mjs <payload_file> <result_file>
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const [payloadFile, resultFile] = process.argv.slice(2);
const ms = parseInt(process.env.IDLEFILL_TEST_SLEEP_MS ?? '200', 10);

let payload = {};
try {
  if (existsSync(payloadFile)) payload = JSON.parse(readFileSync(payloadFile, 'utf-8'));
} catch {
  /* payload is optional for the fixture */
}

await new Promise((r) => setTimeout(r, ms));

writeFileSync(resultFile, JSON.stringify({ ok: true, tokens_out: 100, tokens_in: 10, score: 4.2, job_id: payload.job_id ?? 'fixture' }) + '\n');
process.exit(0);
