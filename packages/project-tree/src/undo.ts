import { type Actor, isSourceRoot, type TreeRecord } from "./record.js";
import type { Setter } from "./replay.js";
import { descendantsOf } from "./shape.js";
import { listRecords, type View, viewRecords } from "./view.js";
import type { TreeWriter } from "./writer.js";

/** Whether the record is the one that last set the fact `setter` stands for (a live copy answers to its drafted record's id too). */
const lastSetBy = <Before>(setter: Setter<Before> | undefined, record: TreeRecord) =>
  setter !== undefined && (setter.id === record.id || setter.appliedFrom === record.id)
    ? setter
    : undefined;

/**
 * Undo of one change in the view it belongs to: appends the opposite record (move back, rename
 * back, restore what was deleted, delete what was created). A move or rename goes back to the
 * values its fact had just before the record, and is allowed only while the record is still
 * the one that last set it: by history, never by comparing today's value, which a later author
 * may have set to the same. Refused as "superseded" when something later changed the same
 * fact, or when the folder a move would return to is in Trash.
 */
export function undoChange(
  writer: TreeWriter,
  view: View,
  actor: Actor,
  recordId: string,
): TreeRecord | "superseded" | "unknown" {
  const record = listRecords(writer.doc).find((candidate) => candidate.id === recordId);
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
