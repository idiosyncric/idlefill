#!/usr/bin/env node
/**
 * idlefill adapter: career-ops JD evaluator (executor).
 *
 * Run by the idlefill client with cwd = career-ops root:
 *   node eval.mjs <payload_file> <result_file>
 *
 * Contract (from the arbiter/client):
 *   payload_file  JSON: { job_id, url, company, title, model,
 *                        proxy_base_url }   # e.g. http://127.0.0.1:11435/v1
 *   result_file   ONE JSON line:
 *                 { ok, tokens_out, tokens_in, score, report_path, error? }
 *
 * Steps:
 *   1. read payload
 *   2. career-ops browser-extract.mjs <url> --mode jd --timeout 60000
 *      → { url, title, text }. On failure / empty text: write
 *        {ok:false, error:"extract_failed"} and exit 0 (a failed job must
 *        not look like a crash).
 *   3. JD text → temp file in os.tmpdir() (named after job_id).
 *   4. career-ops openai-eval.mjs --file <tmp> --url <proxy_base_url>
 *      --model <model> --no-save   (15 min timeout). This script refuses
 *      plain-http NON-loopback endpoints, which is why payload carries a
 *      loopback proxy URL.
 *   5. Parse the score (`SCORE: <x>` inside the ---SCORE_SUMMARY--- block,
 *      fallback `Score: x/5`) and the token usage from the printed
 *      breakdown (total: <n> tokens). Copy the report text to
 *      <result_file>-report.txt and write the result line.
 *
 * DOCTRINE: never write into career-ops' data/, reports/, or jds/. All
 * idlefill output (report copy + result line) lands where the client told
 * us to (idlefill/data). career-ops is read-only, always.
 */

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdtempSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir, homedir } from 'node:os';
import { createHash } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));

const [payloadFile, resultFile] = process.argv.slice(2);
if (!payloadFile || !resultFile) {
  console.error('usage: node eval.mjs <payload_file> <result_file>');
  process.exit(2);
}

const CO_ROOT = process.env.CAREER_OPS_ROOT || join(homedir(), 'Software', 'career-ops');
const EXTRACT_TIMEOUT_MS = 60_000;
const EVAL_TIMEOUT_MS = 15 * 60 * 1000;

function writeResult(obj) {
  writeFileSync(resultFile, JSON.stringify(obj) + '\n', 'utf-8');
}

function fail(error, extra = {}) {
  writeResult({ ok: false, error, ...extra });
  console.error(JSON.stringify({ ok: false, error, ...extra }));
  process.exit(0); // a failed job is a NORMAL outcome, not a crash
}

function run(cmd, args, { timeoutMs, cwd, maxOut = 4_000_000 }) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let done = false;
    const finish = (code, signal) => {
      if (done) return;
      done = true;
      resolve({ code, signal, out: out.slice(0, maxOut), err: err.slice(0, 200_000) });
    };
    const t = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {}
      finish(null, 'TIMEOUT');
    }, timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => finish(-1, e.message));
    child.on('close', (code, signal) => {
      clearTimeout(t);
      finish(code, signal);
    });
  });
}

// ---------------------------------------------------------------------------

let payload;
try {
  payload = JSON.parse(readFileSync(payloadFile, 'utf-8'));
} catch (e) {
  fail('payload_unreadable', { detail: String(e.message) });
}

const { job_id, url, model, proxy_base_url } = payload;
if (!job_id || !url || !proxy_base_url) {
  fail('payload_incomplete', { detail: 'need job_id, url, proxy_base_url' });
}

// --- 2. extract the JD (headless Playwright, zero LLM tokens) ---
const extractArgs = [join(CO_ROOT, 'browser-extract.mjs'), url, '--mode', 'jd', '--timeout', String(EXTRACT_TIMEOUT_MS)];
const ex = await run('node', extractArgs, { timeoutMs: EXTRACT_TIMEOUT_MS + 30_000, cwd: CO_ROOT });

