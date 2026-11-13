import * as Y from "yjs";
import { assertNewCommand } from "./list-index.js";
import { type Actor, newId, recordsOf, type Settlement, type TreeRecord } from "./record.js";
import { placeIn, replay, type SkipReason } from "./replay.js";
import { fingerprint } from "./shape.js";
import { writable } from "./validate.js";
import {
  LIVE,
  lastSettlements,
  listRecords,
  pendingRecords,
  settlementsOf,
  viewRecords,
} from "./view.js";
import type { TreeWriter } from "./writer.js";

export type ApplyResult = {
  /** The command that made it: Undo of this Apply names it. */
  command: string;
  /** The live copies appended. */
  copies: TreeRecord[];
  /** Pending records still pending, whatever the reason. */
  left: TreeRecord[];
  /** Records that cannot land, with whatever stands on them. */
  cannot: TreeRecord[];
  /** Records that cannot land and that the draft itself later overrode: settled, not left. */
  superseded: TreeRecord[];
  /** True when what could land is tied to what could not, so nothing was taken. */
  blocked: boolean;
  /** The list's state vector right after the Apply: what Undo of the Apply compares against. */
  mark: Uint8Array;
};

function needs(record: TreeRecord): string[] {
  if (record.type === "create") return [record.parent];
  if (record.type === "move") return [record.node, record.parent];
  return [record.node];
}

/** The fact a record sets: a later record of the same fact overrides an earlier one. */
function factOf(record: TreeRecord): string {
  if (record.type === "rename") return `name:${record.node}`;
  if (record.type === "move") return `place:${record.node}`;
  if (record.type === "delete" || record.type === "restore") return `presence:${record.node}`;
  return `create:${record.node}`;
}

/**
 * The chosen records plus the drafted creates they stand on, and the earlier drafted records on
 * the same fact (applying a second rename brings the first, or the draft would read the first
 * after it).
 */
