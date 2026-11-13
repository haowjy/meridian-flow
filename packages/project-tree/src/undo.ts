import { type Actor, isSourceRoot, recordsOf, type TreeRecord } from "./record.js";
import { descendantsOf } from "./shape.js";
import { type View, viewRecords } from "./view.js";
import type { TreeWriter } from "./writer.js";

/**
 * Undo of one change in the view it belongs to: appends the opposite record (move back to
 * `from`, rename back to `fromName`, restore what was deleted, delete what was created). Refused
 * as "superseded" when something later changed the same fact, or when the folder a move would
 * return to is in Trash.
 */
export function undoRecord(
  writer: TreeWriter,
  view: View,
  actor: Actor,
  recordId: string,
): TreeRecord | "superseded" | "unknown" {
  const record = recordsOf(writer.doc)
    .toArray()
    .find((candidate) => candidate.id === recordId);
  if (!record) return "unknown";
  const projection = writer.view(view);
  const node = projection.nodes.get(record.node);
  if (!node) return "superseded";
  const extra = { undoes: record.id };
  switch (record.type) {
    case "create":
      if (node.trashed) return "superseded";
      return writer.author(
        view,
        actor,
        { type: "delete", node: record.node, cascade: descendantsOf(projection, record.node) },
        extra,
      );
    case "move": {
      if (node.parent !== record.parent || node.rank !== record.rank) return "superseded";
      if (!record.from.rank) return "superseded";
      const back = projection.nodes.get(record.from.parent);
      if (back?.trashed || (!back && !isSourceRoot(record.from.parent))) return "superseded";
      return writer.author(
        view,
        actor,
        {
          type: "move",
          node: record.node,
          parent: record.from.parent,
          rank: record.from.rank,
          from: { parent: record.parent, rank: record.rank },
        },
        extra,
      );
    }
    case "rename":
      if (node.name !== record.name) return "superseded";
      return writer.author(
        view,
        actor,
        { type: "rename", node: record.node, name: record.fromName, fromName: record.name },
        extra,
      );
    case "delete": {
      // Already lifted, by a restore of the node or by an earlier Undo of this delete.
      const records = viewRecords(writer.doc, view);
      const at = records.findIndex(
        (other) => other.id === record.id || other.appliedFrom === record.id,
      );
      const lifted = records
        .slice(at + 1)
        .some(
          (other) =>
            other.type === "restore" &&
            other.node === record.node &&
            (other.undoes === undefined || other.undoes === record.id),
        );
      if (at < 0 || lifted) return "superseded";
      return writer.author(view, actor, { type: "restore", node: record.node }, extra);
    }
    case "restore":
      if (node.trashed) return "superseded";
      return writer.author(
        view,
        actor,
        { type: "delete", node: record.node, cascade: descendantsOf(projection, record.node) },
        extra,
      );
    case "purge":
      return "superseded";
  }
}
