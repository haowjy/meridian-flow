import { type Actor, isSourceRoot, type TreeRecord } from "./record.js";
import { placeIn, type Setter } from "./replay.js";
import { descendantsOf } from "./shape.js";
import { inForce, type View, viewRecords } from "./view.js";
import type { TreeWriter } from "./writer.js";

/** Whether the record is the one that last set the fact `setter` stands for. */
const lastSetBy = <Before>(setter: Setter<Before> | undefined, record: TreeRecord) =>
  setter?.id === record.id ? setter : undefined;

/** Whether a later record in the view moved or renamed the same node as this kind of record. */
function movedAfter(writer: TreeWriter, view: View, record: TreeRecord): boolean {
  const records = viewRecords(writer.doc, view);
  return records
    .slice(records.findIndex((other) => other.id === record.id) + 1)
    .some((other) => other.type === record.type && other.node === record.node);
}

/**
 * Undo of one change in the view it belongs to: appends the opposite record (move back, rename
 * back, restore what was deleted, delete what was created). A move or rename goes back to the
 * values its fact had just before the record, and is allowed only while the record is still
 * the one that last set it: by history, never by comparing today's value, which a later author
 * may have set to the same. Refused as "superseded" when something later changed the same
 * fact, when the folder a move would return to is in Trash, or when the node is gone from the
 * view (purged, or its create is not in force), where the replay would skip the opposite record.
 */
export function undoChange(
  writer: TreeWriter,
  view: View,
  actor: Actor,
  recordId: string,
): TreeRecord | "superseded" | "unknown" {
  const record = inForce(writer.doc, view, recordId);
  if (record === "unknown") return record;
  if (!record) return "superseded";
  const projection = writer.view(view);
  const node = placeIn(projection.nodes, record.node);
  if (!node) return "superseded";
  const extra = { undoes: record.carries ?? record.id };
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
      if (record.undoes !== undefined) {
        // An Undo's own move taken back is a redo: the original move again, unless the node was moved since.
        if (movedAfter(writer, view, record)) return "superseded";
        const { parent, rank } = record.from;
        const back = projection.nodes.get(parent);
        if (back?.trashed || (!back && !isSourceRoot(parent))) return "superseded";
        return writer.author(view, actor, {
          type: "move",
          node: record.node,
          parent,
          rank,
          from: { parent: node.parent, rank: node.rank },
        });
      }
      const last = lastSetBy(projection.setters.get(record.node)?.place, record);
      if (!last) return "superseded";
      const { parent, rank } = last.before;
      const back = projection.nodes.get(parent);
      if (back?.trashed || (!back && !isSourceRoot(parent))) return "superseded";
      return writer.author(
        view,
        actor,
        {
          type: "move",
          node: record.node,
          parent,
          rank,
          from: { parent: node.parent, rank: node.rank },
        },
        extra,
      );
    }
    case "rename": {
      if (record.undoes !== undefined) {
        // The same for a rename: the Undo's name taken back is the original name again. An Undo of
        // a type change does not say the type it changed from, so it is not redone.
        if (record.filetype !== undefined || movedAfter(writer, view, record)) return "superseded";
        return writer.author(view, actor, {
          type: "rename",
          node: record.node,
          name: record.fromName,
          fromName: node.name,
        });
      }
      const last = lastSetBy(projection.setters.get(record.node)?.label, record);
      if (!last) return "superseded";
      // A rename that changed the type takes the type back with the name, or it is not undone.
      if (record.filetype !== undefined && last.before.filetype === undefined) return "superseded";
      return writer.author(
        view,
        actor,
        {
          type: "rename",
          node: record.node,
          name: last.before.name,
          fromName: node.name,
          ...(record.filetype !== undefined ? { filetype: last.before.filetype } : {}),
        },
        extra,
      );
    }
    case "delete": {
      // Already lifted, by a restore of the node or by an earlier Undo of this delete.
      const records = viewRecords(writer.doc, view);
      const at = records.findIndex((other) => other.id === record.id);
      const lifted = records
        .slice(at + 1)
        .some(
          (other) =>
            other.type === "restore" &&
            other.node === record.node &&
            (other.undoes === undefined || other.undoes === extra.undoes),
        );
      if (lifted) return "superseded";
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
