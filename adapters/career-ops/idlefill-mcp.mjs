#!/usr/bin/env node
/**
 * idlefill MCP server (stdio) — queue control for the idlefill client daemon.
 *
 * Lets an agent (e.g. a Hermes profile) schedule idle work without touching
 * the arbiter API or the queue files directly:
 *
 *   idlefill_add_jobs     add job(s) to a project queue (deduped by job_id)
 *   idlefill_queue_status queue depth + what is running now (arbiter /api/state)
 *   idlefill_results      recent results lines from a project's results file
 *
 * Transport: MCP over stdio — newline-delimited JSON per the MCP stdio spec
 * (JSON-RPC 2.0). No dependencies — Node builtins only; runs under plain
 * `node`.
 *
 * Config (all resolved at call time, never baked in):
 *   - <idlefill client dir>/config.json  → server_url + token for the arbiter,
 *     and the per-project queue_file / results_file mapping (relative paths
 *     resolve against the client dir, same rule the daemon uses).
 *     Location: client dir = <repo>/client (overridable with IDLEFILL_CLIENT_DIR).
 *   - IDLEFILL_DATA env (optional) — overrides the repo data dir used when a
 *     project's queue_file is the conventional ../data/queue.jsonl.
 *
 * job_id = <company-slug>-<sha256(url)[0:8]> — identical to queue.mjs so a
 * job added here is the same identity the builder and the daemon use.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const CLIENT_DIR = resolve(process.env.IDLEFILL_CLIENT_DIR || join(REPO_ROOT, 'client'));
const DATA_DIR = resolve(process.env.IDLEFILL_DATA || join(REPO_ROOT, 'data'));

const LOG_FILE = join(CLIENT_DIR, 'logs', 'idlefill-mcp.log');
const log = (msg) => {
  try {
    mkdirSync(join(CLIENT_DIR, 'logs'), { recursive: true });
    appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`, 'utf-8');
  } catch {
    /* logging must never kill the server */
  }
};

// ---------------------------------------------------------------------------
// Config + project paths (same resolution rule as the daemon: relative paths
// against the client package dir)
// ---------------------------------------------------------------------------

function loadClientConfig() {
  for (const name of ['config.json', 'config.client.json']) {
    const p = join(CLIENT_DIR, name);
    if (existsSync(p)) {
      try {
        return JSON.parse(readFileSync(p, 'utf-8'));
      } catch (e) {
        return { __error: `client config unreadable: ${name}: ${e.message}` };
      }
    }
  }
  return { __error: `no client config found in ${CLIENT_DIR} (config.json)` };
}

/** Map project name → {queue_file, results_file} from the client config. */
function projectPaths(cfg) {
  const map = new Map();
  const projects = Array.isArray(cfg.projects) ? cfg.projects : [];
  for (const p of projects) {
    if (!p || typeof p.name !== 'string' || !p.name) continue;
    map.set(p.name, {
      queue_file: resolve(CLIENT_DIR, String(p.queue_file || '../data/queue.jsonl')),
      results_file: resolve(CLIENT_DIR, String(p.results_file || '../data/results.jsonl')),
    });
  }
  // Default (the only project today): the repo data dir.
  if (!map.has('career-ops')) {
    map.set('career-ops', { queue_file: join(DATA_DIR, 'queue.jsonl'), results_file: join(DATA_DIR, 'results.jsonl') });
  }
  return map;
}

// ---------------------------------------------------------------------------
// Queue helpers (mirror client/src/index.ts: readQueue / writeQueue semantics)
// ---------------------------------------------------------------------------

function readQueue(file) {
  if (!existsSync(file)) return [];
  const jobs = [];
  for (const line of readFileSync(file, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const j = JSON.parse(line);
      if (j && typeof j.job_id === 'string') jobs.push(j);
    } catch {
      /* skip corrupt line */
    }
  }
  return jobs;
}

