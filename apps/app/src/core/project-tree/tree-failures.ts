/**
 * What the server dropped of the writer's own creates, read from the list: a record's state is
 * its last settlement, and a `dropped` create (its Work or source was closed) says why. The node
 * shows nowhere else; the repair is the create again where the writer asked for it.
 */
import {
  isSourceRoot,
  lastSettlements,
  listRecords,
  sourceIdOf,
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
  const failures = new Map<string, TreeFailure>();
  for (const record of listRecords(doc)) {
    if (record.actor !== actor || record.draft !== view.draft) continue;
    const settlement = settled.get(record.id);
    if (record.type !== "create" || settlement?.to !== "dropped") {
      failures.delete(record.node);
      continue;
    }
    if (dismissed.has(record.id)) continue;
    failures.set(record.node, {
      namespaceFailure: "create",
      ...(settlement.reason ? { failureReason: settlement.reason } : {}),
      namespaceRepairName: record.name,
      namespaceRepairMove: { parentId: placeOf(record.parent) },
      ...(seenAt(record.id) === undefined ? {} : { namespaceFailureAt: seenAt(record.id) }),
      failureRecord: record.id,
    });
  }
  return failures;
}
