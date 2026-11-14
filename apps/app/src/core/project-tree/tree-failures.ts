/**
 * What the server refused of the writer's own records, read from the list: a record's state is
 * its last settlement, and a refused one says why. A create the server kept in Unfiled has a
 * kept create after it (its `replaces` names the refused one), so the node stands where the
 * server put it with the failure beside it, and the repair is the move the writer asked for.
 */
import {
  isSourceRoot,
  lastSettlements,
  listRecords,
  sourceIdOf,
  type TreeRecord,
  type View,
} from "@meridian/project-tree";
import type * as Y from "yjs";
import type { TreeFailure } from "./tree-view";

const placeOf = (parent: string) => (isSourceRoot(parent) ? sourceIdOf(parent) : parent);

/**
 * The writer's failures by node, for records made in `view`'s own branch. A later record of the
 * writer's on the node that the server did not refuse ends the failure: that is the repair.
 */
export function treeFailures(
  doc: Y.Doc,
  actor: string,
  dismissed: ReadonlySet<string>,
  seenAt: (record: string) => number | undefined,
  view: View,
): Map<string, TreeFailure> {
  const settled = lastSettlements(doc);
  const records = listRecords(doc);
  const byId = new Map(records.map((record) => [record.id, record]));
  const failures = new Map<string, TreeFailure>();
  const fail = (record: TreeRecord, as: TreeFailure["namespaceFailure"], at: TreeRecord) => {
    if (dismissed.has(record.id)) return;
    const reason = settled.get(record.id)?.reason;
    failures.set(record.node, {
      namespaceFailure: as,
      ...(reason ? { failureReason: reason } : {}),
      ...(record.type === "rename" || record.type === "create"
        ? { namespaceRepairName: record.name }
        : {}),
      ...(record.type === "move" || record.type === "create"
        ? { namespaceRepairMove: { parentId: placeOf(record.parent) } }
        : {}),
      ...(seenAt(at.id) === undefined ? {} : { namespaceFailureAt: seenAt(at.id) }),
      failureRecord: record.id,
    });
  };
  for (const record of records) {
    if (record.actor !== actor || record.draft !== view.draft) continue;
    const kept =
      record.type === "create" && record.replaces ? byId.get(record.replaces) : undefined;
    if (kept && settled.get(kept.id)?.to === "refused") {
      fail(kept, "create", record);
      continue;
    }
    if (settled.get(record.id)?.to === "refused") {
      if (record.type === "create") continue; // its kept create, a record after it, says it
      fail(record, record.type === "delete" ? "delete" : "set-location", record);
      continue;
    }
    failures.delete(record.node);
  }
  return failures;
}