function writeQueue(file, jobs) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, jobs.map((j) => JSON.stringify(j)).join('\n') + (jobs.length ? '\n' : ''), 'utf-8');
  renameSync(tmp, file);
}

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
function urlHash8(url) {
  return createHash('sha256').update(String(url)).digest('hex').slice(0, 8);
}
function jobIdFor(job) {
  return `${slug(job.company || 'unknown')}-${urlHash8(job.url)}`;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

/**
 * Exclusion facts from the ground-truth files (queue.mjs rules): a job is
 * excluded only when its LAST results line is ok:true — a job whose last line
 * is a failure is RETRIABLE. A quarantined job never runs again.
 * Computed FRESH on every call — the daemon appends to these files while jobs
 * finish, so stale reads would resurrect finished/quarantined work.
 */
function exclusionFacts(paths) {
  // lastResult: job_id → last results line (last line wins, same as queue.mjs)
  const lastResult = new Map();
  if (existsSync(paths.results_file)) {
    for (const line of readFileSync(paths.results_file, 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        if (r && typeof r.job_id === 'string') lastResult.set(r.job_id, r);
      } catch {
        /* skip corrupt line */
      }
    }
  }
  const done = new Set([...lastResult].filter(([, r]) => r.ok === true).map(([id]) => id));
  const quarantined = new Set();
  const qf = join(dirname(paths.results_file), 'quarantine.jsonl');
  if (existsSync(qf)) {
    for (const line of readFileSync(qf, 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const q = JSON.parse(line);
        if (q && typeof q.job_id === 'string') quarantined.add(q.job_id);
      } catch {
        /* skip corrupt line */
      }
    }
  }
  return { done, quarantined };
}

/**
 * Filter `toAdd` (a pre-deduped batch) against the live queue + ground truth.
 * Returns { fresh, skippedQueue, skippedDone, skippedQuarantined }.
 */
function filterAgainstState(toAddBatch, paths) {
  const { done, quarantined } = exclusionFacts(paths);
  const have = new Set(readQueue(paths.queue_file).map((j) => j.job_id));
  const fresh = [];
  const skippedQueue = [];
  const skippedDone = [];
  const skippedQuarantined = [];
  for (const j of toAddBatch) {
    if (quarantined.has(j.job_id)) skippedQuarantined.push(j.job_id);
    else if (done.has(j.job_id)) skippedDone.push(j.job_id);
    else if (have.has(j.job_id)) skippedQueue.push(j.job_id);
    else fresh.push(j);
  }
  return { fresh, skippedQueue, skippedDone, skippedQuarantined };
}

/** Pre-dedup a raw job list (same identity within one batch = one job). */
function dedupeBatch(toAdd) {
  const seen = new Set();
  const batch = [];
  let dups = 0;
  for (const j of toAdd) {
    if (seen.has(j.job_id)) {
      dups++;
      continue;
    }
    seen.add(j.job_id);
    batch.push(j);
  }
  return { batch, dups };
}

function addJobs(args) {
  const cfg = loadClientConfig();
  if (cfg.__error) return { ok: false, error: cfg.__error };
  const project = String(args.project || 'career-ops');
  const paths = projectPaths(cfg).get(project);
  if (!paths) return { ok: false, error: `unknown project "${project}" — client config knows: ${[...projectPaths(cfg).keys()].join(', ')}` };

  const input = Array.isArray(args.jobs) ? args.jobs : [args.jobs];
  if (!input.length) return { ok: false, error: 'jobs (or jobs[0]) is required' };
  const bad = input.findIndex((j) => !j || typeof j.url !== 'string' || !/^https?:\/\//.test(j.url));
  if (bad !== -1) return { ok: false, error: `job ${bad + 1} needs a valid http(s) url` };

  const dryRun = args.dry_run === true;
  const now = new Date().toISOString();
  const toAdd = input.map((j) => ({
    job_id: jobIdFor(j),
    payload: {
      url: j.url,
      company: typeof j.company === 'string' && j.company ? j.company : 'unknown',
      title: typeof j.title === 'string' && j.title ? j.title : '',
      score: typeof j.score === 'number' ? j.score : null,
      source: 'mcp',
      queued_at: now,
      ...('extra' in j && j.extra && typeof j.extra === 'object' ? { extra: j.extra } : {}),
    },
  }));
  const { batch, dups } = dedupeBatch(toAdd);

  // Classify against the LIVE state (fresh facts every time — the daemon
  // mutates queue/results/quarantine between our calls).
  const plan0 = filterAgainstState(batch, paths);

  if (dryRun) {
    log(`add_jobs project=${project} dry_run would_add=${plan0.fresh.length} in_queue=${plan0.skippedQueue.length} done=${plan0.skippedDone.length} quarantined=${plan0.skippedQuarantined.length} batch_dups=${dups} queue=${readQueue(paths.queue_file).length}`);
    return {
      ok: true,
      project,
      dry_run: true,
      added: plan0.fresh.map((j) => j.job_id),
      skipped_in_queue: plan0.skippedQueue,
      skipped_done: plan0.skippedDone,
      skipped_quarantined: plan0.skippedQuarantined,
      skipped_duplicate: dups,
      queue_length: readQueue(paths.queue_file).length + plan0.fresh.length,
      note: 'dry_run: queue file NOT modified; this is what would have been added',
    };
  }

  // Write + verify, with one retry: the daemon rewrites queue.jsonl when a job
  // ends, and a same-moment rewrite would otherwise drop our lines. The retry
  // RE-READS the state (a job can finish between attempts) so it never
  // resurrects work that just completed.
  for (let attempt = 1; attempt <= 2; attempt++) {
    const plan = filterAgainstState(batch, paths);
    const existing = readQueue(paths.queue_file);
    const merged = [...existing, ...plan.fresh];
    writeQueue(paths.queue_file, merged);
    const after = new Set(readQueue(paths.queue_file).map((j) => j.job_id));
    const missing = plan.fresh.filter((j) => !after.has(j.job_id)).map((j) => j.job_id);
    if (missing.length === 0) {
      log(`add_jobs project=${project} added=${plan.fresh.length} in_queue=${plan.skippedQueue.length} done=${plan.skippedDone.length} quarantined=${plan.skippedQuarantined.length} batch_dups=${dups} queue=${merged.length}${attempt > 1 ? ` (retry ${attempt})` : ''}`);
      return {
        ok: true,
        project,
        added: plan.fresh.map((j) => j.job_id),
        skipped_in_queue: plan.skippedQueue,
        skipped_done: plan.skippedDone,
        skipped_quarantined: plan.skippedQuarantined,
        skipped_duplicate: dups,
        queue_length: merged.length,
        note: 'jobs are picked up by the client daemon on the next idle grant (no restart needed)',
      };
    }
    // A concurrent daemon rewrite dropped our lines — re-plan and retry once.
  }
  return { ok: false, error: 'queue write lost to a concurrent daemon rewrite twice; try again' };
}

async function arbiterState(cfg) {
  const url = (cfg.server_url || '').replace(/\/$/, '') + '/api/state?limit=10';
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 4000);
  try {
    const res = await fetch(url, { headers: { authorization: `Bearer ${cfg.token}` }, signal: ctrl.signal });
    if (!res.ok) return { error: `arbiter ${res.status}` };
    return await res.json();
  } catch (e) {
    return { error: `arbiter unreachable: ${e.message}` };
  } finally {
    clearTimeout(t);
  }
}

function queueStatus(args) {
  const cfg = loadClientConfig();
  if (cfg.__error) return { ok: false, error: cfg.__error };
  // Job preview is capped: the queue can hold hundreds of lines and this tool
  // answers "how much work is queued + what is running", not "dump the file".
  const limit = Math.max(1, Math.min(200, Number(args.limit) || 10));
  const paths = projectPaths(cfg);
  const out = { ok: true, projects: {}, arbiter: null };
  for (const [name, p] of paths) {
    const q = readQueue(p.queue_file);
    out.projects[name] = {
      queue_length: q.length,
      jobs_shown: Math.min(q.length, limit),
      jobs: q.slice(0, limit).map((j) => ({
        job_id: j.job_id,
        company: j.payload?.company,
        title: j.payload?.title,
        score: j.payload?.score ?? null,
        attempts: typeof j.attempts === 'number' ? j.attempts : 0,
      })),
    };
  }
  const st = arbiterState(cfg).catch((e) => ({ error: `arbiter unreachable: ${e.message}` }));
  st.then(async (st) => {
    if (st && st.error) {
      out.arbiter = { error: st.error };
    } else if (st) {
      const proj = String(args.project || 'career-ops');
      const p = st.projects?.find((x) => x.name === proj);
      out.arbiter = {
        idle: st.idle ? { idle: st.idle.idle, degraded: st.idle.degraded, idle_seconds: st.idle.idle_seconds, last_activity: st.idle.last_activity } : null,
        project: p ? { paused: p.scheduling?.paused ?? false, today: p.today ?? null, workers: (p.workers || []).map((w) => ({ client: w.client, online: w.online, queue_depth: w.queue_depth })) } : null,
        running_jobs: (st.active_leases || []).filter((l) => l.project === proj).map((l) => ({ job_id: l.job_id, worker: l.client, lease_id: l.lease_id })),
        throttled_jobs: (st.throttled_jobs || []).filter((t) => t.project === proj),
      };
    }
  });
  // The arbiter read is best-effort and short-lived; report it if it lands,
  // otherwise the file-based view is complete on its own. (The stdio loop
  // awaits this promise before responding to the tools/call — see below.)
  out.__arbiterPromise = st;
  return out;
}

function results(args) {
  const cfg = loadClientConfig();
  if (cfg.__error) return { ok: false, error: cfg.__error };
  const project = String(args.project || 'career-ops');
  const paths = projectPaths(cfg).get(project);
  if (!paths) return { ok: false, error: `unknown project "${project}"` };
  const limit = Math.max(1, Math.min(200, Number(args.limit) || 20));
  const f = paths.results_file;
  if (!existsSync(f)) return { ok: true, project, results: [], note: 'no results yet' };
  const lines = readFileSync(f, 'utf-8').split('\n').filter((l) => l.trim());
  const out = [];
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    try {
      const r = JSON.parse(lines[i]);
      out.push({
        job_id: r.job_id,
        ok: r.ok === true,
        score: r.score ?? null,
        error: r.error || null,
        tokens_out: r.tokens_out ?? null,
        ts: r.ts || null,
        report_path: r.report_path || null,
      });
    } catch {
      /* skip corrupt line */
    }
  }
  return { ok: true, project, count: out.length, results: out };
}

