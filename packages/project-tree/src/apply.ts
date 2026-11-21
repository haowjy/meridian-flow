import * as Y from "yjs";
import { assertNewCommand } from "./list-index.js";
import {
  type Actor,
  isSourceRoot,
  newId,
  recordsOf,
  type Settlement,
  sourceRoot,
  type TreeRecord,
} from "./record.js";
import {
  lifts,
  placeIn,
  replay,
  type SkipReason,
  type TreeNode,
  type TreeProjection,
} from "./replay.js";
import { fingerprint } from "./shape.js";
import { type NotUndone, type TakenBack, takeBackAll } from "./undo.js";
import { readStored, writable } from "./validate.js";
import { LIVE, lastSettlements, listRecords, pendingRecords, viewRecords } from "./view.js";
import type { TreeWriter } from "./writer.js";

/** Why a record asked to land did not; it stays pending. */
export type LeftWhy =
  /** Its move would put a folder inside itself (rule 1). */
  | "would_loop"
  /** What it acts on is gone: purged, or never created in the view. */
  | "purged"
  /** It was admitted after the press, so the writer had not seen it. */
  | "after_press"
  /** It stands on a record that did not land, or landing it would change what the Work's tree showed. */
  | "needs"
  | "closed";

export type LeftRecord = { record: TreeRecord; why: LeftWhy; source?: string };

export type ApplyResult = {
  /** The command that made it: Undo of this Apply names it. */
  command: string;
  /** The live copies appended. */
  copies: TreeRecord[];
  /** Records asked to land that did not, each with why. They stay pending. */
  left: LeftRecord[];
  /** Records that could not land and that the draft itself later overrode: settled, not left. */
  superseded: TreeRecord[];
};

function needs(record: TreeRecord): string[] {
  if (record.type === "create") return [record.parent];
  if (record.type === "move") return [record.node, record.parent];
  return [record.node];
}

type Facts = (record: TreeRecord) => string[];

/**
 * The facts a record sets, read against the list's `records`: a later record on a same fact
 * overrides an earlier one. An Undo about a move or rename sets that change's facts, whatever its
 * own type: the change at the bottom of its chain of `undoes` (the replay's `Change.base`).
 */
function factsIn(records: readonly TreeRecord[]): Facts {
  const byRoot = new Map<string, TreeRecord>();
  for (const record of records) {
    const root = record.carries ?? record.id;
    if (!byRoot.has(root)) byRoot.set(root, record);
  }
  return (record) => {
    let base = record;
    for (let up = record.undoes; up !== undefined && base !== byRoot.get(up); ) {
      const next = byRoot.get(up);
      if (!next) break;
      base = next;
      up = next.undoes;
    }
    const sets = base.type === "move" || base.type === "rename" ? base : record;
    if (sets.type === "rename") return [`name:${sets.node}`];
    if (sets.type === "move") return [`place:${sets.node}`];
    if (sets.type === "delete" || sets.type === "restore") return [`presence:${sets.node}`];
    return [`create:${sets.node}`];
  };
}
const sharesFact = (facts: Facts, a: TreeRecord, b: TreeRecord) => {
  const of = facts(b);
  return facts(a).some((fact) => of.includes(fact));
};

/**
 * The chosen records plus what they stand on: the drafted creates of the nodes they need, and of
 * each Work-created folder above where a record acts (as the drafted records before it place
 * things), that folder's last drafted delete or restore before the record, so the folder lands
 * standing or in Trash as it was when the record was drafted (an Undo of that restore then finds
 * it in live). With each record come the earlier drafted records on the same fact (applying a
 * second rename brings the first, or the draft would read the first after it). A folder's delete
 * or restore after the record, or of a folder it no longer stands in, stays pending.
 */
