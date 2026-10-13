/**
 * Group registry + routing table (cli.md D2, issue #88 S1).
 * daemon/control are live passthrough groups (behavior byte-identical to
 * the scripts they wrap); update is live since S2 (#89), engine since S3
 * (#90), mesh since S4 (#91) and agent since S5 (#92) — every group is
 * implemented.
 */

import type { Parsed } from './argv.js';

export const EXIT_OK = 0;
export const EXIT_FAIL = 1;
export const EXIT_USAGE = 2;

export type GroupId = 'update' | 'mesh' | 'engine' | 'agent' | 'daemon' | 'control';

export interface GroupSpec {
  id: GroupId;
  summary: string;
  implemented: boolean;
  slice?: string;
  issue?: number;
}

export const GROUP_ORDER: GroupId[] = ['update', 'mesh', 'engine', 'agent', 'daemon', 'control'];

export const GROUPS: Record<GroupId, GroupSpec> = {
  update: {
    id: 'update',
    summary: 'update this checkout/app to the latest release',
    implemented: true,
    slice: 'S2',
    issue: 89,
  },
  mesh: {
    id: 'mesh',
    summary: 'mesh status / join / leave / pair',
    implemented: true,
    slice: 'S4',
    issue: 91,
  },
  engine: {
    id: 'engine',
    summary: 'inference-engine inventory: list / add / set / remove',
    implemented: true,
    slice: 'S3',
    issue: 90,
  },
  agent: {
    id: 'agent',
    summary: 'connected/discovered agents: list / connect / disconnect',
    implemented: true,
    slice: 'S5',
    issue: 92,
  },
  daemon: {
    id: 'daemon',
    summary: 'control + troubleshoot the client daemon',
    implemented: true,
  },
  control: {
    id: 'control',
    summary: 'operator controls for the arbiter',
    implemented: true,
  },
};

export function isGroupId(token: string): token is GroupId {
  return Object.prototype.hasOwnProperty.call(GROUPS, token);
}

export type Dispatch =
  | { kind: 'group'; group: GroupId }
  | { kind: 'no-group' }
  | { kind: 'unknown-group'; group: string };

export function dispatch(parsed: Parsed): Dispatch {
  if (parsed.group === null) return { kind: 'no-group' };
  if (isGroupId(parsed.group)) return { kind: 'group', group: parsed.group };
  return { kind: 'unknown-group', group: parsed.group };
}

export function notImplementedNote(spec: GroupSpec): string {
  return `idlefill ${spec.id}: not implemented yet — lands in ${spec.slice} (issue #${spec.issue})`;
}
