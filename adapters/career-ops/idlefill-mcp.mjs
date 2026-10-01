#!/usr/bin/env node
/**
 * idlefill MCP server (stdio) — queue control for the idlefill client daemon.
 *
 * Lets an agent (e.g. a Hermes profile) schedule idle work without touching
 * the arbiter API or the queue files directly:
 *
 *   idlefill_add_jobs      add job(s) to a project queue (deduped by job_id)
 *   idlefill_queue_status  queue depth + what is running now (arbiter /api/state)
 *   idlefill_results       recent results lines from a project's results file
 *   idlefill_remove_jobs   drop job(s) by exact job_id (unknown ids reported)
 *   idlefill_clear_queue   empty a project queue
 *   idlefill_job_lookup    exact job_id lookup: queue position, results
 *                          history, done/quarantined facts, running/throttled
 *
 * Per-project tool policy (issue #14): a project's config entry may carry an
 * optional `mcp` block — { enabled?, tools?, allow_write? } — that selects the
 * tools visible to that project and whether its write tools are allowed.
 * tools/list accepts an optional params.project (nonstandard extension) and
 * returns the policy-resolved set; tools/call enforces the same policy
 * (isError + the governing field named). IDLEFILL_MCP_READ_ONLY=1 blocks every
 * write-bearing tool for every project (operator escape hatch).
 *
 * Tool modules (issue #15): the tool table is extensible. At STARTUP the
 * server discovers tool modules — ES modules default-exporting
 * { api?, tools, call } — at (a) adapters/<dir>/idlefill-mcp-tools.mjs (an
 * adapter manifest's idlefill.mcp_tools field may name another file) and
 * (b) IDLEFILL_MCP_TOOLS (":"-separated paths). (a) shadows (b). Discovered
 * tools merge with the core set — tools/list = (core ∪ discovered) ∩ policy —
 * and flow through the same per-project policy. A duplicate tool name within
 * one origin, a module re-declaring a core tool, a module whose api exceeds
 * MODULE_API, or a module that fails to import aborts startup (exit nonzero).
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

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import { discoverToolModules, parseToolPathsEnv } from './mcp-tools-registry.mjs';

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

/** Raw project entries from the client config (name-valid, in config order). */
function projectEntries(cfg) {
  const out = [];
  const projects = Array.isArray(cfg.projects) ? cfg.projects : [];
  for (const p of projects) {
    if (!p || typeof p.name !== 'string' || !p.name) continue;
    out.push(p);
  }
  return out;
}

/** Map project name → {queue_file, results_file} from the client config.
 *  Projects with mcp.enabled:false are EXCLUDED here (issue #14): the MCP
 *  server never sees them (not in any enumeration, not in the unknown-project
 *  message, not a default). The daemon's own config loader is untouched —
 *  it still drains their queues. */
function projectPaths(cfg) {
  const map = new Map();
  for (const p of projectEntries(cfg)) {
    if (!projectEnabled(p)) continue;
    map.set(p.name, {
      queue_file: resolve(CLIENT_DIR, String(p.queue_file || '../data/queue.jsonl')),
      results_file: resolve(CLIENT_DIR, String(p.results_file || '../data/results.jsonl')),
    });
  }
  return map;
}

// ---------------------------------------------------------------------------
// Per-project MCP tool policy (issue #14) — resolved at tools/list, enforced
// at tools/call. Optional `mcp` block per projects[] entry:
//   { enabled?: bool, tools?: string[], allow_write?: bool }
// A project with no mcp block behaves exactly as before (all tools).
// Discovered tool modules (issue #15) flow through this policy unchanged: the
// merged set (core ∪ discovered) is filtered/enforced exactly like core.
// ---------------------------------------------------------------------------

/** WRITE-bearing core tools: every one of these mutates the queue file. */
const WRITE_TOOLS = new Set(['idlefill_add_jobs', 'idlefill_remove_jobs', 'idlefill_clear_queue']);