function prerequisites(
  pending: readonly TreeRecord[],
  only: readonly string[],
  facts: Facts,
): Set<string> {
  const created = new Map<string, string>();
  for (const record of pending) if (record.type === "create") created.set(record.node, record.id);
  const byId = new Map(pending.map((record) => [record.id, record]));
  const position = new Map(pending.map((record, index) => [record.id, index]));
  const out = new Set<string>();
  const stack = [...only];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    const record = byId.get(id);
    if (!record || out.has(id)) continue;
    out.add(id);
    const before = pending.slice(0, position.get(id) ?? 0);
    for (const node of needs(record)) {
      const creator = created.get(node);
      if (creator && creator !== id) stack.push(creator);
    }
    for (const folder of foldersAbove(before, record)) {
      const creator = created.get(folder);
      if (!creator) continue;
      stack.push(creator);
      const presence = before.findLast(
        (earlier) =>
          (earlier.type === "delete" || earlier.type === "restore") && earlier.node === folder,
      );
      if (presence) stack.push(presence.id);
    }
    for (const earlier of before) if (sharesFact(facts, earlier, record)) stack.push(earlier.id);
  }
  return out;
}

/**
 * The folders above where a record acts, as the drafted records before it place things: above
 * its node, and for a create or move, above where it puts it. Placing comes only from the drafted
 * creates and moves, so the walk stops at a node they don't place.
 */
function foldersAbove(before: readonly TreeRecord[], record: TreeRecord): Set<string> {
  const parentOf = (node: string) => {
    for (let at = before.length - 1; at >= 0; at--) {
      const earlier = before[at] as TreeRecord;
      if (earlier.node === node && (earlier.type === "create" || earlier.type === "move"))
        return earlier.parent;
    }
    return undefined;
  };
  const out = new Set<string>();
  const starts = [parentOf(record.node)];
  if (record.type === "create" || record.type === "move") starts.push(record.parent);
  for (let folder of starts)
    while (folder !== undefined && !out.has(folder)) {
      out.add(folder);
      folder = parentOf(folder);
    }
  return out;
}

/** The chosen records plus every drafted record that stands on a node one of them creates, transitively. */
export function dependents(pending: readonly TreeRecord[], only: readonly string[]): Set<string> {
  const out = new Set<string>();
  const stack = [...only];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (out.has(id)) continue;
    const record = pending.find((candidate) => candidate.id === id);
    if (!record) continue;
    out.add(id);
    if (record.type !== "create") continue;
    for (const other of pending)
      if (other.id !== id && needs(other).includes(record.node)) stack.push(other.id);
  }
  return out;
}

/**
 * Whether applying `chosen` lands what the Work's tree showed: the view of live plus the pending
 * records, against the view after the chosen ones have become live copies. Both are read without
 * the records that cannot land (`without`): one of those may start to take effect once the rest
 * has landed, which is the writer's cue that it can now be applied. A waiting record stays
 * pending and never lands, so the view after must also hold without it, as live will show it:
 * there only what stands is compared, since it acts only on a node in Trash.
 */
function keepsView(
  live: readonly TreeRecord[],
  pending: readonly TreeRecord[],
  chosen: ReadonlySet<string>,
  without: ReadonlySet<string>,
  waiting: ReadonlySet<string>,
): boolean {
  const draft = pending[0]?.draft ?? null;
  const rest = pending.filter((record) => !without.has(record.id));
  const view = replay([...live, ...rest], { draft });
  const copies = rest
    .filter((record) => chosen.has(record.id))
    .map((record) => ({ ...record, draft: null, fromDraft: draft ?? undefined }) as TreeRecord);
  const unchosen = rest.filter((record) => !chosen.has(record.id));
  const after = (records: readonly TreeRecord[]) =>
    replay([...live, ...copies, ...records], { draft });
  if (fingerprint(after(unchosen), false) !== fingerprint(view, false)) return false;
  if (waiting.size === 0) return true;
  return (
    standingShape(after(unchosen.filter((record) => !waiting.has(record.id)))) ===
    standingShape(view)
  );
}

