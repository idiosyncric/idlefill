#!/usr/bin/env node
/**
 * Thin wrapper: build the career-ops job queue with sane default paths.
 *
 *   node scripts/build-careerops-queue.mjs [--force]
 *
 * Reads  ~/Software/career-ops/data/pipeline-prioritized.json  (read-only)
 * Writes <idlefill repo>/data/queue.jsonl
 */

import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const careerOpsRoot = process.env.CAREER_OPS_ROOT || join(homedir(), 'Software', 'career-ops');

const res = spawnSync('node', [join(repoRoot, 'adapters', 'career-ops', 'queue.mjs'), ...args, careerOpsRoot], {
  stdio: 'inherit',
});
process.exit(res.status ?? 1);
