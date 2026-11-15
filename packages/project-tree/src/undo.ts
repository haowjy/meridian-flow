import { type Actor, isSourceRoot, type TreeRecord } from "./record.js";
import { placeIn, type Setter, type TreeProjection } from "./replay.js";
import { descendantsOf, nameAmong } from "./shape.js";
import { LIVE, lastOfFamily, type View, viewRecords } from "./view.js";
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
  const record = lastOfFamily(writer.doc, asked, recordId);
  if (!record || record === "unknown" || record.type !== "delete") return false;
  return standsIn(writer.view(record.draft === null ? LIVE : asked), record);
}

/**
 * The ids of the records in force in a view's records, in order: a record is in force while no
 * later record that is itself in force undoes its root (`carries ?? id`). So an Undo takes a record
 * out of force, and a Redo (an undo of the Undo) puts it back. One pass from the end; the rule
 * `undoChange` and the Apply's copies both read.
 */
export function recordsInForce(records: readonly TreeRecord[]): Set<string> {
  const undone = new Set<string>();
  const standing = new Set<string>();
  for (const record of records.toReversed()) {
    if (undone.has(record.carries ?? record.id)) continue;
    standing.add(record.id);
    if (record.undoes !== undefined) undone.add(record.undoes);
  }
  return standing;
}

/** Whether `undoer` put back what `record` changed: an Undo drafted elsewhere may have gone elsewhere. */
function reverses(undoer: TreeRecord, record: TreeRecord): boolean {
  if (record.type === "move") {
    // A move that set a name is also undone as a rename of that name, which leaves its place.
    if (undoer.type === "rename")
      return record.name !== undefined && undoer.fromName === record.name;
    return (
      undoer.type === "move" &&
      undoer.parent === record.from.parent &&
      undoer.rank === record.from.rank
    );
  }
  if (record.type === "rename") return undoer.type === "rename" && undoer.name === record.fromName;
  return true;
}

/**
 * The record an Undo of `record` acts on: the last record in force of the chain that undid it and
 * redid it, which is the later setter of its fact. Only a chain whose every Undo put back what it
 * undid stands for `record`; otherwise `record` itself, and the Undo finds a later setter.
 */
function redoneAs(
  records: readonly TreeRecord[],
  standing: ReadonlySet<string>,
  record: TreeRecord,
): TreeRecord {
  const chain = new Map([[record.carries ?? record.id, record]]);
  let head = record;
  for (const later of records.slice(records.indexOf(record) + 1)) {
    const undone = later.undoes === undefined ? undefined : chain.get(later.undoes);
    if (!undone) continue;
    if (!reverses(later, undone)) return record;
    chain.set(later.carries ?? later.id, later);
    if (standing.has(later.id)) head = later;
  }
  return head;
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
 * force: a later record in force undid it, or its opposite already stands), or `unknown` (no such record). A move back into a folder
 * in Trash needs no answer: the node stands in it, and rule 3 keeps the folder standing.
 * A drafted change an Apply landed is taken back in live, where its copy now stands: the
 * opposite record's `draft` says which view it went to. A change that was undone and redone is
 * taken back by undoing the Redo (`redoneAs`).
 */
export function undoChange(
  writer: TreeWriter,
  asked: View,
  actor: Actor,
  recordId: string,
): TreeRecord | NotUndone {
  const named = lastOfFamily(writer.doc, asked, recordId);
  if (named === "unknown") return named;
  if (!named) return "already";
  const view = named.draft === null ? LIVE : asked;
  const records = viewRecords(writer.doc, view);
  const standing = recordsInForce(records);
  if (!standing.has(named.id)) return "already";
  const record = redoneAs(records, standing, named);
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
        const named =
          record.name === undefined
            ? undefined
            : lastSetBy(projection.setters.get(record.node)?.label, record);
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
            ...(named
              ? { name: named.before.name }
              : arrives === node.name
                ? {}
                : { name: arrives }),
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