/** The fingerprint's lines for the nodes that stand: what the writer sees. */
const standingShape = (projection: TreeProjection) =>
  fingerprint(projection, false)
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("~"))
    .join("\n");

/**
 * The ids of the records in the structs of the list a copy at state `saw` lacks: what was
 * admitted after the press. Read from the encoded update without applying it.
 */
export function recordsAdmittedAfter(doc: Y.Doc, saw: Uint8Array): Set<string> {
  const ids = new Set<string>();
  for (const item of Y.decodeUpdate(Y.encodeStateAsUpdate(doc, saw)).structs)
    if (item instanceof Y.Item && item.content instanceof Y.ContentAny)
      for (const value of item.content.getContent()) {
        const read = readStored(value);
        if (read.ok) ids.add(read.record.id);
      }
  return ids;
}

/** Whether the copy `doc` holds has everything a copy at state `saw` held. */
export function covers(doc: Y.Doc, saw: Uint8Array): boolean {
  for (const [client, clock] of Y.decodeStateVector(saw))
    if (Y.getState(doc.store, client) < clock) return false;
  return true;
}

const whyNotInView = (reason: SkipReason): LeftWhy =>
  reason === "cycle" ? "would_loop" : GONE.has(reason) ? "purged" : "needs";

/**
 * Apply a Work, whole or in part: appends a live copy of each chosen record, and settles the
 * drafted ones applied, in one transaction. A copy keeps who drafted it and adds who applied it.
 * It never refuses: what cannot land is in `left` with a `why` and stays pending.
 *
 * A record cannot land when the Work's view skips it (a move that would put a folder inside
 * itself, a node that is gone), when it was admitted after `saw` (the list's state vector at the
 * press: the writer had not seen it), or when it stands on one of those. A move or rename of a
 * node in Trash in live and in the Work's view is not applied and is not `left`: it waits in the
 * Work until the node is restored. A move or rename of a node the Work's view brings back from Trash
 * (the Work's own applied delete) lands and brings it back in live too (rule 9). Of what
 * could land, the largest prefix that keeps what the Work's tree showed lands: the rest is
 * `needs`.
 */
