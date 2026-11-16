import type { Actor, TreeRecord, TreeRecordInput } from "./record.js";
import {
  type Change,
  labelOf,
  type NodeHistory,
  type Replay,
  type Sets,
  type SkipReason,
  type StandingNode,
  standingOf,
  startReplay,
  type TreeProjection,
  type TreeStanding,
  withTurned,
} from "./replay.js";
import { LIVE, lastOfFamily, listRecords, readRecords, type View, viewValues } from "./view.js";
import type { TreeWriter } from "./writer.js";

/**
 * What a restore brought back below its node: the nodes whose place was last set before the
 * restore. What was put in the folder after it (a create or a move into it) is not the restore's.
 */
function liftedBy(tree: TreeStanding, record: TreeRecord) {
  const at = tree.changes.get(record.id)?.index ?? 0;
  return tree.descendants(record.node).filter((id) => {
    if (tree.node(id)?.trashed) return false;
    const history = tree.history(id);
    return Math.max(history?.createdAt ?? -1, history?.place.at(-1)?.index ?? -1) < at;
  });
}

/** Whether the delete record, or the original an Undo's copy carries, is in `deletes`. */
const standsIn = (deletes: ReadonlySet<string>, record: TreeRecord) =>
  deletes.has(record.id) || deletes.has(record.carries ?? record.id);

/** The delete `recordId` names as `asked` has it, and the view whose Trash holds it. */
function deleteIn(writer: TreeWriter, asked: View, recordId: string) {
  const record = lastOfFamily(writer.doc, asked, recordId);
  if (!record || record === "unknown" || record.type !== "delete") return null;
  return { record, projection: writer.view(record.draft === null ? LIVE : asked) };
}

/**
 * Whether the delete `recordId` can still be undone: it is in force in the view (not lifted by a
 * restore of any of its nodes, an Undo or a purge). The fact `undoChange` reads.
 */
export function deleteStands(writer: TreeWriter, asked: View, recordId: string): boolean {
  const found = deleteIn(writer, asked, recordId);
  return found !== null && standsIn(found.projection.standingDeletes, found.record);
}

/**
 * Whether the delete `recordId` is in force and hides something now (`hidingDeletes`): whether
 * its Undo would bring anything back. One that hides nothing may hide again, while it stands.
 */
export function deleteHides(writer: TreeWriter, asked: View, recordId: string): boolean {
  const found = deleteIn(writer, asked, recordId);
  return found !== null && standsIn(found.projection.hidingDeletes, found.record);
}

/**
 * The Undo of `named`, a move or rename or an Undo about one. Taking `named` out flips which
 * records about its change are in force (`flips`, as the replay will read them): the change goes
 * out or comes back, or nothing flips but `named`, when another Undo keeps the change out. Then the
 * record changes nothing shown, and is written all the same, so `named` stays out when that other
 * Undo is taken back. The record says what the node then shows, as this copy has it; the replay
 * works that out again from the records in force, so a copy that had not seen an earlier change
 * settles on the same tree. It is a move when the place turns, a rename when only the name does
 * (Trash reads that: a rename leaves what the move lifted lifted), else of the change's type.
 */
