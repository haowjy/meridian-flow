import type { LoroDoc } from "loro-crdt";
import { listOf } from "./list-doc.js";
import type { Settlement, SettleRecord, TreeRecord } from "./record.js";
import { type DroppedRecord, replay, type TreeProjection } from "./replay.js";
import { readStored } from "./validate.js";

export type View = { draft: string | null };
export const LIVE: View = { draft: null };

export function lastSettlements(doc: LoroDoc): Map<string, SettleRecord & { to: Settlement }> {
  const state = new Map<string, SettleRecord & { to: Settlement }>();
  for (const settle of listOf(doc).settles())
    for (const target of settle.targets)
      if (settle.to === "pending") state.delete(target);
      else state.set(target, settle as SettleRecord & { to: Settlement });
  return state;
}

export function settlementsOf(doc: LoroDoc): Map<string, Settlement> {
  return new Map([...lastSettlements(doc)].map(([id, settle]) => [id, settle.to]));
}

export function readRecords(values: readonly unknown[]): TreeRecord[] {
  return values.flatMap((value) => {
    const read = readStored(value);
    return read.ok ? [read.record] : [];
  });
}

export function listRecords(doc: LoroDoc): TreeRecord[] {
  return readRecords(listOf(doc).records());
}

const isRecord = (value: unknown): value is TreeRecord => readStored(value).ok;

export function viewValues(
  doc: LoroDoc,
  view: View,
  settled: ReadonlyMap<string, Settlement> = settlementsOf(doc),
): unknown[] {
  const seen = new Set<string>();
  const all: unknown[] = [];
  for (const value of listOf(doc).records()) {
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

export function viewRecords(
  doc: LoroDoc,
  view: View,
  settled?: ReadonlyMap<string, Settlement>,
): TreeRecord[] {
  return viewValues(doc, view, settled).filter(isRecord);
}

export function lastOfFamily(
  doc: LoroDoc,
  view: View,
  id: string,
): TreeRecord | "unknown" | undefined {
  const named = listRecords(doc).find((record) => record.id === id);
  if (!named) return "unknown";
  const root = named.carries ?? named.id;
  return viewRecords(doc, view)
    .filter((record) => (record.carries ?? record.id) === root)
    .pop();
}

export function pendingRecords(doc: LoroDoc, draft: string): TreeRecord[] {
  return viewRecords(doc, { draft }).filter((record) => record.draft === draft);
}

export function droppedRecords(doc: LoroDoc): DroppedRecord[] {
  const dropped = new Map(
    [...lastSettlements(doc)].filter(([, settle]) => settle.to === "dropped"),
  );
  if (dropped.size === 0) return [];
  return listRecords(doc).flatMap((record) => {
    const settle = dropped.get(record.id);
    return settle && record.type !== "purge" ? [{ record, reason: settle.reason ?? "" }] : [];
  });
}

export function replayView(doc: LoroDoc, view: View): TreeProjection {
  return {
    ...replay(viewValues(doc, view), { draft: view.draft }),
    dropped: droppedRecords(doc),
  };
}