// --- merged tool table (issue #15) -----------------------------------------
// DISCOVERED is populated once at startup (before serving) by
// discoverToolModules; each entry is { def, modulePath, call }. A discovered
// tool counts as WRITE-BEARING when its annotations say readOnlyHint:false or
// destructiveHint:true — the policy then treats it exactly like a core write
// tool (settled decision #8).
let DISCOVERED = [];
let discoveredByName = new Map();
let discoveredWrite = new Set();

const allToolDefs = () => [...TOOLS, ...DISCOVERED.map((d) => d.def)];
const allToolNames = () => allToolDefs().map((t) => t.name);
const toolDef = (name) => (name in TOOL_IMPL ? TOOLS.find((t) => t.name === name) : discoveredByName.get(name)?.def);
const knownTool = (name) => name in TOOL_IMPL || discoveredByName.has(name);
const isWriteTool = (name) => WRITE_TOOLS.has(name) || discoveredWrite.has(name);

/** Operator escape hatch: read-only for EVERY project regardless of config. */
const READ_ONLY_MODE = process.env.IDLEFILL_MCP_READ_ONLY === '1';

/** The project's optional mcp block ({} when absent or malformed). */
function mcpBlock(p) {
  const m = p && typeof p === 'object' ? p.mcp : null;
  return m && typeof m === 'object' && !Array.isArray(m) ? m : {};
}

function projectEnabled(p) {
  return mcpBlock(p).enabled !== false;
}

/** Unknown tool names in mcp.tools: reported once per process on stderr,
 *  dropped — never fatal (issue #14 acceptance). */
const warnedUnknownToolNames = new Set();

/** The ordered tool names visible to one project entry (policy order). */
function visibleToolsFor(p) {
  const m = mcpBlock(p);
  let list;
  if (Array.isArray(m.tools)) {
    list = [];
    for (const t of m.tools) {
      if (typeof t !== 'string' || !t) continue;
      if (!knownTool(t)) {
        if (!warnedUnknownToolNames.has(t)) {
          warnedUnknownToolNames.add(t);
          process.stderr.write(`idlefill-mcp: ignoring unknown tool name "${t}" in mcp.tools for project "${p.name}"\n`);
        }
        continue;
      }
      list.push(t);
    }
  } else {
    list = allToolNames();
  }
  const allowWrite = !READ_ONLY_MODE && m.allow_write !== false;
  if (!allowWrite) list = list.filter((t) => !isWriteTool(t));
  return list;
}

/**
 * Call-site enforcement (issue #14: enforce, do not merely hide). Returns the
 * error string when the call is disallowed, null when allowed. Unknown or
 * disabled projects return null — the tool's own unknown-project error fires
 * (and its enumeration already excludes disabled projects).
 */
function enforceToolPolicy(name, project, cfg) {
  const entry = projectEntries(cfg).find((p) => p.name === project);
  if (!entry || !projectEnabled(entry)) return null;
  const m = mcpBlock(entry);
  const isWrite = isWriteTool(name);
  if (isWrite && READ_ONLY_MODE) return `read-only mode (IDLEFILL_MCP_READ_ONLY): write not allowed for project "${project}"`;
  if (isWrite && m.allow_write === false) return `write not allowed for project "${project}" (mcp.allow_write)`;
  if (!visibleToolsFor(entry).includes(name)) return `tool "${name}" not in mcp.tools for project "${project}"`;
  return null;
}

/** Tool shape for a tools/list response: static schema + EFFECTIVE annotations. */
function shapeToolForList(name, effectiveWritable) {
  const base = toolDef(name);
  const writable = effectiveWritable !== undefined ? effectiveWritable : isWriteTool(name);
  return { ...base, annotations: { readOnlyHint: !writable, destructiveHint: writable } };
}

