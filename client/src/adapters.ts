/**
 * Adapter registry (issue #13).
 *
 * An adapter is a directory under <repo>/adapters/<name>/ whose package.json
 * carries an "idlefill" manifest key. Discovery is one bounded scan of that
 * directory; a missing/invalid manifest means "not an adapter", not an error.
 * The registry is the single source for both consumers: the daemon resolves
 * projects[].adapter through it (explicit projects[].executor still wins —
 * the documented escape hatch), and the MCP server enumerates it instead of
 * naming one adapter.
 *
 * Manifest shape (package.json "idlefill" key):
 *   {
 *     "name": "career-ops",            // registry key (defaults to dir name)
 *     "version": "0.1.0",
 *     "protocol": 1,                   // WIRE_PROTOCOL the executor speaks
 *     "executor": "node {repo}/adapters/career-ops/eval.mjs {payload_file} {result_file}",
 *     "payload_fields": ["url","company","title"],  // job.payload keys forwarded
 *     "result_hint": ["ok","tokens_out","tokens_in","score","report_path","error"],
 *     "estimated_seconds": 900,
 *     "timeout_seconds": 1200,
 *     "mcp_tools": "idlefill-mcp-tools.mjs"  // optional: names the adapter's
 *                                            // MCP tool module (issue #15);
 *                                            // the MCP server reads this, the
 *                                            // daemon ignores it
 *   }
 *
 * cwd is deliberately NOT manifest material: it is machine-specific and stays
 * in the client config's projects[] entry.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export interface AdapterManifest {
  name: string;
  version: string;
  /** Wire-protocol revision the adapter's executor speaks (see WIRE_PROTOCOL). */
  protocol: number;
  /** Executor command template ({payload_file}, {result_file}, {repo}). */
  executor: string;
  /** Keys of job.payload forwarded into the executor's input file. */
  payload_fields?: string[];
  /** Result-line fields the adapter promises (documentation for consumers). */
  result_hint?: string[];
  estimated_seconds?: number;
  timeout_seconds?: number;
  /** Absolute directory the manifest was found in. */
  dir: string;
}

/** One bounded scan: adapters/<name>/package.json with an "idlefill" key. */
export function discoverAdapters(repoRoot: string): Map<string, AdapterManifest> {
  const map = new Map<string, AdapterManifest>();
  const adaptersDir = join(repoRoot, 'adapters');
  let entries: string[];
  try {
    entries = readdirSync(adaptersDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return map; // no adapters dir: empty registry, not an error
  }
  for (const dirName of entries) {
    const dir = join(adaptersDir, dirName);
    const pkgFile = join(dir, 'package.json');
    if (!existsSync(pkgFile)) continue;
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(readFileSync(pkgFile, 'utf-8'));
    } catch {
      continue; // malformed package.json: not an adapter
    }
    const m = raw?.idlefill;
    if (!m || typeof m !== 'object') continue;
    const mm = m as Record<string, unknown>;
    if (typeof mm.executor !== 'string' || mm.executor.trim() === '') continue;
    const name = typeof mm.name === 'string' && mm.name.trim() !== '' ? mm.name : dirName;
    map.set(name, {
      name,
      version: typeof mm.version === 'string' ? mm.version : '0',
      protocol: typeof mm.protocol === 'number' ? mm.protocol : 1,
      executor: mm.executor,
      payload_fields: Array.isArray(mm.payload_fields)
        ? mm.payload_fields.filter((f): f is string => typeof f === 'string')
        : undefined,
      result_hint: Array.isArray(mm.result_hint)
        ? mm.result_hint.filter((f): f is string => typeof f === 'string')
        : undefined,
      estimated_seconds: typeof mm.estimated_seconds === 'number' ? mm.estimated_seconds : undefined,
      timeout_seconds: typeof mm.timeout_seconds === 'number' ? mm.timeout_seconds : undefined,
      dir,
    });
  }
  return map;
}
