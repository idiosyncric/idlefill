/**
 * Pure argv parsing for the idlefill dispatcher (cli.md D2/D3, issue #88).
 * The first non-flag token is the group; everything after it is passed to
 * the group untouched (passthrough discipline) — except the global
 * --json/--help flags, which the dispatcher owns.
 */

export interface Parsed {
  /** The group token (first non-flag argument), or null. */
  group: string | null;
  /** The group's subcommand (first remaining argument), or null. */
  sub: string | null;
  /** The remaining argv after the group, global flags stripped. */
  args: string[];
  /** --json — read commands render machine-readable JSON (D3). */
  json: boolean;
  /** --help / -h */
  help: boolean;
}

export function parseArgv(argv: string[]): Parsed {
  const args: string[] = [];
  let group: string | null = null;
  let json = false;
  let help = false;
  for (const tok of argv) {
    if (tok === '--json') {
      json = true;
      continue;
    }
    if (tok === '--help' || tok === '-h') {
      help = true;
      continue;
    }
    if (group === null && !tok.startsWith('-')) {
      group = tok;
      continue;
    }
    args.push(tok);
  }
  return { group, sub: args[0] ?? null, args, json, help };
}