/**
 * tools/list with no params.project (settled decision #4): the UNION of the
 * enabled projects' visible sets, with annotations reflecting the
 * MOST-RESTRICTIVE effective permission (a write tool that some project may
 * not write is annotated as not-writable). Deterministic: union order is the
 * merged table order — core tools in their static order, then discovered
 * tools sorted by name (issue #15).
 */
function unionToolsForList(cfg) {
  const entries = projectEntries(cfg).filter(projectEnabled);
  // No configured (enabled) projects: no policy source exists — publish the
  // full merged table exactly as today (calls still resolve via adapter
  // discovery / the unknown-project error).
  if (entries.length === 0) return allToolDefs().map((t) => shapeToolForList(t.name));
  const visible = new Set();
  for (const p of entries) for (const t of visibleToolsFor(p)) visible.add(t);
  return allToolNames()
    .filter((n) => visible.has(n))
    .map((n) => {
      // Most-restrictive: a write tool is annotated writable only when EVERY
      // enabled project may write it (a tool some project cannot write is not
      // reliably writable in the no-context union view).
      const writable = entries.every((p) => visibleToolsFor(p).includes(n));
      return shapeToolForList(n, isWriteTool(n) ? writable : false);
    });
}

/**
 * Adapter registry (issue #13) — dependency-free mirror of
 * client/src/adapters.ts: one bounded scan of adapters/<name>/package.json
 * for an "idlefill" manifest key. Used to resolve the default project and to
 * make the unknown-project error registry-driven (no adapter name baked in).
 */
