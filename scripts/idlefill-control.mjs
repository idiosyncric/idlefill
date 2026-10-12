#!/usr/bin/env node
/**
 * Shim (issue #88, cli.md D2): the arbiter control CLI now lives in the
 * cli/ workspace and runs as `idlefill control …`. This file keeps the old
 * path working for every citation and piece of muscle memory: it execs the
 * workspace entry with the `control` group prepended and passes the
 * remaining argv through untouched. Auth posture is unchanged — the token
 * is read AT RUNTIME from the gitignored config, never from argv.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(repo, 'cli', 'dist', 'index.js');
const tsx = join(repo, 'node_modules', '.bin', 'tsx');
const src = join(repo, 'cli', 'src', 'index.ts');

let argv;
if (existsSync(dist)) argv = [process.execPath, [dist, 'control', ...process.argv.slice(2)]];
else if (existsSync(tsx)) argv = [tsx, [src, 'control', ...process.argv.slice(2)]];
else {
  console.error('idlefill-control: cli/ entry not found — run `npm install && npm run build` at the repo root');
  process.exit(1);
}
const r = spawnSync(argv[0], argv[1], { stdio: 'inherit' });
process.exit(r.status ?? 1);
