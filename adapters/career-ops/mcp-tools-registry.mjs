/**
 * mcp-tools-registry.mjs — tool-module discovery for the idlefill MCP server
 * (issue #15).
 *
 * A TOOL MODULE is an ES module that default-exports:
 *   { api?: number, tools: [...], call: async (name, args, ctx) => any }
 *   - api:    the MODULE_API revision the module targets (missing = 0; a
 *             module whose api exceeds MODULE_API aborts startup).
 *   - tools:  the JSON Schema tool definitions exactly as the MCP tools/list
 *             response requires ({ name, description?, inputSchema?,
 *             annotations? }). A discovered tool is treated as WRITE-BEARING
 *             when its annotations say readOnlyHint:false or destructiveHint:
 *             true — the per-project policy (#14) then filters/blocks it
 *             exactly like a core write tool.
 *   - call:   the handler. ctx = { project, paths, config, arbiter, log } —
 *             supplied by the server, so a module never resolves the client
 *             config itself and never opens a file by a hand-computed path.
 *
 * Discovery (once at STARTUP, never per call), two origins searched in order:
 *   (a) <repoRoot>/adapters/<dir>/idlefill-mcp-tools.mjs — one bounded scan, the
 *       same depth as the adapter registry scan. An adapter manifest's
 *       "idlefill.mcp_tools" field may name a different file (relative to the
 *       adapter dir).
 *   (b) IDLEFILL_MCP_TOOLS — ":"-separated absolute-or-relative paths.
 * Names found in (a) SHADOW names in (b). A duplicate tool name WITHIN one
 * origin is a startup error naming both paths; a module re-declaring a core
 * tool name is a startup error too (no silent overwrite of core behaviour).
 * The merged list is sorted by tool name so registration order never depends
 * on readdir order.
 *
 * The register(api) module shape is deliberately OUT of scope (issue #15
 * settled decision #9).
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Server↔module contract version. Bump when the ctx/module shape changes. */
export const MODULE_API = 1;

/** Default tool-module filename inside an adapter directory. */
export const TOOL_MODULE_FILENAME = 'idlefill-mcp-tools.mjs';

