#!/usr/bin/env node
/**
 * idlefill-mcp-tools.mjs (cycle module) — MCP cycle tools (issue #58, D5).
 *
 * The cycle-shaped tools ship as a DISCOVERED TOOL MODULE (the issue #15
 * extension point), not core tools: the gate-rule vocabulary is project-
 * shaped. The server supplies the full call context (ctx = { project,
 * paths, config, arbiter, log }) — this module never resolves the client
 * config itself and never bakes paths.
 *
 * Tools: idlefill_create_cycle, idlefill_edit_cycle, idlefill_pause_cycle,
 * idlefill_resume_cycle (write-bearing: annotations say readOnlyHint:false,
 * so the #14 per-project policy + IDLEFILL_MCP_READ_ONLY treat them exactly
 * like the core write tools), idlefill_list_cycles, idlefill_cycle_status
 * (read-only).
 *
 * Hard rules (dev-cycles.md D5): the cycle tools write ONLY the cycles file
 * (`<queue_file>.cycles.json`, tmp+rename, corrupt reads as empty → fail
 * closed). They never touch leases, the queue, or the arbiter. Fresh-read
 * classification against the LIVE cycles file on every call. dry_run=true
 * previews without writing.
 *
 * Wiring: NOT auto-discovered from the adapter dir by default (a default-
 * named module here would change every existing tools/list golden). Operators
 * enable it with IDLEFILL_MCP_TOOLS=<path> or the adapter manifest's
 * idlefill.mcp_tools field; the test drives it through IDLEFILL_MCP_TOOLS.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

// --- cycles file (mirrors client/src/index.ts: same shape + discipline) ---

function cyclesFile(queueFile) {
  return `${queueFile}.cycles.json`;
}

function readCycles(queueFile) {
  const f = cyclesFile(queueFile);
  if (!existsSync(f)) return null;
  try {
    const raw = JSON.parse(readFileSync(f, 'utf-8'));
    if (!Array.isArray(raw)) return null;
    return raw;
  } catch {
    return null; // corrupt = fail-closed for cycles (state.json posture)
  }
}

function writeCycles(queueFile, rows) {
  const f = cyclesFile(queueFile);
  mkdirSync(dirname(f), { recursive: true });
  const tmp = `${f}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(rows, null, 2) + '\n', 'utf-8');
  renameSync(tmp, f);
}

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function resolveTarget(ctx, projectArg) {
  const name = String(projectArg || ctx.project || '');
  const paths = ctx.paths instanceof Map ? ctx.paths : new Map(Object.entries(ctx.paths || {}));
  const p = paths.get(name);
  if (!p) return { error: `unknown project "${name}" — client config knows: ${[...paths.keys()].join(', ') || '(none)'}` };
  return { project: name, queueFile: p.queue_file, resultsFile: p.results_file };
}

function quarantineFacts(resultsFile) {
  const f = `${dirname(resultsFile)}/quarantine.jsonl`;
  const out = new Map();
  if (!existsSync(f)) return out;
  for (const line of readFileSync(f, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const q = JSON.parse(line);
      if (q && typeof q.job_id === 'string') out.set(q.job_id, q);
    } catch {
      /* skip corrupt line */
    }
  }
  return out;
}

function queuePositions(queueFile) {
  const pos = new Map();
  if (!existsSync(queueFile)) return pos;
  let i = 0;
  for (const line of readFileSync(queueFile, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const j = JSON.parse(line);
      if (j && typeof j.job_id === 'string') {
        i += 1;
        pos.set(j.job_id, { position: i, stage: j.payload?.stage ?? null, cycle_id: j.payload?.cycle_id ?? null });
      }
    } catch {
      /* skip corrupt line */
    }
  }
  return pos;
}

/** Write + verify + one retry against the LIVE file (fresh-read rule). */
function writeCyclesVerified(queueFile, mutate, presentId) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const rows = readCycles(queueFile) ?? [];
    const next = mutate(rows);
    writeCycles(queueFile, next);
    const after = readCycles(queueFile) ?? [];
    if (presentId === null || after.some((r) => r.cycle_id === presentId)) return { ok: true, rows: after };
  }
  return { ok: false, error: 'cycles write lost twice; try again' };
}

// --- validation -------------------------------------------------------------

const STATUSES = ['planned', 'running', 'paused', 'done'];

