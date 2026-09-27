/** Runtime boundary for durable `subagent_update` notification metadata. */
import {
  parseSubagentUpdateMetadata,
  type SubagentUpdateMetadata,
} from "@meridian/contracts/spawn";

export type { SubagentUpdateMetadata } from "@meridian/contracts/spawn";

export const readSubagentUpdateMetadata = parseSubagentUpdateMetadata;

/** Merge only contiguous completion notices; any other delivery breaks a group. */
export function groupAdjacentSubagentUpdates<
  T extends { subagentUpdate: SubagentUpdateMetadata | null },
>(events: readonly T[]): T[][] {
  const groups: T[][] = [];
  for (const event of events) {
    const current = groups.at(-1);
    if (event.subagentUpdate && current?.[0]?.subagentUpdate) current.push(event);
    else groups.push([event]);
  }
  return groups;
}
