#!/usr/bin/env node
/**
 * idlefill adapter: career-ops job queue builder.
 *
 * READ-ONLY against career-ops. Reads
 *   <CAREER_OPS_ROOT>/data/pipeline-prioritized.json
 * (default: ~/Software/career-ops — overridable via CAREER_OPS_ROOT env or
 * the first CLI arg) and writes idlefill's OWN queue file:
 *   <IDLEFILL_DATA>/queue.jsonl   (default: <repo>/data/queue.jsonl)
 *
 * Queue line format: { "job_id": "<company-slug>-<url-hash8>",
 *                      "payload": { url, company, title, score } }
 *
 * Rules:
 *   - only `skip === false` entries
 *   - sorted by score desc (stable: ties keep pipeline order)
 *   - job_ids already present in results.jsonl are excluded (unless --force)
 *   - the queue file is rewritten atomically (tmp + rename)
 *
 * usage: node queue.mjs [--force] [CAREER_OPS_ROOT]
 */

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- args ---
const args = process.argv.slice(2);
const force = args.includes('--force');
const posArgs = args.filter((a) => !a.startsWith('--'));
const careerOpsRoot = resolve(posArgs[0] || process.env.CAREER_OPS_ROOT || join(homedir(), 'Software', 'career-ops'));

// --- idlefill data dir (never inside career-ops) ---
const idlefillData = resolve(process.env.IDLEFILL_DATA || join(__dirname, '..', '..', 'data'));
mkdirSync(idlefillData, { recursive: true });

const queueFile = join(idlefillData, 'queue.jsonl');
const resultsFile = join(idlefillData, 'results.jsonl');

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function urlHash8(url) {
  return createHash('sha256').update(String(url)).digest('hex').slice(0, 8);
}

// --- read source (read-only) ---
const srcFile = join(careerOpsRoot, 'data', 'pipeline-prioritized.json');
if (!existsSync(srcFile)) {
  console.error(`error: ${srcFile} not found`);
  process.exit(1);
}
const pipeline = JSON.parse(readFileSync(srcFile, 'utf-8'));
if (!Array.isArray(pipeline)) {
  console.error('error: pipeline-prioritized.json is not an array');
  process.exit(1);
}

// --- results already handled (unless --force) ---
const done = new Set();
if (!force && existsSync(resultsFile)) {
  for (const line of readFileSync(resultsFile, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r && typeof r.job_id === 'string') done.add(r.job_id);
    } catch {
      /* skip corrupt line */
    }
  }
}

// --- build ---
let kept = 0;
let skippedSkipFlag = 0;
let alreadyDone = 0;
const lines = [];
for (const job of pipeline) {
  if (!job || job.skip === true) {
    skippedSkipFlag++;
    continue;
  }
  const job_id = `${slug(job.company || 'unknown')}-${urlHash8(job.url)}`;
  if (done.has(job_id)) {
    alreadyDone++;
    continue;
  }
  lines.push(JSON.stringify({
    job_id,
    payload: {
      url: job.url,
      company: job.company,
      title: job.title,
      score: job.score,
    },
  }));
  kept++;
}

// pipeline-prioritized.json is already score-desc, but be explicit and
// stable (no reorder on equal scores).
lines.sort((a, b) => {
  const sa = JSON.parse(a).payload.score ?? -Infinity;
  const sb = JSON.parse(b).payload.score ?? -Infinity;
  return sb - sa; // stable: JS sort is stable, equal scores keep file order
});

const tmp = `${queueFile}.tmp-${process.pid}`;
writeFileSync(tmp, lines.join('\n') + (lines.length ? '\n' : ''));
renameSync(tmp, queueFile);

console.log(
  `queue: ${kept} jobs → ${queueFile} (source ${pipeline.length}, skip-flag ${skippedSkipFlag}, already-done ${alreadyDone}${force ? ', --force' : ''})`,
);