export function applyDraft(
  writer: TreeWriter,
  draft: string,
  appliedBy: Actor,
  command: string,
  only?: readonly string[],
  saw?: Uint8Array,
  closed?: (source: string) => boolean,
): ApplyResult {
  const { doc } = writer;
  assertNewCommand(doc, command);
  const view = writer.view({ draft });
  const pending = pendingRecords(doc, draft);
  const pendingIds = new Set(pending.map((record) => record.id));
  const live = viewRecords(doc, LIVE);
  // Records that cannot land by themselves, each with why; what stands on them is `needs`.
  const roots = new Map<string, LeftWhy>();
  for (const skip of view.skipped)
    if (pendingIds.has(skip.record)) roots.set(skip.record, whyNotInView(skip.reason));
  if (saw)
    for (const id of recordsAdmittedAfter(doc, saw))
      if (pendingIds.has(id) && !roots.has(id)) roots.set(id, "after_press");
  const facts = factsIn(listRecords(doc));
  const liveNow = writer.view(LIVE);
  // A move or rename of a node in Trash in live and in the Work's view waits for a restore: the
  // Work shows nothing of it, and landing it would bring the node back (rule 9).
  const waiting = new Set(
    pending.flatMap((record) =>
      (record.type === "move" || record.type === "rename") &&
      view.nodes.get(record.node)?.trashed &&
      liveNow.nodes.get(record.node)?.trashed
        ? [record.id]
        : [],
    ),
  );
  const wanted = new Set(
    [...(only ? prerequisites(pending, only, facts) : pendingIds)].filter((id) => !waiting.has(id)),
  );
  const closedBy = new Map<string, string>();
  const plan = () => {
    const leftIds = dependents(pending, [...roots.keys()]);
    const heldIds = dependents(pending, [...closedBy.keys()]);
    // Neither lands: a left record is reported, a waiting one stays silently pending.
    const unplanned = new Set([...leftIds, ...waiting]);
    const candidates = pending.filter(
      (record) => wanted.has(record.id) && !unplanned.has(record.id),
    );
    const chosenOf = (records: readonly TreeRecord[]) =>
      new Set(records.map((record) => record.id));

    // What lands is what the Work's tree showed: the selection, when that keeps it. Else the
    // drafted records up to the last one chosen, and when even those don't, the largest prefix of
    // them that does (the empty one always does), so nothing is ever turned away whole.
    const pool = (() => {
      if (candidates.length === 0) return [];
      if (keepsView(live, pending, chosenOf(candidates), leftIds, waiting)) return candidates;
      const last = pending.indexOf(candidates[candidates.length - 1] as TreeRecord);
      return pending.slice(0, last + 1).filter((record) => !unplanned.has(record.id));
    })();
    const holds = (count: number) =>
      keepsView(live, pending, chosenOf(pool.slice(0, count)), leftIds, waiting);
    let count = pool.length;
    if (count > 0 && pool !== candidates && !holds(count)) {
      let good = 0;
      let bad = count;
      while (bad - good > 1) {
        const mid = (good + bad) >> 1;
        if (holds(mid)) good = mid;
        else bad = mid;
      }
      count = good;
    }
    // A create of a node live already has standing (a restored Discard of a create applied before)
    // has nothing to make: it is settled superseded with no copy, so no Undo takes the node back.
    // A folder live keeps only for a child (its create undone, rule 3) has no standing of its own.
    const already = pool.slice(0, count).filter((record) => {
      const node = record.type === "create" ? liveNow.nodes.get(record.node) : undefined;
      return node?.trashed === false && !node.keptByChild;
    });
    const taken = chosenOf(pool.slice(0, count).filter((record) => !already.includes(record)));
    // A record that cannot land and that a later landing record on the same fact overrides is
    // settled as superseded: left pending, it would come back later and undo that later choice.
    const superseded = pending.filter((record) => {
      if (!leftIds.has(record.id) || heldIds.has(record.id) || taken.size === 0) return false;
      const overriding = new Set(
        pending
          .slice(pending.indexOf(record) + 1)
          .filter((later) => taken.has(later.id))
          .flatMap(facts),
      );
      return facts(record).every((fact) => overriding.has(fact));
    });
    const overridden = new Set([...superseded, ...already].map((record) => record.id));
    // A copy's `from` is what live had just before it, as the copies before it leave live.
    const was = new Map<string, { name: string; parent: string; rank: string }>();
    const turned = new Set<string>();
    // After a copy of an Undo, what live has of its node is what the records in force say: replayed
    // when the next copy of that node needs it, since a copy's `from` is live just before it.
    const stands = (node: string) => {
      if (turned.delete(node)) {
        const now = replay([...live, ...copies]).nodes.get(node);
        if (now) was.set(node, now);
      }
      return was.get(node) ?? liveNow.nodes.get(node);
    };
    const copies: TreeRecord[] = [];
    const ofCopy = new Map<string, string>();
    for (const record of pending) {
      if (!taken.has(record.id)) continue;
      const copy = {
        ...record,
        id: newId(),
        draft: null,
        carries: record.carries ?? record.id,
        appliedBy,
        fromDraft: draft,
      } as TreeRecord;
      const before = stands(copy.node);
      if (copy.type === "move" && before) copy.from = { parent: before.parent, rank: before.rank };
      if (copy.type === "rename" && before) copy.fromName = before.name;
      if (copy.undoes !== undefined) turned.add(copy.node);
      else if (copy.type === "create")
        was.set(copy.node, { name: copy.name, parent: copy.parent, rank: copy.rank });
      else if (before && copy.type === "move")
        was.set(copy.node, {
          name: before.name,
          parent: copy.parent,
          rank: copy.rank,
        });
      else if (before && copy.type === "rename") was.set(copy.node, { ...before, name: copy.name });
      copies.push(writable(copy));
      ofCopy.set(copy.id, record.id);
    }
    return { taken, superseded, already, overridden, copies, ofCopy };
  };
  let landing = plan();
  while (closed) {
    const projection = replay([...live, ...landing.copies]);
    const offender = landing.copies.find((copy) =>
      projection.changes.get(copy.id)?.sources.some(closed),
    );
    if (!offender) break;
    const source = projection.changes.get(offender.id)?.sources.find(closed) as string;
    const original = landing.ofCopy.get(offender.id);
    if (!original) throw new Error("Apply copy has no pending record");
    roots.set(original, "closed");
    closedBy.set(original, source);
    landing = plan();
  }
  const { taken, superseded, already, overridden, copies } = landing;
  writer.transact(() => {
    recordsOf(doc).push(copies);
    writer.settle(appliedBy, [...taken], "applied", { command });
    writer.settle(appliedBy, [...overridden], "superseded", { command });
  });
  const held = new Map<string, string>();
  for (const [id, source] of closedBy)
    for (const dependent of dependents(pending, [id]))
      if (!held.has(dependent)) held.set(dependent, source);
  return {
    command,
    copies,
    left: pending.flatMap((record) =>
      wanted.has(record.id) && !taken.has(record.id) && !overridden.has(record.id)
        ? [
            held.has(record.id)
              ? { record, why: "closed" as const, source: held.get(record.id) }
              : { record, why: roots.get(record.id) ?? ("needs" as const) },
          ]
        : [],
    ),
    superseded: [...superseded, ...already],
  };
}