export function prerequisites(
  pending: readonly TreeRecord[],
  only: readonly string[],
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
    for (const node of needs(record)) {
      const creator = created.get(node);
      if (creator && creator !== id) stack.push(creator);
    }
    for (const earlier of pending.slice(0, position.get(id) ?? 0))
      if (factOf(earlier) === factOf(record)) stack.push(earlier.id);
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
 * has landed, which is the writer's cue that it can now be applied.
 */
function keepsView(
  live: readonly TreeRecord[],
  pending: readonly TreeRecord[],
  chosen: ReadonlySet<string>,
  without: ReadonlySet<string>,
): boolean {
  const draft = pending[0]?.draft ?? null;
  const rest = pending.filter((record) => !without.has(record.id));
  const before = fingerprint(replay([...live, ...rest], { draft }), false);
  const after = [
    ...live,
    ...rest
      .filter((record) => chosen.has(record.id))
      .map((record) => ({ ...record, draft: null, fromDraft: draft ?? undefined }) as TreeRecord),
    ...rest.filter((record) => !chosen.has(record.id)),
  ];
  return fingerprint(replay(after, { draft }), false) === before;
}

/**
 * Apply a Work, whole or in part: appends a live copy of each chosen record, and settles the
 * drafted ones applied, in one transaction. A copy keeps who drafted it and adds who applied it.
 *
 * Two kinds of record cannot land: one the Work's view skips (a move that would put a folder
 * inside itself, rule 1), and a move or rename of a node live has in Trash (the view keeps it
 * standing only because the change is pending, rule 7). They stay pending with whatever stands
 * on them, so the writer can fix the cause and apply again, or discard them. When the records
 * that could land are tied to one that cannot, such that taking them alone would change what the
 * Work's tree showed, nothing is taken (`blocked`).
 */
export function applyDraft(
  writer: TreeWriter,
  draft: string,
  appliedBy: Actor,
  command: string,
  only?: readonly string[],
): ApplyResult {
  const { doc } = writer;
  assertNewCommand(doc, command);
  const view = writer.view({ draft });
  const pending = pendingRecords(doc, draft);
  const skipped = new Set(view.skipped.map((skip) => skip.record));
  const live = viewRecords(doc, LIVE);
  const asCopy = (record: TreeRecord) =>
    ({ ...record, draft: null, fromDraft: draft }) as TreeRecord;
  const gone = (record: TreeRecord) =>
    (record.type === "move" || record.type === "rename") &&
    view.nodes.get(record.node)?.keptByPending;
  // A move or rename of a node live has in Trash cannot land, unless the rest of the Apply
  // makes the node stand in live (something of this Work's lands inside the folder).
  const afterRest = replay([
    ...live,
    ...pending.filter((record) => !skipped.has(record.id) && !gone(record)).map(asCopy),
  ]);
  const cannot = pending.filter(
    (record) =>
      skipped.has(record.id) ||
      (gone(record) && afterRest.nodes.get(record.node)?.trashed !== false),
  );
  const leftIds = dependents(
    pending,
    cannot.map((record) => record.id),
  );
  const wanted = only ? prerequisites(pending, only) : new Set(pending.map((record) => record.id));
  const landing = new Set([...wanted].filter((id) => !leftIds.has(id)));
  const cannotLand = pending.filter((record) => leftIds.has(record.id));
  const nothing = (blocked: boolean): ApplyResult => ({
    command,
    copies: [],
    left: pending,
    cannot: cannotLand,
    superseded: [],
    blocked,
    mark: Y.encodeStateVector(doc),
  });
  if (landing.size === 0) return nothing(false);
  // What lands must be what the Work's view showed of it: take the selection if the view, read
  // without the records that cannot land, is the same after; else the drafted records up to the
  // last chosen one, less what cannot land; else nothing.
  let chosen: Set<string> | undefined;
  if (keepsView(live, pending, landing, leftIds)) chosen = landing;
  else {
    const last = Math.max(...pending.flatMap((record, at) => (landing.has(record.id) ? [at] : [])));
    const prefix = new Set(
      pending
        .slice(0, last + 1)
        .map((record) => record.id)
        .filter((id) => !leftIds.has(id)),
    );
    if (keepsView(live, pending, prefix, leftIds)) chosen = prefix;
  }
  if (!chosen) return nothing(true);
  const taken = chosen;
  // A record that cannot land and that a later landing record on the same fact overrides is
  // settled as superseded: left pending, it would come back later and undo that later choice.
  const superseded = cannotLand.filter((record) =>
    pending
      .slice(pending.indexOf(record) + 1)
      .some((later) => taken.has(later.id) && factOf(later) === factOf(record)),
  );
  const overridden = new Set(superseded.map((record) => record.id));

  // A copy's `from` is what live had just before it, as the copies before it leave live. And it
  // carries the name the writer saw: where the Work's tree, as it will read once what can land
  // has landed, shows the node's name numbered, the clash was visible to the one applying, so
  // the record that gave the name holds the numbered one (design, section 4) and a later change
  // to its sibling cannot flip it back.
  const liveNow = writer.view(LIVE);
  const reads = replay([...live, ...pending.filter((record) => !leftIds.has(record.id))], {
    draft,
  });
  const was = new Map<string, { name: string; parent: string; rank: string }>();
  const stands = (node: string) => was.get(node) ?? liveNow.nodes.get(node);
  const lastNamed = new Map<string, string>();
  for (const record of pending)
    if (taken.has(record.id) && (record.type === "create" || record.type === "rename"))
      lastNamed.set(record.node, record.id);
  const copies: TreeRecord[] = [];
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
    if (copy.type === "create" || copy.type === "rename") {
      const shown = reads.nodes.get(copy.node);
      if (lastNamed.get(copy.node) === record.id && shown?.name === copy.name)
        copy.name = shown.displayName;
    }
    if (copy.type === "create")
      was.set(copy.node, { name: copy.name, parent: copy.parent, rank: copy.rank });
    else if (before && copy.type === "move")
      was.set(copy.node, { ...before, parent: copy.parent, rank: copy.rank });
    else if (before && copy.type === "rename") was.set(copy.node, { ...before, name: copy.name });
    copies.push(writable(copy));
  }
  writer.transact(() => {
    recordsOf(doc).push(copies);
    writer.settle(appliedBy, [...taken], "applied", { command });
    writer.settle(appliedBy, [...overridden], "superseded", { command });
  });
  return {
    command,
    copies,
    left: pending.filter((record) => !taken.has(record.id) && !overridden.has(record.id)),
    cannot: cannotLand.filter((record) => !overridden.has(record.id)),
    superseded,
    blocked: false,
    mark: Y.encodeStateVector(doc),
  };
}

