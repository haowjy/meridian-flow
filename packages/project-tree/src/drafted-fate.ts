import { listMark, listOf, type TreeDoc } from "./list-doc.js";
import type { TreeRecord } from "./record.js";
import { standingOf } from "./replay.js";
import { listRecords } from "./view.js";

/**
 * What became of a drafted record: `pending` while it, or the copy a restored Discard put back
 * in its Work, still waits; `applied` once an Apply took it (a create live already had standing
 * counts, as there is nothing left to land); `replaced` when it couldn't land and a later change
 * to the same fact landed in its place (`superseded`); `discarded` when a Discard or an Undo took
 * it, the server dropped it, or its list no longer holds it (a purge).
 */
export type DraftedFate = "pending" | "applied" | "replaced" | "discarded";

/**
 * One record's own last settlement, read as a fate: `dropped` is the server's stamp at
 * admission. `command` is the command that settled it, `at` its place in the settle log.
 */
export type RecordSettled = {
  fate: Exclude<DraftedFate, "pending"> | "dropped";
  command: string | undefined;
  at: number;
};

type Index = {
  records: Map<string, TreeRecord>;
  /** Each family's drafted records in list order: the original and a restored Discard's copies. */
  drafted: Map<string, string[]>;
  settled: Map<string, RecordSettled>;
  /**
   * The drafted records in force: an Undo in the Work's view took out the rest. A drafted record's
   * fate is the Work's, so live records don't count: an Un-Apply's live Undo of the Apply's copy
   * names the same family root, and must not take out the drafted record it reopened.
   */
  standing: Set<string>;
};

/**
 * One read of a copy's records and settlements, rebuilt only after the copy changed: every reader
 * of the same copy between two updates shares it.
 */
const indexes = new WeakMap<TreeDoc, Index & { mark: string }>();

function indexOf(doc: TreeDoc): Index {
  const mark = listMark(doc);
  const held = indexes.get(doc);
  if (held?.mark === mark) return held;
  const records = new Map<string, TreeRecord>();
  const drafted = new Map<string, string[]>();
  const all = listRecords(doc);
  for (const record of all) {
    records.set(record.id, record);
    // An Apply's live copies are what landed, which the drafted record's settlement already says.
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

/** Each record's own last settlement; a record absent from it is pending (or live). */
export function settledRecords(doc: TreeDoc): ReadonlyMap<string, RecordSettled> {
  return indexOf(doc).settled;
}

/**
 * The newest drafted copy of each record `ids` names, following its family: a Discard's restore
 * makes a new pending copy, in the Work's draft as it is now, and leaves the original discarded,
 * so the copy stands for the family. A live record, or an id the list doesn't hold, is absent.
 */
export function newestDrafted(doc: TreeDoc, ids: readonly string[]): Map<string, TreeRecord> {
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

/**
 * The fate of each drafted record `ids` names, read from its family's newest drafted copy
 * (`newestDrafted`). An id the list doesn't hold reads `discarded`.
 */
export function draftedFates(doc: TreeDoc, ids: readonly string[]): Map<string, DraftedFate> {
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

/**
 * The Apply command that took each drafted record `ids` names, following its family as
 * `draftedFates` does; a record no Apply took is absent.
 */
export function appliedBy(doc: TreeDoc, ids: readonly string[]): Map<string, string> {
  const { settled } = indexOf(doc);
  const by = new Map<string, string>();
  for (const [id, newest] of newestDrafted(doc, ids)) {
    const settlement = settled.get(newest.id);
    if (settlement?.fate === "applied" && settlement.command) by.set(id, settlement.command);
  }
  return by;
}