/**
 * Discard, whole or in part: the chosen records and every drafted record that stands on them,
 * returned as `discarded`. With `trash` (the press), each node whose create it discards goes to
 * live's Trash, since it is a whole document or folder and not a change to one: created in live
 * as the Work's view shows it (a topmost one whose folder is not in live at the top of its
 * source), then deleted by `by`, each topmost node taking what it holds. `trashed` is those
 * deletes: the caller records them with its command, and its Undo (`restoreDiscard`) takes them
 * back, which is what Trash's Restore writes too, so whichever comes first the other does nothing.
 */
export function discardDraft(
  writer: TreeWriter,
  draft: string,
  by: Actor,
  command: string,
  only?: readonly string[],
  options: { trash?: boolean } = {},
): { discarded: string[]; trashed: string[] } {
  assertNewCommand(writer.doc, command);
  const pending = pendingRecords(writer.doc, draft);
  const chosen = only ? dependents(pending, only) : new Set(pending.map((record) => record.id));
  const made = options.trash
    ? toTrash(
        writer,
        draft,
        by,
        pending.filter((record) => chosen.has(record.id) && record.type === "create"),
      )
    : [];
  writer.transact(() => {
    writer.settle(by, [...chosen], "discarded", { command });
    if (made.length > 0) recordsOf(writer.doc).push(made);
  });
  return {
    discarded: [...chosen],
    trashed: made.flatMap((record) => (record.type === "delete" ? [record.id] : [])),
  };
}

/**
 * The live records that put in Trash the nodes these drafted creates made, read before they are
 * discarded. A node goes when the Work's view shows it standing and live has never had it (a
 * restored Discard of a create applied before is live's already; one the Work deleted stays
 * gone). The nodes split into subtrees that stand together: a node's subtree stops at a node
 * that is not going, which is a topmost one in turn if anything below it goes.
 */