/** Discard, whole or in part: the chosen records and every drafted record that stands on them. */
export function discardDraft(
  writer: TreeWriter,
  draft: string,
  by: Actor,
  command: string,
  only?: readonly string[],
): string[] {
  assertNewCommand(writer.doc, command);
  const pending = pendingRecords(writer.doc, draft);
  const chosen = only ? dependents(pending, only) : new Set(pending.map((record) => record.id));
  writer.transact(() => writer.settle(by, [...chosen], "discarded", { command }));
  return [...chosen];
}

/** Why a restored record would have nothing to act on: what it stands on is gone. */
const GONE: ReadonlySet<SkipReason> = new Set(["purged", "missing-node", "missing-parent"]);

/**
 * Whether the records a command settled would still fit if they were pending again, with
 * `undone` live copies taken out: none of them is left with a node or a folder that is gone.
 * (One that conflicts with something later, such as a move that would now loop, is pending like
 * any other the review shows as "couldn't apply".)
 */
function stillFit(writer: TreeWriter, restored: ReadonlySet<string>, undone: readonly string[]) {
  const settled = settlementsOf(writer.doc);
  for (const id of undone) settled.set(id, "undone");
  for (const id of restored) settled.delete(id);
  const drafts = new Set(
    listRecords(writer.doc).flatMap((record) =>
      restored.has(record.id) && record.draft ? [record.draft] : [],
    ),
  );
  return [...drafts].every((draft) =>
    replay(viewRecords(writer.doc, { draft }, settled), { draft }).skipped.every(
      (skip) => !restored.has(skip.record) || !GONE.has(skip.reason),
    ),
  );
}

/**
 * Undo of an Apply, by the simple rule (design section 5): allowed only while nothing has been
 * admitted to the list since, by anyone, anywhere. `mark` is the list's state vector taken right
 * after the Apply (on the server: the journal's head). A record that lands earlier in the list
 * but was admitted later moves the state vector too, so it counts. Text is not in the list:
 * `writtenSince` holds documents the Apply created that have text written since. Its live copies
 * leave the replay and everything its command settled, the superseded records too, is pending
 * again, unless one of them no longer fits.
 */
export function undoApply(
  writer: TreeWriter,
  applied: string,
  mark: Uint8Array,
  by: Actor,
  command: string,
  writtenSince: ReadonlySet<string> = new Set(),
): "undone" | "gone" | "superseded" {
  assertNewCommand(writer.doc, command);
  const now = Y.encodeStateVector(writer.doc);
  if (now.length !== mark.length || now.some((byte, at) => byte !== mark[at])) return "gone";
  const settled = settledBy(writer, applied, "applied", "superseded");
  const all = new Map(listRecords(writer.doc).map((record) => [record.id, record]));
  const landed = new Set(
    settled.flatMap(([id, to]) => {
      const record = all.get(id);
      return to === "applied" && record ? [record.carries ?? record.id] : [];
    }),
  );
  const copies = viewRecords(writer.doc, LIVE).filter(
    (record) => record.carries !== undefined && landed.has(record.carries),
  );
  if (copies.some((copy) => copy.type === "create" && writtenSince.has(copy.node))) return "gone";
  const restored = new Set(settled.map(([id]) => id));
  const undone = copies.map((copy) => copy.id);
  if (!stillFit(writer, restored, undone)) return "superseded";
  writer.transact(() => {
    writer.settle(by, undone, "undone", { command });
    writer.settle(by, [...restored], "pending", { command });
  });
  return "undone";
}

