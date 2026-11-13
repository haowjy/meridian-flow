import type * as Y from "yjs";
import {
  recordsOf,
  type Settlement,
  type SettleRecord,
  settleLogOf,
  type TreeRecord,
} from "./record.js";
import { replay, type TreeProjection } from "./replay.js";

/** Live (`draft: null`), or live and then one Work's pending records. */
export type View = { draft: string | null };
export const LIVE: View = { draft: null };

/** Each record's last settlement in list order; a record with none is pending (or live). */
export function lastSettlements(doc: Y.Doc): Map<string, SettleRecord & { to: Settlement }> {
  const state = new Map<string, SettleRecord & { to: Settlement }>();
  for (const settle of settleLogOf(doc).toArray())
    for (const target of settle.targets)
      if (settle.to === "pending") state.delete(target);
      else state.set(target, settle as SettleRecord & { to: Settlement });
  return state;
}

/** A record's state is its last settlement. */
export function settlementsOf(doc: Y.Doc): Map<string, Settlement> {
  return new Map([...lastSettlements(doc)].map(([id, settle]) => [id, settle.to]));
}

/**
 * The records a view replays, in replay order: the live ones, then the Work's pending ones. A
 * record id counts once (a client that sends a record again after rebuilding its copy adds
 * nothing). A refused record is in no view, and nor is a live copy whose Apply was taken back.
 * `settled` is what each record's last settlement is, for reading the view as a settlement
 * would leave it.
 */
export function viewRecords(
  doc: Y.Doc,
  view: View,
  settled: ReadonlyMap<string, Settlement> = settlementsOf(doc),
): TreeRecord[] {
  const seen = new Set<string>();
  const all: TreeRecord[] = [];
  for (const record of recordsOf(doc).toArray()) {
    if (seen.has(record.id)) continue;
    seen.add(record.id);
    all.push(record);
  }
  const live = all.filter(
    (record) =>
      record.draft === null &&
      settled.get(record.id) !== "undone" &&
      settled.get(record.id) !== "refused",
  );
  if (view.draft === null) return live;
  return [
    ...live,
    ...all.filter((record) => record.draft === view.draft && !settled.has(record.id)),
  ];
}

/** The Work's pending records, in order. */
export function pendingRecords(doc: Y.Doc, draft: string): TreeRecord[] {
  return viewRecords(doc, { draft }).filter((record) => record.draft === draft);
}

/** `pendingText`: documents the Work holds a pending text draft of, which the list cannot see. */
export function replayView(
  doc: Y.Doc,
  view: View,
  pendingText?: ReadonlySet<string>,
): TreeProjection {
  return replay(viewRecords(doc, view), { draft: view.draft, pendingText });
}