function toTrash(
  writer: TreeWriter,
  draft: string,
  by: Actor,
  creates: readonly TreeRecord[],
): TreeRecord[] {
  const view = writer.view({ draft });
  const live = writer.view(LIVE);
  const going = new Set(
    creates.flatMap((record) => {
      const node = placeIn(view.nodes, record.node);
      return node && !node.trashed && !live.nodes.has(record.node) ? [record.node] : [];
    }),
  );
  const below = (id: string): string[] =>
    (view.children.get(id) ?? []).flatMap((child) =>
      going.has(child.id) ? [child.id, ...below(child.id)] : [],
    );
  const made: TreeRecord[] = [];
  for (const top of going) {
    if (going.has(view.nodes.get(top)?.parent as string)) continue;
    const held = below(top);
    for (const id of [top, ...held]) {
      const node = view.nodes.get(id) as TreeNode;
      const create = creates.find((record) => record.node === id) as TreeRecord;
      const parent =
        id !== top || isSourceRoot(node.parent) || placeIn(live.nodes, node.parent)
          ? node.parent
          : sourceRoot(node.source);
      made.push(
        writer.prepare(
          LIVE,
          create.actor,
          {
            type: "create",
            node: id,
            kind: node.kind,
            name: node.name,
            parent,
            source: node.source,
            rank: node.rank,
            ...(node.filetype ? { filetype: node.filetype } : {}),
            ...(node.provisional ? { provisional: true as const } : {}),
            ...(node.aliases ? { aliases: node.aliases } : {}),
            ...(node.hasProperties ? { hasProperties: true as const } : {}),
            ...(node.blob ? { blob: node.blob } : {}),
          },
          // Landed from the draft, as an Apply's copy is: its Undo leaves the node the draft's alone.
          { carries: create.carries ?? create.id, fromDraft: draft },
        ),
      );
    }
    made.push(writer.prepare(LIVE, by, { type: "delete", node: top, cascade: held }));
  }
  return made;
}

/** Why a restored record would have nothing to act on: what it stands on is gone. */
const GONE: ReadonlySet<SkipReason> = new Set(["purged", "missing-node", "missing-parent"]);

/**
 * What an Apply command settled, and the live copies it appended: the last copy of each record it
 * applied. A copy a later record undid is among them: `undoApply` tries it and `undoChange` answers
 * `already`, and a copy of the Apply's own Undo record may bring it back in force on the way.
 */
function appliedBy(doc: Y.Doc, applied: string) {
  const settled = settledBy(doc, applied, "applied", "superseded");
  const all = new Map(listRecords(doc).map((record) => [record.id, record]));
  const landed = new Set(
    settled.flatMap(([id, to]) => {
      const record = all.get(id);
      return to === "applied" && record ? [record.carries ?? record.id] : [];
    }),
  );
  // An original applied, undone and applied again has a copy for each: this command's is the last.
  const last = new Map<string, TreeRecord>();
  for (const record of viewRecords(doc, LIVE))
    if (record.carries !== undefined && landed.has(record.carries))
      last.set(record.carries, record);
  const copies = viewRecords(doc, LIVE).filter(
    (record) => record.carries !== undefined && last.get(record.carries) === record,
  );
  return { settled, copies };
}

/** The live copies an Apply command made, whether or not they still stand. */
export function madeBy(doc: Y.Doc, applied: string): TreeRecord[] {
  return appliedBy(doc, applied).copies;
}

/** Why a fact an Apply landed is not taken back; the document or record stays as it stands. */
export type UndoLeftWhy = NotUndone | "closed";

export type UndoApplyResult = {
  /** The opposite records made, newest copy first. */
  undone: TreeRecord[];
  /** The live copies not taken back, each with why; `source` is the closed one a `closed` names. */
  left: Array<{ record: TreeRecord; why: UndoLeftWhy; source?: string }>;
};