/** What one Discard command settled, for Trash to show as an entry. */
export type DiscardedBy = {
  /** The records it discarded, in list order. */
  records: TreeRecord[];
  /** The nodes those records created. */
  created: string[];
  /** Restored already: copies of these records are pending again. */
  restored: boolean;
};

/** The records a Discard command settled, with the nodes they created. */
export function discardedBy(doc: Y.Doc, discarded: string): DiscardedBy {
  const last = lastSettlements(doc);
  const all = listRecords(doc);
  const records = all.filter((record) => {
    const settle = last.get(record.id);
    return settle?.to === "discarded" && settle.command === discarded;
  });
  return {
    records,
    created: records.flatMap((record) => (record.type === "create" ? [record.node] : [])),
    restored: all.some((record) => record.restores === discarded),
  };
}

/**
 * Restoring a Discard: a Discard is final, so its records stay discarded and the Work gets fresh
 * pending copies of them, on `draft` (the Work's current branch, which may not be the one the
 * Discard closed), after anything it drafted since (so on a fact both touched, the restored
 * change wins; each pending record a copy overrides is settled discarded under `command`, so
 * restoring that command brings it back as a copy that wins in turn). A copy has a new id and the same node id; `carries` names the original, `restores`
 * the Discard and `restoredBy` who restored it, while `actor` stays who drafted it. A
 * record whose node cannot be acted on once the copies are in (purged, or its create is not in
 * force and no copy brings it back) is left out and returned. Once.
 */
export function restoreDiscard(
  writer: TreeWriter,
  discarded: string,
  by: Actor,
  draft: string,
  command: string,
): { copies: TreeRecord[]; leftOut: TreeRecord[] } | "superseded" {
  const { doc } = writer;
  assertNewCommand(doc, command);
  const { records, restored } = discardedBy(doc, discarded);
  if (restored || records.length === 0) return "superseded";
  // The node a copy acts on stands in its Work's view, or the Discard held its create and the
  // copy of that brings it back.
  const view = writer.view({ draft });
  const created = new Set(
    records.flatMap((record) => (record.type === "create" ? [record.node] : [])),
  );
  const copies: TreeRecord[] = [];
  const leftOut: TreeRecord[] = [];
  for (const record of records) {
    if (!created.has(record.node) && !placeIn(view.nodes, record.node)) leftOut.push(record);
    else
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
  // A create or delete overrides nothing; a restore overrides a pending delete of the node.
  const overrides = (copy: TreeRecord, pending: TreeRecord) =>
    copy.node === pending.node &&
    (copy.type === "restore"
      ? pending.type === "delete"
      : (copy.type === "rename" || copy.type === "move") && pending.type === copy.type);
  const overridden = pendingRecords(doc, draft)
    .filter((pending) => copies.some((copy) => overrides(copy, pending)))
    .map((pending) => pending.id);
  writer.transact(() => {
    writer.settle(by, overridden, "discarded", { command });
    recordsOf(doc).push(copies);
  });
  return { copies, leftOut };
}

/** The records a command settled with one of these, and nothing since has settled again. */
function settledBy(writer: TreeWriter, command: string, ...to: Settlement[]) {
  return [...lastSettlements(writer.doc)]
    .filter(([, settle]) => settle.command === command && to.includes(settle.to))
    .map(([id, settle]) => [id, settle.to] as const);
}
