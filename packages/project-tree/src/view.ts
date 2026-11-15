import type * as Y from "yjs";
import { shownName } from "./names.js";
import {
  type CreateRecord,
  recordsOf,
  type Settlement,
  type SettleRecord,
  settleLogOf,
  type TreeRecord,
} from "./record.js";
import { type DroppedCreate, replay, type TreeProjection } from "./replay.js";
import { readStored } from "./validate.js";

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

/** The values that are records, each read through `readStored`, in order. */
export function readRecords(values: readonly unknown[]): TreeRecord[] {
  return values.flatMap((value) => {
    const read = readStored(value);
    return read.ok ? [read.record] : [];
  });
}

/** The list's records in order. A value that is no record is not among them: `viewValues` keeps it, for the replay to report. */
export function listRecords(doc: Y.Doc): TreeRecord[] {
  return readRecords(recordsOf(doc).toArray());
}

const isRecord = (value: unknown): value is TreeRecord => readStored(value).ok;

/**
 * What a view replays, in replay order: the live records, then the Work's pending ones. A record
 * id counts once (a client that sends a record again after rebuilding its copy adds nothing). A
 * dropped create is in no view. `settled` is
 * what each record's last settlement is, for reading the view as a settlement would leave it. A
 * value that is no record is kept where it stands in the list, in every view, and the replay
 * reports it as `unreadable`: nobody can tell which Work it belonged to.
 */
export function viewValues(
  doc: Y.Doc,
  view: View,
  settled: ReadonlyMap<string, Settlement> = settlementsOf(doc),
): unknown[] {
  const seen = new Set<string>();
  const all: unknown[] = [];
  for (const value of recordsOf(doc).toArray()) {
    const read = readStored(value);
    if (!read.ok) all.push(value);
    else if (!seen.has(read.record.id)) {
      seen.add(read.record.id);
      all.push(read.record);
    }
  }
  const live = all.filter(
    (value) => !isRecord(value) || (value.draft === null && settled.get(value.id) !== "dropped"),
  );
  if (view.draft === null) return live;
  return [
    ...live,
    ...all.filter(
      (value) => isRecord(value) && value.draft === view.draft && !settled.has(value.id),
    ),
  ];
}

/** `viewValues` without the values that are no record. */
export function viewRecords(
  doc: Y.Doc,
  view: View,
  settled?: ReadonlyMap<string, Settlement>,
): TreeRecord[] {
  return viewValues(doc, view, settled).filter(isRecord);
}

/**
 * The last record in force in the view that is the record `id` names or a copy of it, whichever
 * of the original or its copies `id` is (a copy always names the root original in `carries`).
 * "unknown" when no record of the list has that id; undefined when none of the family is in the
 * view.
 */
export function inForce(doc: Y.Doc, view: View, id: string): TreeRecord | "unknown" | undefined {
  const named = listRecords(doc).find((record) => record.id === id);
  if (!named) return "unknown";
  const root = named.carries ?? named.id;
  return viewRecords(doc, view)
    .filter((record) => (record.carries ?? record.id) === root)
    .pop();
}

/** The Work's pending records, in order. */
export function pendingRecords(doc: Y.Doc, draft: string): TreeRecord[] {
  return viewRecords(doc, { draft }).filter((record) => record.draft === draft);
}

/**
 * The creates the server stamped `dropped` at admission, each with what the writer made, for a
 * row that says "Work was closed" and hands back what they typed. The settle log and the records
 * together say it: the replay never sees a dropped create.
 */
export function droppedCreates(doc: Y.Doc): DroppedCreate[] {
  const dropped = [...lastSettlements(doc)].filter(([, settle]) => settle.to === "dropped");
  if (dropped.length === 0) return [];
  const creates = new Map<string, CreateRecord>();
  for (const record of listRecords(doc))
    if (record.type === "create") creates.set(record.id, record);
  return dropped.flatMap(([id, settle]) => {
    const create = creates.get(id);
    return create
      ? [
          {
            record: id,
            node: create.node,
            reason: settle.reason ?? "",
            parent: create.parent,
            name: shownName(create.kind, create.name),
          },
        ]
      : [];
  });
}

/** `pendingText`: documents the Work holds a pending text draft of, which the list cannot see. */
export function replayView(
  doc: Y.Doc,
  view: View,
  pendingText?: ReadonlySet<string>,
): TreeProjection {
  return {
    ...replay(viewValues(doc, view), { draft: view.draft, pendingText }),
    dropped: droppedCreates(doc),
  };
}