/**
 * Undo of an Apply, fact by fact: for each live copy the Apply landed, newest first, the opposite
 * record `undoChange` makes, so what others did since (a rename of the same node, a node put in
 * a created folder) is kept, as it is for any other Undo. A fact something later changed stays
 * (`changed_since`), as does a node that is gone (`purged`) and a change no longer in force
 * (`already`); each is in `left`. The records whose copies were taken back are pending again in
 * the Work; the others stay applied. A create taken back leaves the node the Work's alone, in no
 * live row and no Trash entry (the replay's withdrawn nodes): its text, plain in its Live room,
 * is the Work's again.
 */
export function undoApply(
  writer: TreeWriter,
  applied: string,
  by: Actor,
  command: string,
  options: { closed?: (source: string) => boolean } = {},
): UndoApplyResult {
  assertNewCommand(writer.doc, command);
  const { settled } = appliedBy(writer.doc, applied);
  const made = madeBy(writer.doc, applied);
  const undone: TreeRecord[] = [];
  const left: UndoApplyResult["left"] = [];
  // The roots (`carries ?? id`) of the copies taken back, at least in part.
  const reversed = new Set<string>();
  writer.transact(() => {
    const copies = made.reverse();
    const answers = takeBackAll(
      writer,
      by,
      copies.map((copy) => ({ id: copy.id, view: LIVE })),
      options.closed,
    );
    for (const copy of copies) {
      const back = answers.get(copy.id) as TakenBack;
      if (typeof back === "string") {
        left.push({ record: copy, why: back });
        continue;
      }
      if ("closed" in back) {
        left.push({ record: copy, why: "closed", source: back.closed });
        continue;
      }
      undone.push(back);
      reversed.add(copy.carries ?? copy.id);
    }
    // A record this Apply settled is pending again once a copy of it is taken back: matched by
    // root, since a restored Discard's record (a copy itself) and its live copy share the original
    // they carry. One it lost a fact to (settled `superseded`) returns only if a record that
    // overrode it did.
    const all = listRecords(writer.doc);
    const facts = factsIn(all);
    const position = new Map(all.map((record, at) => [record.id, at]));
    const byId = new Map(all.map((record) => [record.id, record]));
    const rootOf = (id: string) => byId.get(id)?.carries ?? id;
    const reopened = settled.flatMap(([id, to]) =>
      to === "applied" && reversed.has(rootOf(id)) ? [id] : [],
    );
    const back = settled.flatMap(([id, to]) => {
      if (to === "applied") return reopened.includes(id) ? [id] : [];
      const lost = byId.get(id);
      return lost &&
        reopened.some((other) => {
          const record = byId.get(other);
          return (
            record &&
            (position.get(other) ?? 0) > (position.get(id) ?? 0) &&
            sharesFact(facts, lost, record)
          );
        })
        ? [id]
        : [];
    });
    writer.settle(by, back, "pending", { command });
  });
  return { undone, left };
}

/** What one Discard command settled. */
export type DiscardedBy = {
  /** The records it discarded, in list order. */
  records: TreeRecord[];
  /** Restored already: copies of these records are pending again. */
  restored: boolean;
};

/** The records a Discard command settled. */
export function discardedBy(doc: Y.Doc, discarded: string): DiscardedBy {
  const last = lastSettlements(doc);
  const all = listRecords(doc);
  const records = all.filter((record) => {
    const settle = last.get(record.id);
    return settle?.to === "discarded" && settle.command === discarded;
  });
  return { records, restored: all.some((record) => record.restores === discarded) };
}