function validateItems(items) {
  if (!Array.isArray(items) || items.length === 0) return { error: 'items must be a non-empty array of { job_id?, payload?, gates? }' };
  const norm = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (!it || typeof it !== 'object') return { error: `items[${i}] must be an object` };
    const jobId = typeof it.job_id === 'string' && it.job_id ? it.job_id : `item-${i + 1}`;
    const gates = [];
    if (it.gates !== undefined) {
      if (!Array.isArray(it.gates)) return { error: `items[${i}].gates must be an array` };
      for (let g = 0; g < it.gates.length; g++) {
        const gt = it.gates[g];
        if (!gt || typeof gt.name !== 'string' || !gt.name) return { error: `items[${i}].gates[${g}] needs a name` };
        if (typeof gt.rule !== 'string' || !gt.rule.trim()) return { error: `items[${i}].gates[${g}] needs a rule (stored verbatim — the driver applies it to the gate's result line)` };
        gates.push({
          name: gt.name,
          job_id: typeof gt.job_id === 'string' && gt.job_id ? gt.job_id : `gate-${slug(gt.name)}-${jobId}`,
          rule: gt.rule,
          ...(gt.payload && typeof gt.payload === 'object' ? { payload: gt.payload } : {}),
        });
      }
    }
    norm.push({
      job_id: jobId,
      ...(it.payload && typeof it.payload === 'object' ? { payload: it.payload } : {}),
      gates,
    });
  }
  const ids = norm.flatMap((it) => [it.job_id, ...it.gates.map((g) => g.job_id)]);
  if (new Set(ids).size !== ids.length) return { error: 'item and gate job_ids must be unique within one cycle' };
  return { items: norm };
}

// --- tools ------------------------------------------------------------------

function createCycle(args, ctx) {
  const t = resolveTarget(ctx, args.project);
  if (t.error) return { ok: false, error: t.error };
  const cycleId = typeof args.cycle_id === 'string' && args.cycle_id ? args.cycle_id : `cycle-${slug(args.name || t.project)}-${Date.now()}`;
  const vi = validateItems(args.items);
  if (vi.error) return { ok: false, error: vi.error };
  const row = {
    cycle_id: cycleId,
    project: t.project,
    status: STATUSES.includes(args.status) && args.status !== 'done' ? args.status : 'planned',
    items: vi.items,
    cursor: { item: 0, stage: 'item', gate: 0 },
    verdicts: {},
  };
  const existing = readCycles(t.queueFile) ?? [];
  if (existing.some((r) => r.cycle_id === cycleId)) return { ok: false, error: `cycle_id "${cycleId}" already exists in the live cycles file (use idlefill_edit_cycle to change it)` };
  if (args.dry_run === true) {
    return { ok: true, project: t.project, dry_run: true, cycle: row, cycles_file: cyclesFile(t.queueFile), note: 'dry_run: cycles file NOT modified; this is the row that would be written' };
  }
  const w = writeCyclesVerified(t.queueFile, (rows) => [...rows, row], cycleId);
  if (!w.ok) return w;
  return { ok: true, project: t.project, cycle: row, cycle_count: w.rows.length, cycles_file: cyclesFile(t.queueFile), note: 'the client daemon cycle driver starts the row on its next poll tick (status planned → running when admitted)' };
}

function editCycle(args, ctx) {
  const t = resolveTarget(ctx, args.project);
  if (t.error) return { ok: false, error: t.error };
  const cycleId = String(args.cycle_id ?? '');
  if (!cycleId) return { ok: false, error: 'cycle_id is required' };
  if (args.status !== undefined && !STATUSES.includes(args.status)) return { ok: false, error: `status must be one of: ${STATUSES.join(', ')}` };
  let items;
  if (args.items !== undefined) {
    const vi = validateItems(args.items);
    if (vi.error) return { ok: false, error: vi.error };
    items = vi.items;
  }
  if (items === undefined && args.status === undefined) return { ok: false, error: 'nothing to edit: pass items and/or status' };
  const before = (readCycles(t.queueFile) ?? []).find((r) => r.cycle_id === cycleId);
  if (!before) return { ok: false, error: `unknown cycle_id "${cycleId}" — live cycles file has: ${(readCycles(t.queueFile) ?? []).map((r) => r.cycle_id).join(', ') || '(none)'}` };
  const patched = { ...before, ...(items !== undefined ? { items } : {}), ...(args.status !== undefined ? { status: args.status } : {}) };
  if (args.dry_run === true) {
    return { ok: true, project: t.project, dry_run: true, before, after: patched, note: 'dry_run: cycles file NOT modified' };
  }
  const w = writeCyclesVerified(t.queueFile, (rows) => rows.map((r) => (r.cycle_id === cycleId ? patched : r)), cycleId);
  if (!w.ok) return w;
  return { ok: true, project: t.project, before, after: w.rows.find((r) => r.cycle_id === cycleId) ?? patched };
}

