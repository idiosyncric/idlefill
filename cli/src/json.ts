/**
 * --json emission (cli.md D3, issue #88): every read command can print
 * machine-readable JSON. The human rendering stays the default.
 */

export function jsonPayload(data: unknown): string {
  return JSON.stringify(data, null, 2);
}