/** IDLEFILL_MCP_TOOLS value → ordered path list (":"-separated). */
export function parseToolPathsEnv(value) {
  if (!value) return [];
  return String(value)
    .split(':')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** The adapter manifest's idlefill block (null when absent/malformed). */
function adapterMcpToolsField(pkgFile) {
  if (!existsSync(pkgFile)) return null;
  let raw;
  try {
    raw = JSON.parse(readFileSync(pkgFile, 'utf-8'));
  } catch {
    return null;
  }
  const m = raw && typeof raw === 'object' ? raw.idlefill : null;
  if (m && typeof m === 'object' && typeof m.mcp_tools === 'string' && m.mcp_tools.trim() !== '') {
    return m.mcp_tools.trim();
  }
  return null;
}

/** Import + validate one tool module. Throws with an actionable message. */
async function loadToolModule(absPath) {
  let mod;
  try {
    mod = await import(pathToFileURL(absPath).href);
  } catch (e) {
    throw new Error(`tool module "${absPath}" failed to import: ${e.message}`);
  }
  const d = mod && mod.default;
  if (!d || typeof d !== 'object') {
    throw new Error(`tool module "${absPath}": default export must be an object { api?, tools, call }`);
  }
  const api = d.api === undefined ? 0 : d.api;
  if (!Number.isInteger(api) || api < 0) {
    throw new Error(`tool module "${absPath}": "api" must be a non-negative integer (got ${JSON.stringify(d.api)})`);
  }
  if (api > MODULE_API) {
    throw new Error(
      `tool module "${absPath}" targets api ${api}, but this server speaks MODULE_API ${MODULE_API} — ` +
        `update idlefill-mcp.mjs (npm update / git pull) or use a module built for api <= ${MODULE_API}`,
    );
  }
  if (!Array.isArray(d.tools) || d.tools.length === 0) {
    throw new Error(`tool module "${absPath}": "tools" must be a non-empty array of tool definitions`);
  }
  if (typeof d.call !== 'function') {
    throw new Error(`tool module "${absPath}": "call" must be a function call(name, args, ctx)`);
  }
  const seen = new Set();
  for (const t of d.tools) {
    if (!t || typeof t.name !== 'string' || !t.name) {
      throw new Error(`tool module "${absPath}": every tool needs a non-empty string name`);
    }
    if (seen.has(t.name)) {
      throw new Error(`tool module "${absPath}": duplicate tool name "${t.name}" declared twice in one module`);
    }
    seen.add(t.name);
  }
  return { modulePath: absPath, api, tools: d.tools, call: d.call };
}

/**
 * Discover + merge all tool modules. Returns
 *   { tools: [{ def, modulePath, call }], shadowed: [{ name, winner, loser }] }
 * with tools sorted by name. Throws on any startup-fatal condition
 * (duplicate within one origin, core-name collision, api too new, import
 * failure) — the caller reports the message and exits nonzero.
 */
export async function discoverToolModules({ repoRoot, extraPaths = [], coreNames = [] }) {
  // --- origin (a): one bounded scan of adapters/<dir>/idlefill-mcp-tools.mjs
  const adapterMods = [];
  const adaptersDir = join(repoRoot, 'adapters');
  let dirs = [];
  try {
    dirs = readdirSync(adaptersDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    /* no adapters dir: no adapter tool modules, not an error */
  }
  for (const dirName of dirs.sort()) {
    const dir = join(adaptersDir, dirName);
    const named = adapterMcpToolsField(join(dir, 'package.json'));
    const file = named ? resolve(dir, named) : join(dir, TOOL_MODULE_FILENAME);
    if (!existsSync(file)) continue;
    adapterMods.push(await loadToolModule(file));
  }

  // --- origin (b): IDLEFILL_MCP_TOOLS paths (absolute or relative to cwd).
  // A path may be a module FILE (imported directly; a missing/unreadable file
  // is a startup failure per settled decision #4) or a DIRECTORY (scanned for
  // the default module filename; no module inside simply contributes nothing —
  // this is what makes "remove the file → gone from the list" work while the
  // env entry itself stays valid).
  const envMods = [];
  for (const p of extraPaths) {
    const abs = resolve(p);
    let st = null;
    try {
      st = statSync(abs);
    } catch {
      throw new Error(`IDLEFILL_MCP_TOOLS path does not exist: ${abs}`);
    }
    if (st.isDirectory()) {
      const inner = join(abs, TOOL_MODULE_FILENAME);
      if (existsSync(inner)) envMods.push(await loadToolModule(inner));
      continue;
    }
    envMods.push(await loadToolModule(abs));
  }

  // --- duplicate detection within each origin (error naming both paths)
  const namesWithinOrigin = (mods, originLabel) => {
    const byName = new Map();
    for (const m of mods) {
      for (const t of m.tools) {
        if (byName.has(t.name)) {
          throw new Error(
            `duplicate tool name "${t.name}" from ${originLabel}: ${byName.get(t.name)} and ${m.modulePath}`,
          );
        }
        byName.set(t.name, m.modulePath);
      }
    }
    return byName;
  };
  const adapterNames = namesWithinOrigin(adapterMods, 'adapter tool modules');
  const envNames = namesWithinOrigin(envMods, 'IDLEFILL_MCP_TOOLS');

  // --- core collision: a module may not overwrite a core tool
  const core = new Set(coreNames);
  for (const [name, path] of [...adapterNames, ...envNames]) {
    if (core.has(name)) {
      throw new Error(`tool module "${path}" re-declares core tool "${name}" — core tools cannot be overridden`);
    }
  }

  // --- merge: adapter names shadow env names; deterministic sort by name
  const tools = [];
  for (const m of adapterMods) {
    for (const def of m.tools) tools.push({ def, modulePath: m.modulePath, call: m.call });
  }
  const shadowed = [];
  for (const m of envMods) {
    for (const def of m.tools) {
      if (adapterNames.has(def.name)) {
        shadowed.push({ name: def.name, winner: adapterNames.get(def.name), loser: m.modulePath });
        continue;
      }
      tools.push({ def, modulePath: m.modulePath, call: m.call });
    }
  }
  tools.sort((a, b) => (a.def.name < b.def.name ? -1 : a.def.name > b.def.name ? 1 : 0));
  return { tools, shadowed };
}