let jd;
if (ex.code === 0) {
  try {
    jd = JSON.parse(ex.out.trim());
  } catch {
    jd = null;
  }
}
if (!jd || !jd.text || jd.text.length < 200) {
  fail('extract_failed', {
    detail: ex.code === 0 ? `text too short (${jd?.text?.length ?? 0} chars)` : `exit ${ex.code}: ${ex.err.slice(0, 300) || ex.out.slice(0, 300)}`,
  });
}

// --- 3. JD → temp file (named after job_id, so concurrent jobs can't collide) ---
const safeJobId = String(job_id).replace(/[^a-zA-Z0-9-]/g, '');
const jdPath = join(tmpdir(), `idlefill-jd-${safeJobId}-${createHash('sha1').update(String(url)).digest('hex').slice(0, 6)}.txt`);
writeFileSync(jdPath, `${jd.title}\n\n${jd.text}`, 'utf-8');

// --- 4. evaluate via the loopback proxy (never plain-http to a remote) ---
const evalArgs = ['--file', jdPath, '--url', proxy_base_url, '--model', model, '--no-save'];
const ev = await run('node', [join(CO_ROOT, 'openai-eval.mjs'), ...evalArgs], {
  timeoutMs: EVAL_TIMEOUT_MS,
  cwd: CO_ROOT,
});

const reportText = ev.out;
const reportPath = `${resultFile}-report.txt`;
writeFileSync(reportPath, reportText || `(empty eval output)\n`, 'utf-8');

if (ev.code !== 0) {
  fail('eval_failed', { detail: `exit ${ev.code}: ${ev.err.slice(0, 300)}` });
}

// --- 5. parse score + tokens from the eval output ---
// The eval script prints a machine-readable block:
//   ---SCORE_SUMMARY---
//   COMPANY: ...
//   SCORE: <decimal>
//   ---END_SUMMARY---
// and a footer line "  Score: <x>/5  |  ..." plus a token breakdown whose
// final line is "  total:<n>k tokens (...)".
const summaryMatch = reportText.match(/---SCORE_SUMMARY---\s*([\s\S]*?)---END_SUMMARY---/);
let score = null;
if (summaryMatch) {
  const m = summaryMatch[1].match(/SCORE:\s*([0-9]*\.?[0-9]+)/);
  if (m) score = parseFloat(m[1]);
}
if (score === null) {
  const m = reportText.match(/Score:\s*([0-9]*\.?[0-9]+)\s*\/\s*5/);
  if (m) score = parseFloat(m[1]);
}

// tokens: the breakdown prints "  total:<n.k>k tokens (...)" — parse the k
// value and round back to a whole token count.
const tokMatch = reportText.match(/total:\s*([0-9]+(?:\.[0-9]+)?)k\s+tokens/);
let tokensOut = 0;
let tokensIn = 0;
if (tokMatch) {
  const totalK = parseFloat(tokMatch[1]);
  const totalTokens = Math.round(totalK * 1000);
  // The breakdown splits prompt/completion per step; take the eval step if
  // present, else treat the total as completion (the arbiter's budget counts
  // OUTPUT tokens — a conservative over-estimate is fine for a cap).
  const evalStep = reportText.match(/evaluation:\s*([0-9]+(?:\.[0-9]+)?)k\s+prompt\s*\/\s*([0-9]+(?:\.[0-9]+)?)k/);
  if (evalStep) {
    tokensIn = Math.round(parseFloat(evalStep[1]) * 1000);
    tokensOut = Math.round(parseFloat(evalStep[2]) * 1000);
    // sanity: if the eval-step sum wildly disagrees with the total, trust
    // the total for the output-side budget (conservative).
    if (tokensIn + tokensOut > totalTokens * 1.5) {
      tokensOut = totalTokens - tokensIn;
    }
  } else {
    tokensOut = totalTokens;
    tokensIn = 0;
  }
}

writeResult({
  ok: true,
  tokens_out: tokensOut,
  tokens_in: tokensIn,
  score,
  report_path: reportPath,
  url,
  company: payload.company,
  title: payload.title,
});
console.error(JSON.stringify({ ok: true, score, tokens_out: tokensOut, tokens_in: tokensIn, report_path: reportPath }));
