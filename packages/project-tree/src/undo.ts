import { type Actor, SYSTEM_ACTOR, type TreeRecord, type TreeRecordInput } from "./record.js";
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
  type TreeStanding,
  withTurned,
} from "./replay.js";
import { LIVE, lastOfFamily, listRecords, readRecords, type View, viewValues } from "./view.js";
import type { TreeWriter } from "./writer.js";

function liftedBy(tree: TreeStanding, record: TreeRecord) {
  const at = tree.changes.get(record.id)?.index ?? 0;
  return tree.descendants(record.node).filter((id) => {
    if (tree.node(id)?.trashed) return false;
    const history = tree.history(id);
    return Math.max(history?.createdAt ?? -1, history?.place.at(-1)?.index ?? -1) < at;
  });
}

const standsIn = (deletes: ReadonlySet<string>, record: TreeRecord) =>
  deletes.has(record.id) || deletes.has(record.carries ?? record.id);

function deleteIn(writer: TreeWriter, asked: View, recordId: string) {
  const record = lastOfFamily(writer.doc, asked, recordId);
  if (!record || record === "unknown" || record.type !== "delete") return null;
  return { record, projection: writer.view(record.draft === null ? LIVE : asked) };
}

export function deleteStands(writer: TreeWriter, asked: View, recordId: string): boolean {
  const found = deleteIn(writer, asked, recordId);
  return found !== null && standsIn(found.projection.standingDeletes, found.record);
}

export function deleteHides(writer: TreeWriter, asked: View, recordId: string): boolean {
  const found = deleteIn(writer, asked, recordId);
  return found !== null && standsIn(found.projection.hidingDeletes, found.record);
}

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

export type NotUndone = "changed_since" | "purged" | "already" | "unknown";

export type ClosedUndo = { closed: string };

export type UndoAnswer = "undoes" | NotUndone | "closed";

export type TakenBack = TreeRecord | NotUndone | ClosedUndo;

export type UndoReport = { answer: "undoes" | NotUndone; sources: readonly string[] };

export type UndoStep = { id: string; view: View; withdraw?: string };

const viewOfRecord = (record: TreeRecord, asked: View): View =>
  record.draft === null ? LIVE : asked;

const notTaken = (reason: SkipReason): NotUndone =>
  reason === "missing-parent" || reason === "missing-node" || reason === "purged"
    ? "purged"
    : "changed_since";

function takeBack(
  writer: TreeWriter,
  actor: Actor,
  steps: readonly UndoStep[],
  closed: (source: string) => boolean,
  write: boolean,
): Map<string, { back: TakenBack; sources: readonly string[] }> {
  const doc = writer.doc;
  const byId = new Map(listRecords(doc).map((record) => [record.id, record]));
  const live = viewValues(doc, LIVE);
  const landed: TreeRecord[] = [];
  const landedLive: TreeRecord[] = [];
  const pendingOf = (view: View) =>
    view.draft === null ? [] : viewValues(doc, view).slice(live.length);
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
    });
    open.set(view.draft, { replay, liveSeen: landedLive.length });
    return replay;
  };

  const out = new Map<string, { back: TakenBack; sources: readonly string[] }>();
  for (const { id, view: asked, withdraw } of steps) {
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
    const made = opposite(writer, view, actor, replay.standing(), named, withdraw);
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

export function undoChange(
  writer: TreeWriter,
  asked: View,
  actor: Actor,
  recordId: string,
  closed: (source: string) => boolean,
): TreeRecord | NotUndone | ClosedUndo {
  return takeBackAll(writer, actor, [{ id: recordId, view: asked }], closed).get(
    recordId,
  ) as TakenBack;
}

export function undoReports(
  writer: TreeWriter,
  steps: readonly UndoStep[],
  closed: (source: string) => boolean = () => false,
): Map<string, UndoReport> {
  return new Map(
    [...takeBack(writer, SYSTEM_ACTOR, steps, closed, false)].map(([id, { back, sources }]) => [
      id,
      typeof back === "string" ? { answer: back, sources: [] } : { answer: "undoes", sources },
    ]),
  );
}

export function takeBackAll(
  writer: TreeWriter,
  actor: Actor,
  steps: readonly UndoStep[],
  closed: (source: string) => boolean = () => false,
): Map<string, TakenBack> {
  return new Map(
    [...takeBack(writer, actor, steps, closed, true)].map(([id, { back }]) => [id, back]),
  );
}

export function changeUndone(
  answers: readonly UndoAnswer[],
): "acts" | "taken" | "changed_since" | "purged" | "closed" {
  if (answers.includes("undoes")) return "acts";
  if (answers.includes("changed_since")) return "changed_since";
  if (answers.some((answer) => answer !== "already" && answer !== "closed")) return "purged";
  if (answers.includes("closed")) return "closed";
  return "taken";
}

function opposite(
  writer: TreeWriter,
  view: View,
  actor: Actor,
  tree: TreeStanding,
  named: TreeRecord,
  withdraw?: string,
): TreeRecord | NotUndone {
  const change = tree.changes.get(named.id);
  if (!change?.inForce) return "already";
  const base = change.base;
  const found = tree.node(named.node);
  const node = found && !found.purged ? found : undefined;
  if (base.sets) {
    const history = node && tree.history(node.id);
    if (!node || !history) return "purged";
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
      if (withdraw !== undefined && view.draft === null && named.fromDraft !== undefined)
        return writer.prepare(
          view,
          actor,
          { type: "delete", node: named.node, cascade: [] },
          { ...extra, fromDraft: withdraw },
        );
      return author({ type: "delete", node: named.node, cascade: [] });
    case "delete":
      if (!standsIn(tree.standingDeletes, named)) return "already";
      return author({ type: "restore", node: named.node });
    case "restore":
      if (node.trashed) return "already";
      return author({ type: "delete", node: named.node, cascade: liftedBy(tree, named) });
    case "purge":
      return "purged";
    default:
      return "changed_since";
  }
}