function discoverAdapters() {
  const names = [];
  try {
    for (const e of readdirSync(join(REPO_ROOT, 'adapters'), { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const pkgFile = join(REPO_ROOT, 'adapters', e.name, 'package.json');
      if (!existsSync(pkgFile)) continue;
      let raw;
      try {
        raw = JSON.parse(readFileSync(pkgFile, 'utf-8'));
      } catch {
        continue;
      }
      const m = raw && typeof raw === 'object' ? raw.idlefill : null;
      if (m && typeof m === 'object' && typeof m.executor === 'string' && m.executor.trim() !== '') {
        names.push(typeof m.name === 'string' && m.name.trim() !== '' ? m.name : e.name);
      }
    }
  } catch {
    /* no adapters dir: empty registry */
  }
  return names;
}

/**
 * Default project when the tool call omits `project`: the sole configured
 * project, else the sole registered adapter, else null (the caller must name
 * one — no adapter name is hardcoded).
 */
function defaultProject(cfg) {
  const configured = [...projectPaths(cfg).keys()];
  if (configured.length === 1) return configured[0];
  if (configured.length === 0) {
    const adapters = discoverAdapters();
    if (adapters.length === 1) return adapters[0];
  }
  return null;
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

/** Echo the STORED job identity (not the raw input) so the caller can verify
 *  what actually landed in the queue file (issue #2, gap 3). */
function addedEcho(jobs) {
  return jobs.map((j) => ({
    job_id: j.job_id,
    url: j.payload.url,
    company: j.payload.company,
    title: j.payload.title,
  }));
}

function addJobs(args) {
  const cfg = loadClientConfig();
  if (cfg.__error) return { ok: false, error: cfg.__error };
  const project = String(args.project || defaultProject(cfg) || '');
  const paths = projectPaths(cfg).get(project);
  if (!paths) return { ok: false, error: `unknown project "${project}" — client config knows: ${[...projectPaths(cfg).keys()].join(', ') || '(none)'}; adapters: ${discoverAdapters().join(', ') || '(none)'}` };

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
      added: addedEcho(plan0.fresh),
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
        added: addedEcho(plan.fresh),
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
      const proj = String(args.project || defaultProject(cfg) || '');
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
  const project = String(args.project || defaultProject(cfg) || '');
  const paths = projectPaths(cfg).get(project);
  if (!paths) return { ok: false, error: `unknown project "${project}" — adapters: ${discoverAdapters().join(', ') || '(none)'}` };
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
        company: typeof r.company === 'string' && r.company !== '' ? r.company : null,
        title: typeof r.title === 'string' && r.title !== '' ? r.title : null,
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

// ---------------------------------------------------------------------------
// Queue mutation — remove / clear (write + verify + one retry, the same
// discipline as add_jobs: the daemon rewrites queue.jsonl as jobs end)
// ---------------------------------------------------------------------------

/**
 * The queue's write+verify+one-retry pattern, generalized for the mutation
 * tools. plan(existing) → the jobs the queue SHOULD hold after this call;
 * verify() → true when the on-disk file now carries the intended change.
 * On a lost write (a same-moment daemon rewrite clobbered ours) the state is
 * RE-READ and planned again — never blind-applied, so a job that finished
 * in the gap is not resurrected.
 */
function writeQueueVerified(file, plan, verify, logLabel) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const merged = plan(readQueue(file));
    writeQueue(file, merged);
    if (verify()) {
      log(`${logLabel} queue=${readQueue(file).length}${attempt > 1 ? ` (retry ${attempt})` : ''}`);
      return { ok: true };
    }
    // A concurrent daemon rewrite dropped our write — re-read + re-plan once.
  }
  return { ok: false, error: 'queue write lost to a concurrent daemon rewrite twice; try again' };
}

function resolveProject(cfg, projectArg) {
  const project = String(projectArg || defaultProject(cfg) || '');
  const paths = projectPaths(cfg).get(project);
  if (!paths) return { error: `unknown project "${project}" — client config knows: ${[...projectPaths(cfg).keys()].join(', ') || '(none)'}; adapters: ${discoverAdapters().join(', ') || '(none)'}` };
  return { project, paths };
}

function removeJobs(args) {
  const cfg = loadClientConfig();
  if (cfg.__error) return { ok: false, error: cfg.__error };
  const res = resolveProject(cfg, args.project);
  if (res.error) return { ok: false, error: res.error };
  const { project, paths } = res;

  const input = Array.isArray(args.job_ids) ? args.job_ids : [args.job_ids];
  if (!input.length) return { ok: false, error: 'job_ids (or job_ids[0]) is required' };
  const bad = input.findIndex((id) => typeof id !== 'string' || !id);
  if (bad !== -1) return { ok: false, error: `job_ids[${bad}] must be a non-empty string` };

  const dryRun = args.dry_run === true;
  // De-dupe while preserving first-seen order (one id = one removal).
  const wanted = [...new Set(input)];

  // Classify against the LIVE queue (the same fresh-read rule as add_jobs):
  // present ids are the removal candidates, the rest are reported not_found.
  // The removal itself is idempotent, so the classification stays honest even
  // if the queue moves between this read and the write.
  const have = new Set(readQueue(paths.queue_file).map((j) => j.job_id));
  const notFound = wanted.filter((id) => !have.has(id));
  const toRemove = wanted.filter((id) => have.has(id));

  if (dryRun) {
    log(`remove_jobs project=${project} dry_run would_remove=${toRemove.length} not_found=${notFound.length} queue=${readQueue(paths.queue_file).length}`);
    return {
      ok: true,
      project,
      dry_run: true,
      removed: toRemove,
      not_found: notFound,
      queue_length: readQueue(paths.queue_file).length - toRemove.length,
      note: 'dry_run: queue file NOT modified; this is what would have been removed',
    };
  }

  // Verify re-reads the file: every toRemove id must be gone. A retry re-reads
  // and re-plans from the moved file (writeQueueVerified), so a job that
  // finished in the gap is not resurrected.
  const out = writeQueueVerified(
    paths.queue_file,
    (existing) => existing.filter((j) => !wanted.includes(j.job_id)),
    () => !readQueue(paths.queue_file).some((j) => wanted.includes(j.job_id)),
    `remove_jobs project=${project}`,
  );
  if (!out.ok) return out;
  const after = new Set(readQueue(paths.queue_file).map((j) => j.job_id));
  return {
    ok: true,
    project,
    removed: toRemove.filter((id) => !after.has(id)),
    not_found: notFound,
    queue_length: readQueue(paths.queue_file).length,
    note: 'the queue file is the only thing touched — an in-flight lease for a removed job settles on its own and is simply not re-queued',
  };
}

function clearQueue(args) {
  const cfg = loadClientConfig();
  if (cfg.__error) return { ok: false, error: cfg.__error };
  const res = resolveProject(cfg, args.project);
  if (res.error) return { ok: false, error: res.error };
  const { project, paths } = res;

  const dryRun = args.dry_run === true;
  const depth = readQueue(paths.queue_file).length;

  if (dryRun) {
    log(`clear_queue project=${project} dry_run would_clear=${depth}`);
    return {
      ok: true,
      project,
      dry_run: true,
      cleared: depth,
      note: 'dry_run: queue file NOT modified; this is what would have been cleared',
    };
  }

  const out = writeQueueVerified(
    paths.queue_file,
    () => [],
    () => readQueue(paths.queue_file).length === 0,
    `clear_queue project=${project}`,
  );
  if (!out.ok) return out;
  return {
    ok: true,
    project,
    cleared: depth,
    queue_length: 0,
    note: 'the queue file is the only thing touched — in-flight leases settle on their own (their job is already out of the queue)',
  };
}

// ---------------------------------------------------------------------------
// Job lookup — exact job_id (no fuzzy search: identity is the slug+hash,
// fuzzy would mislead). File facts are read LIVE per call.
// ---------------------------------------------------------------------------

function jobLookup(args) {
  const cfg = loadClientConfig();
  if (cfg.__error) return { ok: false, error: cfg.__error };
  const res = resolveProject(cfg, args.project);
  if (res.error) return { ok: false, error: res.error };
  const { project, paths } = res;
  const jobId = String(args.job_id ?? '');
  if (!jobId) return { ok: false, error: 'job_id is required' };

  const limit = Math.max(1, Math.min(100, Number(args.limit) || 20));

  const out = { ok: true, project, job_id: jobId, found: false, in_queue: false, position: null, payload: null };

  // Queue membership + 1-based position + payload (live read).
  const queue = readQueue(paths.queue_file);
  const idx = queue.findIndex((j) => j.job_id === jobId);
  if (idx !== -1) {
    const j = queue[idx];
    out.found = true;
    out.in_queue = true;
    out.position = idx + 1;
    out.queue_length = queue.length;
    out.payload = {
      url: j.payload?.url ?? null,
      company: j.payload?.company ?? null,
      title: j.payload?.title ?? null,
      score: j.payload?.score ?? null,
      attempts: typeof j.attempts === 'number' ? j.attempts : 0,
    };
  }

  // Results history: last N lines for THIS job, newest first (the file is
  // append-ordered; the daemon appends one line per finished attempt).
  if (existsSync(paths.results_file)) {
    const lines = readFileSync(paths.results_file, 'utf-8').split('\n').filter((l) => l.trim());
    const mine = [];
    for (let i = lines.length - 1; i >= 0 && mine.length < limit; i--) {
      try {
        const r = JSON.parse(lines[i]);
        if (r && r.job_id === jobId) {
          mine.push({
            ok: r.ok === true,
            score: r.score ?? null,
            error: r.error || null,
            company: typeof r.company === 'string' && r.company !== '' ? r.company : null,
            title: typeof r.title === 'string' && r.title !== '' ? r.title : null,
            tokens_out: r.tokens_out ?? null,
            ts: r.ts || null,
            report_path: r.report_path || null,
          });
        }
      } catch {
        /* skip corrupt line */
      }
    }
    if (mine.length) {
      out.found = true;
      out.results = mine;
    }
  }

  // Ground-truth facts (same rule as queue.mjs / add_jobs): done = last
  // results line ok:true; quarantined = in quarantine.jsonl.
  const { done, quarantined } = exclusionFacts(paths);
  out.done = done.has(jobId);
  out.quarantined = quarantined.has(jobId);

  if (out.done) {
    out.found = true;
    out.hint = 'done: its last results line is ok:true — it will not be re-queued (use --force in queue.mjs or re-add to run it again)';
  } else if (out.quarantined) {
    out.found = true;
    out.hint = 'quarantined: it burned all retry attempts — it never runs again until the operator edits the files by hand';
  } else if (!out.found) {
    out.hint = 'not in the queue, no results line, not quarantined — this arbiter has never seen this job_id (check the company/url that would hash to it)';
  }

  // Best-effort live arbiter: running (lease) or throttled for this job.
  const st = arbiterState(cfg).catch((e) => ({ error: `arbiter unreachable: ${e.message}` }));
  st.then((state) => {
    if (state && state.error) {
      out.arbiter = { error: state.error };
      return;
    }
    if (!state) return;
    out.arbiter = {
      running: (state.active_leases || []).filter((l) => l.job_id === jobId).map((l) => ({
        lease_id: l.lease_id,
        worker: l.client,
        granted_at: l.granted_at ?? null,
        expires_at: l.expires_at ?? null,
      })),
      throttled: (state.throttled_jobs || []).filter((t) => t.project === project && t.job_id === jobId),
    };
  });
  out.__arbiterPromise = st;
  return out;
}

const TOOLS = [
  {
    name: 'idlefill_add_jobs',
    description:
      'Add one or more job openings to an idlefill project queue so the idlefill client daemon evaluates them whenever the local LLM server is idle. ' +
      'Each job: { url (required, http(s)), company?, title?, score? (number 0-100 — the daemon dispatches highest-score-first, FIFO tiebreak), extra? (free object) }. ' +
      'The response echoes each stored job as { job_id, url, company, title } so the caller can verify what landed. ' +
      'A job is skipped when it is already in the queue, its last result is ok:true, or it was quarantined; duplicates within the batch collapse to one. ' +
      'The response names each skip (skipped_in_queue / skipped_done / skipped_quarantined). dry_run=true previews without writing. ' +
      'The daemon picks up new lines on its next idle grant — no restart.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'idlefill project name (default: the sole configured project or adapter)' },
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
        project: { type: 'string', description: 'project to focus the arbiter part on (default: the sole configured project or adapter)' },
        limit: { type: 'number', description: 'how many queued jobs to preview, 1-200 (default 10)' },
      },
    },
  },
  {
    name: 'idlefill_results',
    description:
      'Show recent evaluation results from a project (newest first): job_id, ok, score, error, company, title, tokens_out, timestamp, report path. ' +
      'company/title are present on rows written by the career-ops executor; rows from other executors may lack them (null).',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'default: the sole configured project or adapter' },
        limit: { type: 'number', description: 'how many lines, 1-200 (default 20)' },
      },
    },
  },
  {
    name: 'idlefill_remove_jobs',
    description:
      'Drop one or more jobs from an idlefill project queue by EXACT job_id (no fuzzy match). ' +
      'Unknown job ids are reported (not_found), not an error. dry_run=true previews without writing. ' +
      'Only the queue file is touched: removing a job that is CURRENTLY RUNNING does not cancel its lease — ' +
      'the lease settles on its own and the job is simply no longer re-queued. ' +
      'Use idlefill_queue_status or idlefill_job_lookup to list job_ids first.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'idlefill project name (default: the sole configured project or adapter)' },
        job_ids: {
          type: 'array',
          description: 'exact job_ids to drop from the queue',
          items: { type: 'string' },
        },
        dry_run: { type: 'boolean', description: 'preview only, do not write the queue file' },
      },
      required: ['job_ids'],
    },
  },
  {
    name: 'idlefill_clear_queue',
    description:
      'Empty an idlefill project queue (remove every queued job). dry_run=true previews the count without writing. ' +
      'Only the queue file is touched: in-flight leases settle on their own. Results/quarantine files are never modified.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'idlefill project name (default: the sole configured project or adapter)' },
        dry_run: { type: 'boolean', description: 'preview only, do not write the queue file' },
      },
    },
  },
  {
    name: 'idlefill_job_lookup',
    description:
      'Find a job by EXACT job_id (identity is <company-slug>-<sha256(url)[0:8]> — no fuzzy search, it would mislead). ' +
      'Returns in_queue + 1-based queue position + the job payload (url/company/title/score/attempts), ' +
      'its results history (last N lines: ok/score/error/ts/report_path), and the done/quarantined ground-truth facts. ' +
      'When the arbiter is reachable it also reports whether the job is running (lease) or throttled. ' +
      'A job this arbiter never saw returns {ok:true, found:false} with a hint (it may be done or quarantined — those facts are returned either way).',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'idlefill project name (default: the sole configured project or adapter)' },
        job_id: { type: 'string', description: 'the exact job_id to look up' },
        limit: { type: 'number', description: 'how many results lines to include, 1-100 (default 20)' },
      },
      required: ['job_id'],
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
  idlefill_remove_jobs: async (a) => removeJobs(a),
  idlefill_clear_queue: async (a) => clearQueue(a),
  idlefill_job_lookup: async (a) => {
    const out = jobLookup(a);
    // Same pattern as queue_status: await the arbiter read so the response is
    // complete — jobLookup's .then() already shaped out.arbiter.
    if (out.__arbiterPromise) await out.__arbiterPromise;
    delete out.__arbiterPromise;
    return out;
  },
};

