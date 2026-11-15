import { type Actor, isSourceRoot, type TreeRecord } from "./record.js";
import { placeIn, type Setter, type TreeProjection } from "./replay.js";
import { descendantsOf, nameAmong } from "./shape.js";
import { inForce, LIVE, type View, viewRecords } from "./view.js";
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
 * What a restore brought back below its node: the nodes whose place was last set before the
 * restore. What was put in the folder after it (a create or a move into it) is not the restore's.
 */
function liftedBy(writer: TreeWriter, view: View, projection: TreeProjection, record: TreeRecord) {
  const order = new Map<string, number>();
  const created = new Map<string, number>();
  for (const [at, other] of viewRecords(writer.doc, view).entries()) {
    order.set(other.id, at);
    if (other.type === "create") created.set(other.node, at);
  }
  const at = order.get(record.id) ?? 0;
  return descendantsOf(projection, record.node).filter((id) => {
    if (projection.nodes.get(id)?.trashed) return false;
    const placed = projection.setters.get(id)?.place?.id;
    const arrived = Math.max(
      created.get(id) ?? -1,
      placed === undefined ? -1 : (order.get(placed) ?? -1),
    );
    return arrived < at;
  });
}

/** Whether the delete record, or the original an Undo's copy carries, still stands in the projection. */
const standsIn = (projection: TreeProjection, record: TreeRecord) =>
  projection.standingDeletes.has(record.id) ||
  projection.standingDeletes.has(record.carries ?? record.id);

/**
 * Whether the delete `recordId` can still be undone: its Trash entry survives in the view (not
 * lifted by a restore of any of its nodes, an Undo or a purge). The fact `undoChange` reads.
 */
export function deleteStands(writer: TreeWriter, asked: View, recordId: string): boolean {
  const record = inForce(writer.doc, asked, recordId);
  if (!record || record === "unknown" || record.type !== "delete") return false;
  return standsIn(writer.view(record.draft === null ? LIVE : asked), record);
}

/** Why an Undo appended nothing, in the words of the results that report it. */
export type NotUndone = "changed_since" | "purged" | "already" | "unknown";

/**
 * Undo of one change in the view it belongs to: appends the opposite record (move back, rename
 * back, restore what was deleted, delete what was created). A move or rename goes back to the
 * values its fact had just before the record, and is allowed only while the record is still
 * the one that last set it: by history, never by comparing today's value, which a later author
 * may have set to the same. A move that also set a name takes back whichever of its two facts it
 * still holds (a move without the name, or a rename). The answer when it appends nothing: `changed_since` (something later
 * changed the same fact), `purged` (the node, or the folder a move would return to, is gone from
 * the view, where the replay would skip the opposite record), `already` (the change is not in
 * force, or its opposite already stands), or `unknown` (no such record). A move back into a folder
 * in Trash needs no answer: the node stands in it, and rule 3 keeps the folder standing.
 * A drafted change an Apply landed is taken back in live, where its copy now stands: the
 * opposite record's `draft` says which view it went to. With `keepInAsked` it goes to the asked
 * view instead (a draft that holds the node live now has), for a place where nothing may change
 * live without the draft's review.
 */
export function undoChange(
  writer: TreeWriter,
  asked: View,
  actor: Actor,
  recordId: string,
  options: { keepInAsked?: boolean } = {},
): TreeRecord | NotUndone {
  const record = inForce(writer.doc, asked, recordId);
  if (record === "unknown") return record;
  if (!record) return "already";
  const view = record.draft === null && !options.keepInAsked ? LIVE : asked;
  const projection = writer.view(view);
  const node = placeIn(projection.nodes, record.node);
  if (!node) return "purged";
  const extra = { undoes: record.carries ?? record.id };
  switch (record.type) {
    case "create":
      if (node.trashed) return "already";
      // Only the node the create made: what others put in a folder since stands, and keeps it standing.
      return writer.author(view, actor, { type: "delete", node: record.node, cascade: [] }, extra);
    case "move": {
      if (record.undoes !== undefined) {
        // An Undo's own move taken back is a redo: the original move again, unless the node was moved since.
        if (movedAfter(writer, view, record)) return "changed_since";
        const { parent, rank } = record.from;
        const back = projection.nodes.get(parent);
        if (back?.purged || (!back && !isSourceRoot(parent))) return "purged";
        // Back at the place the original went to, under the name that place shows free.
        const arrives = nameAmong(projection, parent, node.kind, node.name, node.id);
        return writer.author(
          view,
          actor,
          {
            type: "move",
            node: record.node,
            parent,
            rank,
            from: { parent: node.parent, rank: node.rank },
            ...(arrives === node.name ? {} : { name: arrives }),
          },
          extra,
        );
      }
      // A move that carried a name set two facts, and each goes back while the move still holds
      // it: a later rename keeps its name and the place still goes back, and the other way round.
      const placed = lastSetBy(projection.setters.get(record.node)?.place, record);
      const named =
        record.name === undefined
          ? undefined
          : lastSetBy(projection.setters.get(record.node)?.label, record);
      if (!placed && !named) return "changed_since";
      if (!placed && named)
        return writer.author(
          view,
          actor,
          { type: "rename", node: record.node, name: named.before.name, fromName: node.name },
          extra,
        );
      const { parent, rank } = (placed as NonNullable<typeof placed>).before;
      const back = projection.nodes.get(parent);
      if (back?.purged || (!back && !isSourceRoot(parent))) return "purged";
      return writer.author(
        view,
        actor,
        {
          type: "move",
          node: record.node,
          parent,
          rank,
          from: { parent: node.parent, rank: node.rank },
          ...(named ? { name: named.before.name } : {}),
        },
        extra,
      );
    }
    case "rename": {
      if (record.undoes !== undefined) {
        // The same for a rename: the Undo's name taken back is the original name again. An Undo of
        // a type change does not say the type it changed from, so it is not redone.
        if (record.filetype !== undefined || movedAfter(writer, view, record))
          return "changed_since";
        return writer.author(
          view,
          actor,
          { type: "rename", node: record.node, name: record.fromName, fromName: node.name },
          extra,
        );
      }
      const last = lastSetBy(projection.setters.get(record.node)?.label, record);
      if (!last) return "changed_since";
      // A rename that changed the type takes the type back with the name, or it is not undone.
      if (record.filetype !== undefined && last.before.filetype === undefined)
        return "changed_since";
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
      // Lifted already, by a restore of the node or by an earlier Undo of this delete.
      if (!standsIn(projection, record)) return "already";
      return writer.author(view, actor, { type: "restore", node: record.node }, extra);
    }
    case "restore":
      if (node.trashed) return "already";
      return writer.author(
        view,
        actor,
        { type: "delete", node: record.node, cascade: liftedBy(writer, view, projection, record) },
        extra,
      );
    case "purge":
      return "purged";
  }
}
