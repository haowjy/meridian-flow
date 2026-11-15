/**
 * Who settled an item's tree records last: the one read that says whether an item an Apply or a
 * Discard found with nothing pending was applied or discarded, and by which command. Apply
 * answers `already` or `overtaken` from it; Discard's per-item answer reads the same, so a
 * Discard that took the records can never be reported as "already applied".
 */
import { lastSettlements, listRecords, type Settlement, settleLogOf } from "@meridian/project-tree";
import type * as Y from "yjs";

export type LastSettlement = { kind: "applied" | "discarded"; command: string };

/**
 * The reader for one Work's records in a list copy, built once for all of a command's items. A
 * node's records are those made on it and the deletes that cover it (`cascade`). Null: nothing
 * of the node was ever drafted here, or its last settlement names no command (a record the
 * server dropped at admission).
 */
export function lastSettlementOf(
  doc: Y.Doc,
  branchId: string,
): (node: string) => LastSettlement | null {
  const last = lastSettlements(doc);
  const order = new Map(
    settleLogOf(doc)
      .toArray()
      .map((settle, at) => [settle.id, at]),
  );
  const byNode = new Map<string, LastSettlement & { at: number }>();
  const kindOf = (to: Settlement | "pending"): LastSettlement["kind"] | null =>
    to === "discarded" ? "discarded" : to === "applied" || to === "superseded" ? "applied" : null;
  for (const record of listRecords(doc)) {
    if (record.draft !== branchId) continue;
    const settle = last.get(record.id);
    const kind = settle && kindOf(settle.to);
    if (!settle?.command || !kind) continue;
    const at = order.get(settle.id) ?? -1;
    const nodes = record.type === "delete" ? [record.node, ...record.cascade] : [record.node];
    for (const node of nodes) {
      const seen = byNode.get(node);
      if (!seen || seen.at < at) byNode.set(node, { kind, command: settle.command, at });
    }
  }
  return (node) => {
    const found = byNode.get(node);
    return found ? { kind: found.kind, command: found.command } : null;
  };
}
