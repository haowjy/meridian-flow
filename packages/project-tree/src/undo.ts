import {
  type Actor,
  isSourceRoot,
  recordsOf,
  type TreeRecord,
  type TreeRecordInput,
} from "./record.js";
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
import { LIVE, lastOfFamily, listRecords, type View } from "./view.js";
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

/** Why an Undo appended nothing, in the words of the results that report it. */
export type NotUndone = "changed_since" | "purged" | "already" | "unknown";

/**
 * The Undo would change a source the caller's `closed` names (`closed` is that source): nothing
 * is written, and the record it would have taken back stays.
 */
export type ClosedUndo = { closed: string };

/** One record's answer as `changeUndone` reads it. */
export type UndoAnswer = "undoes" | NotUndone | "closed";

/** The view an opposite record is written to: live when it carries no draft (an Apply landed it). */
const viewOfRecord = (record: TreeRecord, asked: View): View =>
  record.draft === null ? LIVE : asked;

/**
 * Undo of one change in the view it belongs to: appends the opposite record (move back, rename
 * back, restore what was deleted, delete what was created). Every record is in force unless a
 * later record in force undoes it (`standingOf`), and Undo answers `already` for one that is not.
 * A move or rename, and any Undo about one, goes by what taking it out does to the change it is
 * about (`turn`): `changed_since` when a later change in force holds every fact that would turn,
 * or the place it would go back to is inside the node now, and nothing is written then. A create,
 * delete or restore goes by the record in force: `already` when its opposite already stands; `purged`:
 * the node, or the folder a move would return to, is gone from the view, where the replay would
 * skip the opposite record. `unknown`: no such record. A move back into a folder in Trash needs
 * no answer: the node stands in it, and rule 3 keeps the folder standing. A drafted change an
 * Apply landed is taken back in live, where its copy now stands: the opposite record's `draft`
 * says which view it went to.
 *
 * `closed` says which sources take no change. A record whose replay reports one of them is not
 * written (`{ closed: source }`): the change stays, as it does in `undoApply`.
 */
export function undoChange(
  writer: TreeWriter,
  asked: View,
  actor: Actor,
  recordId: string,
  closed: (source: string) => boolean,
): TreeRecord | NotUndone | ClosedUndo {
  const done = takeBack(writer, asked, actor, recordId, closed);
  return typeof done === "string" || "closed" in done ? done : done.record;
}

/**
 * Appends the opposite record unless it would change a closed source, telling which fact of a
 * move that set a name stays (`kept`), when one does. The record is judged on a replay of the
 * view with it appended (`preview`), and only a record that lands is written, with that replay
 * kept as the writer's view of the list: a held one leaves no trace in the list.
 */
export function takeBack(
  writer: TreeWriter,
  asked: View,
  actor: Actor,
  recordId: string,
  closed: (source: string) => boolean,
): { record: TreeRecord; kept?: Kept } | NotUndone | ClosedUndo {
  const done = opposite(writer, asked, actor, recordId);
  if (typeof done === "string") return done;
  const view = viewOfRecord(done.record, asked);
  const projection = writer.preview(view, [done.record]);
  const source = projection.changes.get(done.record.id)?.sources.find(closed);
  if (source !== undefined) return { closed: source };
  writer.append(done.record, { view, projection });
  return done;
}

/** What the Undo of one record would do now: `undoes`, or why it would not, and the sources it would change. */
export type UndoReport = { answer: "undoes" | NotUndone; sources: readonly string[] };

/**
 * Which of `records` (opposites made against the list as it stands) would change a source
 * `closed` names, each with that source. One replay of the view with all of them appended reports
 * every record's sources, and the records that hit one are held. A held record does not land, so
 * what is read through it is read again: one more replay judges the rest, and so on until a
 * replay finds no hit. A record is held only for a source it changes itself: a hit whose way
 * goes through a folder an earlier hit keeps out (the folder is in the node's or the
 * destination's ancestry, as the list has it or as the replay does) waits for that replay, since
 * a parent folder's return to a closed Work does not move the child renamed inside it. So the
 * replays are one more than the chain of such dependences is long, however many records hit.
 * `sources` is what the last replay that read each record reported for it.
 */
function holdClosed(
  writer: TreeWriter,
  view: View,
  records: readonly TreeRecord[],
  closed: (source: string) => boolean,
): { held: Map<string, string>; sources: Map<string, readonly string[]> } {
  const held = new Map<string, string>();
  const sources = new Map<string, readonly string[]>();
  const was = writer.view(view).nodes;
  for (let rest = records; rest.length > 0; rest = rest.filter((record) => !held.has(record.id))) {
    const projection = writer.preview(view, rest);
    const keptOut = new Set<string>();
    const throughHeld = (record: TreeRecord) => {
      const ends =
        record.type === "move" || record.type === "create"
          ? [record.node, record.parent]
          : [record.node];
      return ends.some((end) => {
        for (const nodes of [was, projection.nodes])
          for (
            let at: string | undefined = end, steps = 0;
            at !== undefined && steps <= nodes.size;
            steps += 1
          ) {
            if (keptOut.has(at)) return true;
            at = nodes.get(at)?.parent;
          }
        return false;
      });
    };
    let hit = false;
    for (const record of rest)
      sources.set(record.id, projection.changes.get(record.id)?.sources ?? []);
    for (const record of rest) {
      const source = sources.get(record.id)?.find(closed);
      if (source === undefined || throughHeld(record)) continue;
      held.set(record.id, source);
      if (record.type === "move") keptOut.add(record.node);
      hit = true;
    }
    if (!hit) break;
  }
  return { held, sources };
}