function flipStatus(args, ctx, to) {
  const t = resolveTarget(ctx, args.project);
  if (t.error) return { ok: false, error: t.error };
  const cycleId = String(args.cycle_id ?? '');
  if (!cycleId) return { ok: false, error: 'cycle_id is required' };
  const before = (readCycles(t.queueFile) ?? []).find((r) => r.cycle_id === cycleId);
  if (!before) return { ok: false, error: `unknown cycle_id "${cycleId}"` };
  if (before.status === 'done') return { ok: false, error: `cycle "${cycleId}" is done — nothing to ${to}` };
  if (args.dry_run === true) {
    return { ok: true, project: t.project, dry_run: true, cycle_id: cycleId, from: before.status, to, note: 'dry_run: cycles file NOT modified' };
  }
  const w = writeCyclesVerified(t.queueFile, (rows) => rows.map((r) => (r.cycle_id === cycleId ? { ...r, status: to } : r)), cycleId);
  if (!w.ok) return w;
  return { ok: true, project: t.project, cycle_id: cycleId, from: before.status, to, note: to === 'paused' ? 'the driver skips paused rows; the in-flight stage job (if any) still settles on its own' : 'the driver admits the row again under cycle_max_in_flight' };
}

function listCycles(args, ctx) {
  const t = resolveTarget(ctx, args.project);
  if (t.error) return { ok: false, error: t.error };
  const rows = readCycles(t.queueFile);
  if (rows === null) return { ok: true, project: t.project, cycles: [], note: 'cycles file missing or corrupt — cycles fail closed (the queue drains normally)' };
  return {
    ok: true,
    project: t.project,
    cycles_file: cyclesFile(t.queueFile),
    count: rows.length,
    cycles: rows.map((r) => ({ cycle_id: r.cycle_id, status: r.status, cursor: r.cursor, items: r.items.length, verdicts: r.verdicts ?? {} })),
  };
}

function cycleStatus(args, ctx) {
  const t = resolveTarget(ctx, args.project);
  if (t.error) return { ok: false, error: t.error };
  const cycleId = String(args.cycle_id ?? '');
  if (!cycleId) return { ok: false, error: 'cycle_id is required' };
  const row = (readCycles(t.queueFile) ?? []).find((r) => r.cycle_id === cycleId);
  if (!row) return { ok: false, error: `unknown cycle_id "${cycleId}"` };
  const positions = queuePositions(t.queueFile);
  const quarantined = quarantineFacts(t.resultsFile);
  const curItem = row.items?.[row.cursor?.item];
  const stageJob = !curItem ? null : row.cursor.stage === 'item' ? curItem.job_id : curItem.gates?.[row.cursor.gate]?.job_id ?? null;
  const stageFacts = (jobId) => {
    if (!jobId) return null;
    return {
      job_id: jobId,
      in_queue: positions.get(jobId) ?? null,
      quarantined: quarantined.get(jobId) ? { error: quarantined.get(jobId).error ?? null } : false,
    };
  };
  return {
    ok: true,
    project: t.project,
    cycle: {
      cycle_id: row.cycle_id,
      status: row.status,
      cursor: row.cursor,
      verdicts: row.verdicts ?? {},
      items: (row.items ?? []).map((it, i) => ({
        index: i,
        job_id: it.job_id,
        stage: stageFacts(it.job_id),
        gates: (it.gates ?? []).map((g) => ({ name: g.name, job_id: g.job_id, rule: g.rule, stage: stageFacts(g.job_id) })),
      })),
    },
    current_stage: stageJob ? stageFacts(stageJob) : null,
  };
}

// --- module surface ----------------------------------------------------------