// ---------------------------------------------------------------------------
// MCP stdio transport: newline-delimited JSON (MCP stdio spec), JSON-RPC 2.0
// ---------------------------------------------------------------------------

const SERVER_INFO = { name: 'idlefill', version: '1.0.0' };
const PROTOCOL_VERSION = '2024-11-05';

// listChanged (issue #14): the fingerprint of the last tools/list response
// sent on this connection; a differing response is followed by
// notifications/tools/list_changed on the same channel.
let lastToolsListFingerprint = null;

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
        capabilities: { tools: { listChanged: true } },
        serverInfo: SERVER_INFO,
        instructions:
          'idlefill schedules background work on a local LLM server while it is idle. ' +
          'idlefill_add_jobs enqueues work; idlefill_queue_status shows queues + running state; idlefill_results shows finished evaluations. ' +
          'Tool availability is a per-project policy (client config projects[].mcp): tools/list accepts an optional params.project (nonstandard extension) and returns that project\'s effective tool set; tools/call enforces the same policy. ' +
          (READ_ONLY_MODE
            ? 'This server is running in READ-ONLY mode (IDLEFILL_MCP_READ_ONLY=1): every write-bearing tool is blocked for every project.'
            : 'Set IDLEFILL_MCP_READ_ONLY=1 on the server process to block every write-bearing tool for every project.'),
      });
      return;
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return;
    case 'tools/list': {
      // Policy-resolved listing (issue #14) over the MERGED table
      // (core ∪ discovered, issue #15). params.project (nonstandard
      // extension, advertised in initialize) selects one project's effective
      // set; with no param, the union across enabled projects with
      // most-restrictive annotations.
      let shaped;
      const cfg = loadClientConfig();
      if (cfg.__error) {
        shaped = allToolDefs().map((t) => shapeToolForList(t.name));
      } else if (params && typeof params.project === 'string' && params.project) {
        const entry = projectEntries(cfg).find((p) => p.name === params.project);
        if (!entry || !projectEnabled(entry)) {
          shaped = [];
        } else {
          shaped = visibleToolsFor(entry).map((n) => shapeToolForList(n));
        }
      } else {
        shaped = unionToolsForList(cfg);
      }
      respond(id, { tools: shaped });
      // listChanged: notify when this response differs from the last one sent.
      const fingerprint = JSON.stringify(shaped);
      if (lastToolsListFingerprint !== null && lastToolsListFingerprint !== fingerprint) {
        send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
      }
      lastToolsListFingerprint = fingerprint;
      return;
    }
    case 'tools/call': {
      const name = params?.name;
      const impl = TOOL_IMPL[name];
      const discovered = discoveredByName.get(name);
      if (!impl && !discovered) {
        if (isNotification) return;
        fail(id, -32602, `unknown tool: ${name}`);
        return;
      }
      // Enforce the per-project policy at the call site (issue #14: enforce,
      // do not merely hide). Resolve the project exactly as the tool would.
      const cfg = loadClientConfig();
      let project = '';
      if (!cfg.__error) {
        const args0 = params?.arguments || {};
        project = String(args0.project || defaultProject(cfg) || '');
        const denied = enforceToolPolicy(name, project, cfg);
        if (denied) {
          log(`policy block tool=${name} project=${project}: ${denied}`);
          respond(id, { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: denied }, null, 2) }], isError: true });
          return;
        }
      }
      try {
        let result;
        if (impl) {
          result = await impl(params?.arguments || {});
        } else {
          // Discovered tool module (issue #15): the server supplies the full
          // call context — the module never resolves config or paths itself.
          const ctx = {
            project,
            paths: projectPaths(cfg),
            config: cfg,
            arbiter: () => arbiterState(cfg),
            log: (msg) => process.stderr.write(`idlefill-mcp[${name}]: ${msg}\n`),
          };
          result = await discovered.call(name, params?.arguments || {}, ctx);
        }
        respond(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], isError: result && result.ok === false });
      } catch (e) {
        // A throwing module handler is an isError result naming the module —
        // the server process stays up (issue #15 acceptance).
        const where = discovered ? ` (tool module ${discovered.modulePath})` : '';
        respond(id, { content: [{ type: 'text', text: `error: ${e.message}${where}` }], isError: true });
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

/**
 * Startup (issue #15): tool-module discovery runs BEFORE serving — a discovery
 * failure (duplicate within one origin, core-name collision, api too new,
 * module import throws) exits nonzero with the message on stderr. Success
 * populates the merged table; only then does stdin get attached.
 */
async function main() {
  // Golden-file regeneration: `node idlefill-mcp.mjs --dump-core-tools`
  // prints the core tools exactly as tools/list shapes them (issue #15
  // settled decision #6). Not part of serving.
  if (process.argv.includes('--dump-core-tools')) {
    process.stdout.write(JSON.stringify(TOOLS.map((t) => shapeToolForList(t.name)), null, 2) + '\n');
    process.exit(0);
  }
  try {
    const { tools, shadowed } = await discoverToolModules({
      repoRoot: REPO_ROOT,
      extraPaths: parseToolPathsEnv(process.env.IDLEFILL_MCP_TOOLS),
      coreNames: TOOLS.map((t) => t.name),
    });
    DISCOVERED = tools;
    discoveredByName = new Map(tools.map((t) => [t.def.name, t]));
    // A discovered tool is WRITE-BEARING when its annotations say so — the
    // per-project policy (#14) then filters/blocks it exactly like core.
    discoveredWrite = new Set(
      tools
        .filter((t) => t.def.annotations && (t.def.annotations.readOnlyHint === false || t.def.annotations.destructiveHint === true))
        .map((t) => t.def.name),
    );
    for (const s of shadowed) {
      process.stderr.write(`idlefill-mcp: tool "${s.name}" from ${s.loser} shadowed by the same name in ${s.winner}\n`);
    }
    if (DISCOVERED.length) log(`tool modules: ${DISCOVERED.map((d) => `${d.def.name} (${d.modulePath})`).join(', ')}`);
  } catch (e) {
    process.stderr.write(`idlefill-mcp: startup failed: ${e.message}\n`);
    log(`startup failed: ${e.stack || e}`);
    process.exit(1);
  }
  process.stdin.on('data', onData);
  process.stdin.on('end', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));
  log('idlefill-mcp server started (stdio)');
}

main();