const TOOLS = [
  {
    name: 'idlefill_add_jobs',
    description:
      'Add one or more job openings to an idlefill project queue so the idlefill client daemon evaluates them whenever the local LLM server is idle. ' +
      'Each job: { url (required, http(s)), company?, title?, score? (number 0-100, for ordering context), extra? (free object) }. ' +
      'A job is skipped when it is already in the queue, its last result is ok:true, or it was quarantined; duplicates within the batch collapse to one. ' +
      'The response names each skip (skipped_in_queue / skipped_done / skipped_quarantined). dry_run=true previews without writing. ' +
      'The daemon picks up new lines on its next idle grant — no restart.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'idlefill project name (default career-ops)' },
        jobs: {
          type: 'array',
          description: 'jobs to enqueue',
          items: {
            type: 'object',
            properties: {
              url: { type: 'string' },
              company: { type: 'string' },
              title: { type: 'string' },
              score: { type: 'number' },
              extra: { type: 'object' },
            },
            required: ['url'],
          },
        },
        dry_run: { type: 'boolean', description: 'preview only, do not write the queue file' },
      },
      required: ['jobs'],
    },
  },
  {
    name: 'idlefill_queue_status',
    description:
      'Show the idlefill queue(s): queue depth, a PREVIEW of the first jobs (default 10, raise with limit up to 200) with retry attempts, plus — when the arbiter is reachable — the idle signal, the project pause/budget state, connected workers, and any job currently running.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'project to focus the arbiter part on (default career-ops)' },
        limit: { type: 'number', description: 'how many queued jobs to preview, 1-200 (default 10)' },
      },
    },
  },
  {
    name: 'idlefill_results',
    description:
      'Show recent evaluation results from a project (newest first): job_id, ok, score, error, tokens_out, timestamp, report path.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'default career-ops' },
        limit: { type: 'number', description: 'how many lines, 1-200 (default 20)' },
      },
    },
  },
];

