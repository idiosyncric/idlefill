#!/usr/bin/env node
/**
 * Test fixture executor: exits 0 but writes a CLEAN FAILURE result line
 * (ok:false) — the "transient extract_failed" scenario. Also emits a marker
 * to stderr so the daemon's output-tail capture (error_detail) has content.
 *
 * usage: node fail-exec.mjs <payload_file> <result_file>
 */
import { writeFileSync } from 'node:fs';

const [payloadFile, resultFile] = process.argv.slice(2);
await new Promise((r) => setTimeout(r, 80));

console.error('fail-exec: transient page flake (fixture)');
writeFileSync(resultFile, JSON.stringify({ ok: false, error: 'extract_failed' }) + '\n');
process.exit(0);
