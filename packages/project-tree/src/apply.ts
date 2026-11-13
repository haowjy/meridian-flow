import * as Y from "yjs";
import { type Actor, newId, recordsOf, type TreeRecord } from "./record.js";
import { replay } from "./replay.js";
import { fingerprint } from "./shape.js";
import { LIVE, lastSettlements, pendingRecords, viewRecords } from "./view.js";
import type { TreeWriter } from "./writer.js";

export type ApplyResult = {
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
export function applyLanding(
  writer: TreeWriter,
  draft: string,
  appliedBy: Actor,
  only: readonly string[] | undefined,
  command: string | undefined,
): ApplyResult {
  const { doc } = writer;
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

  const liveNow = writer.view(LIVE);
  const copies: TreeRecord[] = [];
  for (const record of pending) {
    if (!taken.has(record.id)) continue;
    const copy = {
      ...record,
      id: newId(),
      draft: null,
      appliedFrom: record.id,
      appliedBy,
      fromDraft: draft,
    } as TreeRecord;
    // The Undo of a live copy returns to where live had it, not where the draft saw it.
    if (copy.type === "move") {
      const at = liveNow.nodes.get(copy.node);
      if (at) copy.from = { parent: at.parent, rank: at.rank };
    }
    if (copy.type === "rename") copy.fromName = liveNow.nodes.get(copy.node)?.name ?? copy.fromName;
    copies.push(copy);
  }
  writer.transact(() => {
    recordsOf(doc).push(copies);
    writer.settle(appliedBy, [...taken], "applied", { command });
    writer.settle(appliedBy, [...overridden], "superseded", { command });
  });
  return {
    copies,
    left: pending.filter((record) => !taken.has(record.id) && !overridden.has(record.id)),
    cannot: cannotLand.filter((record) => !overridden.has(record.id)),
    superseded,
    blocked: false,
    mark: Y.encodeStateVector(doc),
  };
}

/** Discard, whole or in part: the chosen records and every drafted record that stands on them. */
export function discardPending(
  writer: TreeWriter,
  draft: string,
  only: readonly string[] | undefined,
  by: Actor,
  command: string | undefined,
): string[] {
  const pending = pendingRecords(writer.doc, draft);
  const chosen = only ? dependents(pending, only) : new Set(pending.map((record) => record.id));
  writer.transact(() => writer.settle(by, [...chosen], "discarded", { command }));
  return [...chosen];
}

/**
 * Undo of an Apply, by the simple rule (design section 5): allowed only while nothing has been
 * admitted to the list since, by anyone, anywhere. `mark` is the list's state vector taken right
 * after the Apply (on the server: the journal's head). A record that lands earlier in the list
 * but was admitted later moves the state vector too, so it counts. Text is not in the list:
 * `writtenSince` holds documents the Apply created that have text written since. Its live copies
 * leave the replay and its drafted records are pending again.
 */
export function undoApplyIfLast(
  writer: TreeWriter,
  copies: readonly TreeRecord[],
  mark: Uint8Array,
  by: Actor,
  writtenSince: ReadonlySet<string>,
  command: string | undefined,
): "undone" | "gone" {
  const now = Y.encodeStateVector(writer.doc);
  if (now.length !== mark.length || now.some((byte, at) => byte !== mark[at])) return "gone";
  if (copies.some((copy) => copy.type === "create" && writtenSince.has(copy.node))) return "gone";
  writer.transact(() => {
    writer.settle(
      by,
      copies.map((copy) => copy.id),
      "undone",
      { command },
    );
    writer.settle(
      by,
      copies.flatMap((copy) => (copy.appliedFrom ? [copy.appliedFrom] : [])),
      "pending",
      {
        command,
      },
    );
  });
  return "undone";
}

/** Undo of a Discard: the records that command discarded and nobody has settled since go back to pending. */
export function undoDiscard(
  writer: TreeWriter,
  discarded: string,
  by: Actor,
  command: string | undefined,
): string[] {
  const targets = [...lastSettlements(writer.doc)]
    .filter(([, settle]) => settle.to === "discarded" && settle.command === discarded)
    .map(([id]) => id);
  writer.transact(() => writer.settle(by, targets, "pending", { command }));
  return targets;
}