const TOOL_IMPL = {
  idlefill_add_jobs: async (a) => addJobs(a),
  idlefill_queue_status: async (a) => {
    const out = queueStatus(a);
    // Await the arbiter read so the response is complete; the .then() inside
    // queueStatus already shaped (or errored) out.arbiter — do NOT overwrite
    // it with the raw /api/state payload (huge; context bomb for agents).
    if (out.__arbiterPromise) {
      const raw = await out.__arbiterPromise;
      if (!out.arbiter && raw) out.arbiter = raw.error ? { error: raw.error } : null;
    }
    delete out.__arbiterPromise;
    return out;
  },
  idlefill_results: async (a) => results(a),
};

// ---------------------------------------------------------------------------
// MCP stdio transport: newline-delimited JSON (MCP stdio spec), JSON-RPC 2.0
// ---------------------------------------------------------------------------

const SERVER_INFO = { name: 'idlefill', version: '1.0.0' };
const PROTOCOL_VERSION = '2024-11-05';

let lineBuf = '';
const utf8 = new StringDecoder('utf-8');

function send(obj) {
  // One JSON-RPC message per line. JSON.stringify emits no raw newlines, so
  // a line is always exactly one complete, valid message.
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function respond(id, result) {
  send({ jsonrpc: '2.0', id, result });
}
function fail(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handle(msg) {
  const { id, method, params } = msg;
  const isNotification = id === undefined;

  switch (method) {
    case 'initialize':
      respond(id, {
        protocolVersion: params?.protocolVersion || PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          'idlefill schedules background work on a local LLM server while it is idle. ' +
          'idlefill_add_jobs enqueues work; idlefill_queue_status shows queues + running state; idlefill_results shows finished evaluations.',
      });
      return;
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return;
    case 'tools/list':
      respond(id, { tools: TOOLS });
      return;
    case 'tools/call': {
      const name = params?.name;
      const impl = TOOL_IMPL[name];
      if (!impl) {
        if (isNotification) return;
        fail(id, -32602, `unknown tool: ${name}`);
        return;
      }
      try {
        const result = await impl(params?.arguments || {});
        respond(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], isError: result && result.ok === false });
      } catch (e) {
        respond(id, { content: [{ type: 'text', text: `error: ${e.message}` }], isError: true });
      }
      return;
    }
    case 'ping':
      respond(id, {});
      return;
    default:
      if (isNotification) return;
      fail(id, -32601, `method not found: ${method}`);
  }
}

function onData(chunk) {
  lineBuf += utf8.write(chunk);
  let idx;
  while ((idx = lineBuf.indexOf('\n')) !== -1) {
    const line = lineBuf.slice(0, idx).trim();
    lineBuf = lineBuf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (e) {
      log(`bad JSON-RPC line: ${e.message} :: ${line.slice(0, 200)}`);
      continue;
    }
    handle(msg).catch((e) => {
      log(`handler error: ${e.stack || e}`);
      if (msg.id !== undefined) fail(msg.id, -32603, `internal error: ${e.message}`);
    });
  }
}

process.stdin.on('data', onData);
process.stdin.on('end', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
log('idlefill-mcp server started (stdio)');