function turn(
  writer: TreeWriter,
  view: View,
  actor: Actor,
  history: NodeHistory,
  node: StandingNode,
  base: Change & { sets: Sets },
  flips: readonly Change[],
  undoes: string,
): TreeRecord | NotUndone {
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
  const shows = labelOf(node.kind, history.born, label);
  const extra = { undoes };
  if (!placed && (named || !base.sets.place))
    return writer.prepare(
      view,
      actor,
      {
        type: "rename",
        node: node.id,
        name: shows.name,
        fromName: node.name,
        ...(shows.filetype && shows.filetype !== node.filetype ? { filetype: shows.filetype } : {}),
      },
      extra,
    );
  const { parent, rank } = place.at(-1)?.says ?? history.born;
  return writer.prepare(
    view,
    actor,
    {
      type: "move",
      node: node.id,
      parent,
      rank,
      from: { parent: node.parent, rank: node.rank },
    },
    extra,
  );
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

/** One record of an Undo: its opposite (written), why there is none, or the closed source that holds it. */
export type TakenBack = TreeRecord | NotUndone | ClosedUndo;

/** What the Undo of one record would do now: `undoes`, or why it would not, and the sources it would change. */
export type UndoReport = { answer: "undoes" | NotUndone; sources: readonly string[] };

/** One record to take back, in the view its Undo was asked in. */
export type UndoStep = { id: string; view: View };

/** The view an opposite record is written to: live when the record it takes back is live (an Apply landed it). */
const viewOfRecord = (record: TreeRecord, asked: View): View =>
  record.draft === null ? LIVE : asked;

/** Why the replay would not take an opposite record, as an Undo answers it. */
const notTaken = (reason: SkipReason): NotUndone =>
  reason === "missing-parent" || reason === "missing-node" || reason === "purged"
    ? "purged"
    : "changed_since";

/**
 * Every Undo: `steps` taken back in the order given, each read from the list as the steps before
 * it left it. Per view one replay is kept open. A step's opposite record is made against that
 * replay (`opposite`), the replay says what taking it would do (`wouldTake`: skipped, or the
 * sources it changes), and only a record that lands is pushed to the replay, so the next step
 * reads the tree with it and without the held and skipped ones. The records that landed are
 * written at the end, in one transaction; with `write` false nothing is, and the answers are what
 * the press would give. So an estimate and a press are one walk, and a batch is the same walk as
 * its records taken one call at a time. An id given twice is walked once, at its first step.
 *
 * A Work's view is live and then its pending records, so a record landed in live is not at the
 * end of it: the Work's replay is started again when live has grown under it. `pendingText` is
 * the text the Work's view holds pending, which its replay cannot see in the list.
 */
function takeBack(
  writer: TreeWriter,
  actor: Actor,
  steps: readonly UndoStep[],
  closed: (source: string) => boolean,
  write: boolean,
  pendingText?: ReadonlySet<string>,
): Map<string, { back: TakenBack; sources: readonly string[] }> {
  const doc = writer.doc;
  const byId = new Map(listRecords(doc).map((record) => [record.id, record]));
  const live = viewValues(doc, LIVE);
  const landed: TreeRecord[] = [];
  const landedLive: TreeRecord[] = [];
  const pendingOf = (view: View) =>
    view.draft === null ? [] : viewValues(doc, view).slice(live.length);
  // The last record of each family in a view, as the list has it: `lastOfFamily`, read once.
  const lasts = new Map<string | null, Map<string, TreeRecord>>();
  const lastOf = (view: View) => {
    let last = lasts.get(view.draft);
    if (!last) {
      last = new Map();
      for (const record of readRecords([...live, ...pendingOf(view)]))
        last.set(record.carries ?? record.id, record);
      lasts.set(view.draft, last);
    }
    return last;
  };
  const open = new Map<string | null, { replay: Replay; liveSeen: number }>();
  const replayOf = (view: View) => {
    const had = open.get(view.draft);
    if (had && (view.draft === null || had.liveSeen === landedLive.length)) return had.replay;
    const mine = view.draft === null ? [] : landed.filter((each) => each.draft === view.draft);
    const replay = startReplay([...live, ...landedLive, ...pendingOf(view), ...mine], {
      draft: view.draft,
      ...(view.draft === null ? {} : { pendingText }),
    });
    open.set(view.draft, { replay, liveSeen: landedLive.length });
    return replay;
  };

  const out = new Map<string, { back: TakenBack; sources: readonly string[] }>();
  for (const { id, view: asked } of steps) {
    if (out.has(id)) continue;
    const answer = (back: TakenBack, sources: readonly string[] = []) =>
      out.set(id, { back, sources });
    const first = byId.get(id);
    if (!first) {
      answer("unknown");
      continue;
    }
    const named = lastOf(asked).get(first.carries ?? first.id);
    if (!named) {
      answer("already");
      continue;
    }
    const view = viewOfRecord(named, asked);
    const replay = replayOf(view);
    const made = opposite(writer, view, actor, replay.standing(), named);
    if (typeof made === "string") {
      answer(made);
      continue;
    }
    const would = replay.wouldTake(made);
    if ("skipped" in would) {
      answer(notTaken(would.skipped));
      continue;
    }
    const source = would.sources.find(closed);
    if (source !== undefined) {
      answer({ closed: source }, would.sources);
      continue;
    }
    replay.push(made);
    landed.push(made);
    if (made.draft === null) landedLive.push(made);
    answer(made, would.sources);
  }
  if (write && landed.length > 0) {
    const seen = [...open].flatMap(([draft, each]) =>
      draft === null || each.liveSeen === landedLive.length
        ? [{ view: { draft }, projection: each.replay.finish() }]
        : [],
    );
    writer.appendAll(landed, seen);
  }
  return out;
}

/**
 * Undo of one change in the view it belongs to: appends the opposite record (move back, rename
 * back, restore what was deleted, delete what was created). Every record is in force unless a
 * later record in force undoes it (`standingOf`), and Undo answers `already` for one that is not.
 * A move or rename, and any Undo about one, goes by what taking it out does to the change it is
 * about (`turn`): `changed_since` when a later change in force holds every fact that would turn,
 * or the place it would go back to is inside the node now, and nothing is written then. A create,
 * delete or restore goes by the record in force: `already` when its opposite already stands; `purged`:
 * the node, or the folder a move would return to, is gone from the view. `unknown`: no such
 * record. A move back into a folder in Trash needs no answer: the node stands in it, and rule 3
 * keeps the folder standing. A drafted change an Apply landed is taken back in live, where its
 * copy now stands: the opposite record's `draft` says which view it went to.
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
  pendingText?: ReadonlySet<string>,
): TreeRecord | NotUndone | ClosedUndo {
  return takeBackAll(writer, actor, [{ id: recordId, view: asked }], closed, pendingText).get(
    recordId,
  ) as TakenBack;
}

/**
 * What the Undo of each step would do now, writing nothing: `takeBack`'s walk. A record `closed`
 * holds reports `undoes` with the closed source among its sources, and the steps after it are read
 * without it.
 */
export function undoReports(
  writer: TreeWriter,
  steps: readonly UndoStep[],
  closed: (source: string) => boolean = () => false,
  pendingText?: ReadonlySet<string>,
): Map<string, UndoReport> {
  return new Map(
    [...takeBack(writer, "system", steps, closed, false, pendingText)].map(
      ([id, { back, sources }]) => [
        id,
        typeof back === "string" ? { answer: back, sources: [] } : { answer: "undoes", sources },
      ],
    ),
  );
}

/** Takes the steps back in the order given (`takeBack`), and writes the ones that land. */
export function takeBackAll(
  writer: TreeWriter,
  actor: Actor,
  steps: readonly UndoStep[],
  closed: (source: string) => boolean = () => false,
  pendingText?: ReadonlySet<string>,
): Map<string, TakenBack> {
  return new Map(
    [...takeBack(writer, actor, steps, closed, true, pendingText)].map(([id, { back }]) => [
      id,
      back,
    ]),
  );
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

/**
 * The opposite record of `named`, the last of its family in `view`, made against the tree an open
 * replay has (`tree`) and not written. Whether the tree can take it is the
 * replay's to say (`wouldTake`), not this function's.
 */
function opposite(
  writer: TreeWriter,
  view: View,
  actor: Actor,
  tree: TreeStanding,
  named: TreeRecord,
): TreeRecord | NotUndone {
  const change = tree.changes.get(named.id);
  if (!change?.inForce) return "already";
  const base = change.base;
  const found = tree.node(named.node);
  const node = found && !found.purged ? found : undefined;
  if (base.sets) {
    const history = node && tree.history(node.id);
    if (!node || !history) return "purged";
    // The moves and renames about `base`'s change whose being in force undoing `named` flips.
    const chain = [...tree.changes.values()].filter((each) => each.base.root === base.root);
    const after = standingOf([
      ...chain.map((each) => ({ id: each.id, carries: each.root, undoes: each.undoes })),
      { id: "", undoes: change.root },
    ]);
    const flips = chain.filter((each) => each.sets && after.has(each.id) !== each.inForce);
    return turn(
      writer,
      view,
      actor,
      history,
      node,
      base as Change & { sets: Sets },
      flips,
      change.root,
    );
  }
  if (!node) return "purged";
  const extra = { undoes: named.carries ?? named.id };
  const author = (made: TreeRecordInput) => writer.prepare(view, actor, made, extra);
  switch (named.type) {
    case "create":
      if (node.trashed) return "already";
      // Only the node the create made: what others put in a folder since stands, and keeps it standing.
      return author({ type: "delete", node: named.node, cascade: [] });
    case "delete":
      // Lifted already, by a restore of the node or by an earlier Undo of this delete.
      if (!standsIn(tree.standingDeletes, named)) return "already";
      return author({ type: "restore", node: named.node });
    case "restore":
      if (node.trashed) return "already";
      return author({ type: "delete", node: named.node, cascade: liftedBy(tree, named) });
    case "purge":
      return "purged";
    // A move or rename the replay skipped, or an Undo of one whose change is not in the view.
    default:
      return "changed_since";
  }
}