const WRITE = { readOnlyHint: false, destructiveHint: true };
const WRITE_SOFT = { readOnlyHint: false, destructiveHint: false };
const READ = { readOnlyHint: true, destructiveHint: false };

export default {
  api: 1,
  tools: [
    {
      name: 'idlefill_create_cycle',
      description:
        'Create a dev cycle: an ordered series of items, each followed by gate jobs with a RULE (stored verbatim; the driver applies it to the gate result line). ' +
        'Items: { job_id?, payload?, gates?: [{ name, rule, job_id?, payload? }] }. Gate job_ids default to gate-<name>-<item job_id>. ' +
        'Writes ONLY the cycles file (<queue_file>.cycles.json); the client daemon cycle driver runs the stages as ordinary queue jobs. ' +
        'A duplicate cycle_id against the LIVE cycles file is refused. dry_run=true previews without writing.',
      inputSchema: {
        type: 'object',
        properties: {
          project: { type: 'string' },
          cycle_id: { type: 'string', description: 'stable id (default: generated from name/project + time)' },
          name: { type: 'string' },
          status: { type: 'string', enum: ['planned', 'running', 'paused'] },
          items: { type: 'array', items: { type: 'object' } },
          dry_run: { type: 'boolean' },
        },
        required: ['items'],
      },
      annotations: WRITE,
    },
    {
      name: 'idlefill_edit_cycle',
      description:
        'Change the items/gate rules and/or the status of ONE cycle row in the cycles file (fresh-read; the Phase 2 self-improvement seam rewrites rules here). ' +
        'dry_run=true previews before/after without writing. Never touches leases or the arbiter.',
      inputSchema: {
        type: 'object',
        properties: {
          project: { type: 'string' },
          cycle_id: { type: 'string' },
          items: { type: 'array', items: { type: 'object' } },
          status: { type: 'string', enum: ['planned', 'running', 'paused', 'done'] },
          dry_run: { type: 'boolean' },
        },
        required: ['cycle_id'],
      },
      annotations: WRITE,
    },
    {
      name: 'idlefill_pause_cycle',
      description: 'Flip one cycle row to status "paused": the driver skips it (the blunt client-pause override stays the operator-wide tool). dry_run=true previews.',
      inputSchema: { type: 'object', properties: { project: { type: 'string' }, cycle_id: { type: 'string' }, dry_run: { type: 'boolean' } }, required: ['cycle_id'] },
      annotations: WRITE_SOFT,
    },
    {
      name: 'idlefill_resume_cycle',
      description: 'Flip one paused/planned cycle row to status "running": the driver admits it again under cycle_max_in_flight. dry_run=true previews.',
      inputSchema: { type: 'object', properties: { project: { type: 'string' }, cycle_id: { type: 'string' }, dry_run: { type: 'boolean' } }, required: ['cycle_id'] },
      annotations: WRITE_SOFT,
    },
    {
      name: 'idlefill_list_cycles',
      description: 'List a project\'s cycles from the LIVE cycles file: status, cursor, item count, per-item verdicts. A corrupt/missing file returns an empty list (cycles fail closed).',
      inputSchema: { type: 'object', properties: { project: { type: 'string' } } },
      annotations: READ,
    },
    {
      name: 'idlefill_cycle_status',
      description:
        'One cycle in full: cursor, per-item verdicts, every gate rule verbatim, and for each stage job the live queue position + quarantine fact. ' +
        'Reads only the cycles/queue/quarantine files — never the arbiter.',
      inputSchema: { type: 'object', properties: { project: { type: 'string' }, cycle_id: { type: 'string' } }, required: ['cycle_id'] },
      annotations: READ,
    },
  ],
  call: async (name, args, ctx) => {
    switch (name) {
      case 'idlefill_create_cycle': return createCycle(args, ctx);
      case 'idlefill_edit_cycle': return editCycle(args, ctx);
      case 'idlefill_pause_cycle': return flipStatus(args, ctx, 'paused');
      case 'idlefill_resume_cycle': return flipStatus(args, ctx, 'running');
      case 'idlefill_list_cycles': return listCycles(args, ctx);
      case 'idlefill_cycle_status': return cycleStatus(args, ctx);
      default: return { ok: false, error: `unhandled tool: ${name}` };
    }
  },
};