/**
 * Restoring a Discard: a Discard is final, so its records stay discarded and the Work gets fresh
 * pending copies of them, on `draft` (the Work's current draft, which may not be the one the
 * Discard closed), after anything it drafted since (so on a fact both touched, the restored
 * change wins; each pending record a copy overrides is settled discarded under `command`, so
 * restoring that command brings it back as a copy that wins in turn). A copy has a new id and the same node id; `carries` names the original, `restores`
 * the Discard and `restoredBy` who restored it, while `actor` stays who drafted it. A
 * record whose node cannot be acted on once the copies are in (purged, or its create is not in
 * force and no copy brings it back) is left out. Once.
 *
 * What the Discard put in live's Trash (`trashed`, the deletes `discardDraft` returned) goes back to
 * the Work with the rest, as before the Discard: each delete still in Trash is taken back, and the
 * live create that put each node it covers there, so live has those nodes no more and no Trash
 * entry (the replay's withdrawn nodes), and their records come back pending. A delete Trash's
 * Restore lifted first stays lifted: its nodes stay in live and their records discarded, so the
 * two never act twice. `back` is the records written in live.
 */
export function restoreDiscard(
  writer: TreeWriter,
  discarded: string,
  by: Actor,
  draft: string,
  command: string,
  trashed: readonly string[] = [],
): { copies: TreeRecord[]; back: TreeRecord[] } | "already" {
  const { doc } = writer;
  assertNewCommand(doc, command);
  const { records: settled, restored } = discardedBy(doc, discarded);
  const deletes = listRecords(doc).filter(
    (record) => record.type === "delete" && trashed.includes(record.id),
  );
  if ((restored || settled.length === 0) && deletes.length === 0) return "already";
  // What each delete still in Trash covers comes back to the Work; what Trash restored stays live.
  const trash = writer.view(LIVE).trash.filter((entry) => trashed.includes(entry.id));
  const going = new Set(trash.flatMap((entry) => [entry.node, ...entry.cascade]));
  const stays = new Set(
    deletes.flatMap((record) =>
      record.type === "delete"
        ? [record.node, ...record.cascade].filter((node) => !going.has(node))
        : [],
    ),
  );
  const records = restored ? [] : settled.filter((record) => !stays.has(record.node));
  // The node a copy acts on stands in its Work's view, or the Discard held its create and the
  // copy of that brings it back.
  const view = writer.view({ draft });
  const created = new Set(
    records.flatMap((record) => (record.type === "create" ? [record.node] : [])),
  );
  const copies: TreeRecord[] = [];
  for (const record of records) {
    if (created.has(record.node) || placeIn(view.nodes, record.node))
      copies.push(
        writable({
          ...record,
          id: newId(),
          draft,
          carries: record.carries ?? record.id,
          restores: discarded,
          restoredBy: by,
        } as TreeRecord),
      );
  }
  // A create or delete overrides nothing; a restore overrides the pending deletes it lifts.
  const overrides = (copy: TreeRecord, pending: TreeRecord) =>
    copy.type === "restore"
      ? pending.type === "delete" &&
        lifts(copy, { id: pending.id, node: pending.node, from: pending.carries })
      : copy.node === pending.node &&
        (copy.type === "rename" || copy.type === "move") &&
        pending.type === copy.type;
  const overridden = pendingRecords(doc, draft)
    .filter((pending) => copies.some((copy) => overrides(copy, pending)))
    .map((pending) => pending.id);
  const back: TreeRecord[] = [];
  writer.transact(() => {
    writer.settle(by, overridden, "discarded", { command });
    recordsOf(doc).push(copies);
    // Out of Trash, then out of live: each create's last live copy is the one that landed it.
    const answers = takeBackAll(writer, by, [
      ...trash.map((entry) => ({ id: entry.id, view: LIVE })),
      ...records
        .filter((record) => record.type === "create" && going.has(record.node))
        .reverse()
        .map((record) => ({ id: record.id, view: LIVE })),
    ]);
    for (const answer of answers.values())
      if (typeof answer === "object" && "id" in answer) back.push(answer);
  });
  return { copies, back };
}

/** The records a command settled with one of these, and nothing since has settled again. */
function settledBy(doc: Y.Doc, command: string, ...to: Settlement[]) {
  return [...lastSettlements(doc)]
    .filter(([, settle]) => settle.command === command && to.includes(settle.to))
    .map(([id, settle]) => [id, settle.to] as const);
}
