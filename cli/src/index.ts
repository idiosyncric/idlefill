#!/usr/bin/env node
/**
 * The idlefill operator CLI — one dispatcher (cli.md D2, issue #88 S1).
 *
 *   idlefill <group> [command] [flags]
 *
 * daemon/control are live passthrough groups (behavior byte-identical to
 * scripts/idlefill-daemon.mjs / scripts/idlefill-control.mjs, which are now
 * thin shims onto this entry). engine (#90), mesh (#91) and agent (#92)
 * are live; update is registered for S2 (#89) and refuses by name until
 * its slice lands.
 *
 * Exit codes: 0 ok · 1 action failed · 2 usage.
 * Auth posture (D3): the arbiter token is read AT RUNTIME from the
 * gitignored config — never from a command line, never printed.
 */

import { parseArgv } from './argv.js';
import { dispatch, EXIT_OK, EXIT_USAGE, GROUPS, notImplementedNote } from './dispatch.js';
import { groupHelp, topHelp } from './help.js';
import { runAgent } from './agent.js';
import { runDaemon } from './daemon.js';
import { runControl } from './control.js';
import { runEngine } from './engine.js';
import { runMesh } from './mesh.js';

export async function main(argv: string[]): Promise<number> {
  const parsed = parseArgv(argv);
  const d = dispatch(parsed);

  if (d.kind === 'no-group') {
    console.log(topHelp());
    return parsed.help ? EXIT_OK : EXIT_USAGE;
  }

  if (d.kind === 'unknown-group') {
    console.error(`idlefill: unknown group "${d.group}" — run \`idlefill --help\` for the group list`);
    return EXIT_USAGE;
  }

  if (parsed.help) {
    console.log(groupHelp(d.group));
    return EXIT_OK;
  }

  const spec = GROUPS[d.group];
  if (!spec.implemented) {
    console.error(notImplementedNote(spec));
    return EXIT_USAGE;
  }

  if (d.group === 'daemon') return runDaemon(parsed.args, parsed.json);
  if (d.group === 'engine') return runEngine(parsed.args, parsed.json);
  if (d.group === 'mesh') return runMesh(parsed.args, parsed.json);
  if (d.group === 'agent') return runAgent(parsed.args, parsed.json);
  return runControl(parsed.args, parsed.json);
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (err) {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exitCode = 1;
}
