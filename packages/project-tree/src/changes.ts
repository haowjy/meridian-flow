import type { TreeRecord } from "./record.js";
import type { SkipReason, TreeProjection } from "./replay.js";
import { draftRows, projectedRows } from "./rows.js";

export type LandingFault = { kind: "inside-itself"; into: string } | { kind: "gone" };

const GONE: ReadonlySet<SkipReason> = new Set([
  "missing-node",
  "missing-parent",
  "parent-not-folder",
  "purged",
]);

export function landingFaults(
  work: TreeProjection,
  pending: readonly TreeRecord[],
): Map<string, LandingFault> {
  const byId = new Map(pending.map((record) => [record.id, record]));
  const faults = new Map<string, LandingFault>();
  for (const { record: id, reason } of work.skipped) {
    const record = byId.get(id);
    if (!record) continue;
    if (reason === "cycle" && record.type === "move")
      faults.set(record.node, {
        kind: "inside-itself",
        into: work.nodes.get(record.parent)?.name ?? "",
      });
    else if (GONE.has(reason)) faults.set(record.node, { kind: "gone" });
  }
  return faults;
}

export function changedFolders(
  live: TreeProjection,
  work: TreeProjection,
  pending: readonly TreeRecord[],
  faults: ReadonlyMap<string, LandingFault> = landingFaults(work, pending),
): Set<string> {
  const differing = draftRows(projectedRows(live), projectedRows(work), pending);
  const folders = new Set<string>();
  for (const { node } of pending) {
    if (work.nodes.get(node)?.kind !== "folder") continue;
    const row = differing.get(node);
    if (row?.changed ? !(row.existsOnlyInDraft && row.deleted) : faults.has(node))
      folders.add(node);
  }
  return folders;
}
