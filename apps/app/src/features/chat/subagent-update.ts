/** Runtime boundary for durable `subagent_update` notification metadata. */
export type SubagentUpdateMetadata = {
  kind: "subagent_update";
  handle: string;
  execution: string | null;
  outcome: "succeeded" | "failed" | "cancelled";
};

export function readSubagentUpdateMetadata(value: unknown): SubagentUpdateMetadata | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const metadata = value as Record<string, unknown>;
  if (
    metadata.kind !== "subagent_update" ||
    typeof metadata.handle !== "string" ||
    !["succeeded", "failed", "cancelled"].includes(String(metadata.outcome))
  )
    return null;
  return {
    kind: "subagent_update",
    handle: metadata.handle,
    execution: typeof metadata.execution === "string" ? metadata.execution : null,
    outcome: metadata.outcome as SubagentUpdateMetadata["outcome"],
  };
}

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
