import { type Actor, isSourceRoot, type TreeRecord, type TreeRecordInput } from "./record.js";
import {
  type Change,
  labelOf,
  type NodeHistory,
  placeIn,
  type Sets,
  standingOf,
  type TreeNode,
  type TreeProjection,
  withTurned,
  wouldLoop,
} from "./replay.js";
import { descendantsOf } from "./shape.js";
import { LIVE, lastOfFamily, type View, viewRecords } from "./view.js";
import type { TreeWriter } from "./writer.js";

/**
 * What a restore brought back below its node: the nodes whose place was last set before the
 * restore. What was put in the folder after it (a create or a move into it) is not the restore's.
 */
function liftedBy(projection: TreeProjection, record: TreeRecord) {
  const at = projection.changes.get(record.id)?.index ?? 0;
  return descendantsOf(projection, record.node).filter((id) => {
    if (projection.nodes.get(id)?.trashed) return false;
    const history = projection.history.get(id);
    return Math.max(history?.createdAt ?? -1, history?.place.at(-1)?.index ?? -1) < at;
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

/** A move's fact that stays where a later change holds it, when its Undo turns the other. */
export type Kept = "name" | "place";

/**
 * The Undo of `named`, a move or rename or an Undo about one. Taking `named` out flips which
 * records about its change are in force (`flips`, as the replay will read them): the change goes
 * out or comes back, or nothing flips but `named`, when another Undo keeps the change out. Then the
 * record changes nothing shown, and is written all the same, so `named` stays out when that other
 * Undo is taken back. The record says what the node then shows, as this copy has it; the replay
 * works that out again from the records in force, so a copy that had not seen an earlier change
 * settles on the same tree. It is a move when the place turns, a rename when only the name does
 * (Trash reads that: a rename leaves what the move lifted lifted), else of the change's type.
 * `kept` names a fact of a move that set a name which a later change holds, when it turns the
 * other.
 */
function turn(
  writer: TreeWriter,
  view: View,
  actor: Actor,
  projection: TreeProjection,
  history: NodeHistory,
  node: TreeNode,
  base: Change & { sets: Sets },
  flips: readonly Change[],
  undoes: string,
): { record: TreeRecord; kept?: Kept } | NotUndone {
  let place = history.place;
  let label = history.label;
  for (const each of flips)
    if (each.sets && each.node === node.id) {
      place = withTurned(place, each.sets.place, !each.inForce);
      label = withTurned(label, each.sets.label, !each.inForce);
    }
  const placed = place.at(-1) !== history.place.at(-1);
  const named = label.at(-1) !== history.label.at(-1);
  if (flips.length > 0 && !placed && !named) return "changed_since";
  const both = base.sets.place !== undefined && base.sets.label !== undefined;
  const shows = labelOf(node.kind, history.born, label);
  const extra = { undoes };
  if (!placed && (named || !base.sets.place))
    return {
      record: writer.prepare(
        view,
        actor,
        {
          type: "rename",
          node: node.id,
          name: shows.name,
          fromName: node.name,
          ...(shows.filetype && shows.filetype !== node.filetype
            ? { filetype: shows.filetype }
            : {}),
        },
        extra,
      ),
      ...(both && named ? { kept: "place" as const } : {}),
    };
  const { parent, rank } = place.at(-1)?.says ?? history.born;
  if (placed) {
    const back = projection.nodes.get(parent);
    if (back?.purged || (!back && !isSourceRoot(parent))) return "purged";
    // The folder it would return to has gone inside it since: the replay would skip the record.
    if (wouldLoop(projection.nodes, node.id, parent)) return "changed_since";
  }
  return {
    record: writer.prepare(
      view,
      actor,
      {
        type: "move",
        node: node.id,
        parent,
        rank,
        from: { parent: node.parent, rank: node.rank },
        ...(named && shows.name !== node.name ? { name: shows.name } : {}),
      },
      extra,
    ),
    ...(both && placed && !named ? { kept: "name" as const } : {}),
  };
}

/**
 * The record an Undo of a create, delete or restore acts on: the last record in force of the
 * chain that undid it and redid it.
 */
function redoneAs(
  records: readonly TreeRecord[],
  standing: ReadonlySet<string>,
  record: TreeRecord,
): TreeRecord {
  const chain = new Set([record.carries ?? record.id]);
  let head = record;
  for (const later of records.slice(records.indexOf(record) + 1)) {
    if (later.undoes === undefined || !chain.has(later.undoes)) continue;
    chain.add(later.carries ?? later.id);
    if (standing.has(later.id)) head = later;
  }
  return head;
}

/** Why an Undo appended nothing, in the words of the results that report it. */
export type NotUndone = "changed_since" | "purged" | "already" | "unknown";

/**
 * Undo of one change in the view it belongs to: appends the opposite record (move back, rename
 * back, restore what was deleted, delete what was created). Every record is in force unless a
 * later record in force undoes it (`standingOf`), and Undo answers `already` for one that is not.
 * A move or rename, and any Undo about one, goes by what taking it out does to the change it is
 * about (`turn`): `changed_since` when a later change in force holds every fact that would turn,
 * or the place it would go back to is inside the node now, and nothing is written then. A create,
 * delete or restore goes by the record in force: `already` when its opposite already stands; a
 * change that was undone and redone is taken back by undoing the Redo (`redoneAs`). `purged`:
 * the node, or the folder a move would return to, is gone from the view, where the replay would
 * skip the opposite record. `unknown`: no such record. A move back into a folder in Trash needs
 * no answer: the node stands in it, and rule 3 keeps the folder standing. A drafted change an
 * Apply landed is taken back in live, where its copy now stands: the opposite record's `draft`
 * says which view it went to.
 */
export function undoChange(
  writer: TreeWriter,
  asked: View,
  actor: Actor,
  recordId: string,
): TreeRecord | NotUndone {
  const done = undoFacts(writer, asked, actor, recordId);
  if (typeof done === "string") return done;
  writer.append(done.record);
  return done.record;
}

/** `undoChange`, saying which fact of a move that set a name stays (`kept`), when one does. */
export function undoFacts(
  writer: TreeWriter,
  asked: View,
  actor: Actor,
  recordId: string,
): { record: TreeRecord; kept?: Kept } | NotUndone {
  const named = lastOfFamily(writer.doc, asked, recordId);
  if (named === "unknown") return named;
  if (!named) return "already";
  const view = named.draft === null ? LIVE : asked;
  const projection = writer.view(view);
  if (!projection.inForce.has(named.id)) return "already";
  const change = projection.changes.get(named.id);
  const base = change?.base;
  if (change && base?.sets) {
    const node = placeIn(projection.nodes, named.node);
    const history = node && projection.history.get(node.id);
    if (!node || !history) return "purged";
    // The moves and renames about `base`'s change whose being in force undoing `named` flips.
    const chain = [...projection.changes.values()].filter((each) => each.base.root === base.root);
    const after = standingOf([
      ...chain.map((each) => ({ id: each.id, carries: each.root, undoes: each.undoes })),
      { id: "", undoes: change.root },
    ]);
    const flips = chain.filter((each) => each.sets && after.has(each.id) !== each.inForce);
    return turn(
      writer,
      view,
      actor,
      projection,
      history,
      node,
      base as Change & { sets: Sets },
      flips,
      change.root,
    );
  }
  const record = redoneAs(viewRecords(writer.doc, view), projection.inForce, named);
  const node = placeIn(projection.nodes, record.node);
  if (!node) return "purged";
  const extra = { undoes: record.carries ?? record.id };
  const author = (made: TreeRecordInput) => ({
    record: writer.prepare(view, actor, made, extra),
  });
  switch (record.type) {
    case "create":
      if (node.trashed) return "already";
      // Only the node the create made: what others put in a folder since stands, and keeps it standing.
      return author({ type: "delete", node: record.node, cascade: [] });
    case "delete":
      // Lifted already, by a restore of the node or by an earlier Undo of this delete.
      if (!standsIn(projection, record)) return "already";
      return author({ type: "restore", node: record.node });
    case "restore":
      if (node.trashed) return "already";
      return author({ type: "delete", node: record.node, cascade: liftedBy(projection, record) });
    case "purge":
      return "purged";
    // A move or rename the replay skipped, or an Undo of one whose change is not in the view.
    default:
      return "changed_since";
  }
}