/** The opposite records, by the view each is written to: live when it carries no draft. */
function byView(asked: View, records: readonly TreeRecord[]): [View, TreeRecord[]][] {
  const views = new Map<string | null, [View, TreeRecord[]]>();
  for (const record of records) {
    const view = viewOfRecord(record, asked);
    const group = views.get(view.draft) ?? [view, []];
    group[1].push(record);
    views.set(view.draft, group);
  }
  return [...views.values()];
}

/**
 * What the Undo of each record would do now, writing nothing. `recordIds` is the order the Undo
 * takes them in. Each record's opposite is made against the list as it stands, and the sources
 * each would change come from one replay of the view with all of them appended (`holdClosed`
 * says which are held). Records that depend on each other (a node moved twice) are read here
 * from one list state; `takeBackAll` asks again, a layer at a time.
 */
export function undoReports(
  writer: TreeWriter,
  asked: View,
  recordIds: readonly string[],
  closed: (source: string) => boolean = () => false,
): Map<string, UndoReport> {
  const made = recordIds.map((id) => ({ id, made: opposite(writer, asked, "system", id) }));
  const sources = new Map<string, readonly string[]>();
  const all = made.flatMap(({ made }) => (typeof made === "string" ? [] : [made.record]));
  for (const [view, records] of byView(asked, all)) {
    for (const [id, found] of holdClosed(writer, view, records, closed).sources)
      sources.set(id, found);
  }
  return new Map(
    made.map(({ id, made }): [string, UndoReport] => [
      id,
      typeof made === "string"
        ? { answer: made, sources: [] }
        : { answer: "undoes", sources: sources.get(made.record.id) ?? [] },
    ]),
  );
}

/** One record of `takeBackAll`: its opposite (written), why it was not, or the closed source that holds it. */
export type TakenBack = { record: TreeRecord; kept?: Kept } | NotUndone | ClosedUndo;

/**
 * `takeBack` for the records of one command, newest first, with the replays shared: each
 * record's opposite is made against the list as it stands, and one replay of the view with all
 * of them appended says which would change a closed source (`holdClosed`), so the cost is a few
 * replays however many records there are, not one each. Only the ones that land are written, in
 * one transaction. A node's records go newest first, one layer per replay (layer k holds each
 * node's k-th record): the Undo of the first changes what the Undo of the second means, so the
 * second is made only after the first is written.
 */
export function takeBackAll(
  writer: TreeWriter,
  asked: View,
  actor: Actor,
  recordIds: readonly string[],
  closed?: (source: string) => boolean,
): Map<string, TakenBack> {
  const nodeOf = new Map(listRecords(writer.doc).map((record) => [record.id, record.node]));
  const layers: string[][] = [];
  const depth = new Map<string, number>();
  for (const id of recordIds) {
    const node = nodeOf.get(id);
    const at = node === undefined ? 0 : (depth.get(node) ?? 0);
    if (node !== undefined) depth.set(node, at + 1);
    const layer = layers[at] ?? [];
    layer.push(id);
    layers[at] = layer;
  }
  const out = new Map<string, TakenBack>();
  for (const layer of layers) {
    const made = new Map<string, { record: TreeRecord; kept?: Kept }>();
    for (const id of layer) {
      const done = opposite(writer, asked, actor, id);
      if (typeof done === "string") out.set(id, done);
      else made.set(id, done);
    }
    const held = new Map<string, string>();
    if (closed)
      for (const [view, records] of byView(
        asked,
        [...made.values()].map(({ record }) => record),
      ))
        for (const [id, source] of holdClosed(writer, view, records, closed).held)
          held.set(id, source);
    const landed: TreeRecord[] = [];
    for (const [id, done] of made) {
      const source = held.get(done.record.id);
      if (source !== undefined) out.set(id, { closed: source });
      else {
        out.set(id, done);
        landed.push(done.record);
      }
    }
    if (landed.length > 0) writer.transact(() => recordsOf(writer.doc).push(landed));
  }
  return new Map(recordIds.map((id) => [id, out.get(id) as TakenBack]));
}

/**
 * What an Undo of one change, made of several records, does with it, from each record's answer:
 * `acts` while any record is taken back; else the change stays when any record stays
 * (`unknown` read as `purged`; `closed` last, as the only one that can pass: its owner
 * reopens); else every record's opposite already stands, and the change counts as taken back
 * (`taken`).
 */
export function changeUndone(
  answers: readonly UndoAnswer[],
): "acts" | "taken" | "changed_since" | "purged" | "closed" {
  if (answers.includes("undoes")) return "acts";
  if (answers.includes("changed_since")) return "changed_since";
  if (answers.some((answer) => answer !== "already" && answer !== "closed")) return "purged";
  if (answers.includes("closed")) return "closed";
  return "taken";
}

/** The opposite record of `recordId`, made and not written; `kept` as `takeBack` says. */
function opposite(
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
  const node = placeIn(projection.nodes, named.node);
  if (!node) return "purged";
  const extra = { undoes: named.carries ?? named.id };
  const author = (made: TreeRecordInput) => ({
    record: writer.prepare(view, actor, made, extra),
  });
  switch (named.type) {
    case "create":
      if (node.trashed) return "already";
      // Only the node the create made: what others put in a folder since stands, and keeps it standing.
      return author({ type: "delete", node: named.node, cascade: [] });
    case "delete":
      // Lifted already, by a restore of the node or by an earlier Undo of this delete.
      if (!standsIn(projection, named)) return "already";
      return author({ type: "restore", node: named.node });
    case "restore":
      if (node.trashed) return "already";
      return author({ type: "delete", node: named.node, cascade: liftedBy(projection, named) });
    case "purge":
      return "purged";
    // A move or rename the replay skipped, or an Undo of one whose change is not in the view.
    default:
      return "changed_since";
  }
}
