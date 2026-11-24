import type { LoroDoc } from "loro-crdt";
import { listMark, listOf } from "./list-doc.js";
import type { TreeRecord } from "./record.js";
import { standingOf } from "./replay.js";
import { listRecords } from "./view.js";

export type DraftedFate = "pending" | "applied" | "replaced" | "discarded";

export type RecordSettled = {
  fate: Exclude<DraftedFate, "pending"> | "dropped";
  command: string | undefined;
  at: number;
};

type Index = {
  records: Map<string, TreeRecord>;
  drafted: Map<string, string[]>;
  settled: Map<string, RecordSettled>;
  standing: Set<string>;
};

const indexes = new WeakMap<LoroDoc, Index & { mark: string }>();

function indexOf(doc: LoroDoc): Index {
  const mark = listMark(doc);
  const held = indexes.get(doc);
  if (held?.mark === mark) return held;
  const records = new Map<string, TreeRecord>();
  const drafted = new Map<string, string[]>();
  const all = listRecords(doc);
  for (const record of all) {
    records.set(record.id, record);
    if (record.draft === null) continue;
    const root = record.carries ?? record.id;
    drafted.set(root, [...(drafted.get(root) ?? []), record.id]);
  }
  const settled = new Map<string, RecordSettled>();
  listOf(doc)
    .settles()
    .forEach((settle, at) => {
      for (const target of settle.targets) {
        if (settle.to === "pending") {
          settled.delete(target);
          continue;
        }
        const fate =
          settle.to === "applied" ||
          (settle.to === "superseded" && records.get(target)?.type === "create")
            ? "applied"
            : settle.to === "superseded"
              ? "replaced"
              : settle.to;
        settled.set(target, { fate, command: settle.command, at });
      }
    });
  const index = {
    mark,
    records,
    drafted,
    settled,
    standing: standingOf(all.filter((record) => record.draft !== null)),
  };
  indexes.set(doc, index);
  return index;
}

export function settledRecords(doc: LoroDoc): ReadonlyMap<string, RecordSettled> {
  return indexOf(doc).settled;
}

export function newestDrafted(doc: LoroDoc, ids: readonly string[]): Map<string, TreeRecord> {
  const { records, drafted } = indexOf(doc);
  const newest = new Map<string, TreeRecord>();
  for (const id of ids) {
    const record = records.get(id);
    const copy = record && drafted.get(record.carries ?? record.id)?.at(-1);
    const found = copy && records.get(copy);
    if (found) newest.set(id, found);
  }
  return newest;
}

export function draftedFates(doc: LoroDoc, ids: readonly string[]): Map<string, DraftedFate> {
  const { settled, standing } = indexOf(doc);
  const copies = newestDrafted(doc, ids);
  const fates = new Map<string, DraftedFate>();
  for (const id of ids) {
    const newest = copies.get(id)?.id;
    const fate = !newest
      ? "discarded"
      : (settled.get(newest)?.fate ?? (standing.has(newest) ? "pending" : "discarded"));
    fates.set(id, fate === "dropped" ? "discarded" : fate);
  }
  return fates;
}

export function appliedBy(doc: LoroDoc, ids: readonly string[]): Map<string, string> {
  const { settled } = indexOf(doc);
  const by = new Map<string, string>();
  for (const [id, newest] of newestDrafted(doc, ids)) {
    const settlement = settled.get(newest.id);
    if (settlement?.fate === "applied" && settlement.command) by.set(id, settlement.command);
  }
  return by;
}
