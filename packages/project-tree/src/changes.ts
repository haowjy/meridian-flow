import type { TreeRecord } from "./record.js";
import type { SkipReason, TreeProjection } from "./replay.js";
import { branchRows, projectedRows } from "./rows.js";

/** Why a pending change cannot land: the replay skips it. */
export type LandingFault = { kind: "inside-itself"; into: string } | { kind: "gone" };

const GONE: ReadonlySet<SkipReason> = new Set([
  "missing-node",
  "missing-parent",
  "parent-not-folder",
  "purged",
]);

/** Each node's fault among the Work's pending records. */
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
        into: work.nodes.get(record.parent)?.displayName ?? "",
      });
    else if (GONE.has(reason)) faults.set(record.node, { kind: "gone" });
  }
  return faults;
}

/**
 * The folders a Work changes: the one rule behind the review count, the Changes list's rows and
 * the server's stored count. A folder is a change when the Work's view shows it differently from
 * live, or when one of its pending records cannot land (a skipped move leaves no difference, and
 * the writer still has to see why). A folder made and deleted in the Work, or moved and moved
 * back, is no change: Undo of a drafted change leaves its records and no difference.
 */
export function changedFolders(
  live: TreeProjection,
  work: TreeProjection,
  pending: readonly TreeRecord[],
  faults: ReadonlyMap<string, LandingFault> = landingFaults(work, pending),
): Set<string> {
  const differing = branchRows(projectedRows(live), projectedRows(work), pending);
  const folders = new Set<string>();
  for (const { node } of pending) {
    if (work.nodes.get(node)?.kind !== "folder") continue;
    const row = differing.get(node);
    if (row ? !(row.existsOnlyInDraft && row.deleted) : faults.has(node)) folders.add(node);
  }
  return folders;
}
