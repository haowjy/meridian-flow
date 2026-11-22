import type { LoroDoc, LoroList } from "loro-crdt";
import type { SettleRecord, TreeRecord } from "./record.js";

/**
 * A copy of the list (the browser's, or the server's tree room): two append-only Loro lists,
 * `ops` and `settle`. Every reader here goes through `listOf`, so the records, the replay and the
 * rules are one for every copy.
 */
export interface ListDoc {
  records(): unknown[];
  settles(): SettleRecord[];
  recordCount(): number;
  settleCount(): number;
  pushRecords(records: readonly TreeRecord[]): void;
  pushSettles(settles: readonly SettleRecord[]): void;
  /** Runs `change` as one transaction, so what it appends travels as one update. */
  transact(change: () => void, origin: string): void;
}

const lists = new WeakMap<LoroDoc, ListDoc>();

export function listOf(doc: LoroDoc): ListDoc {
  const held = lists.get(doc);
  if (held) return held;
  const list = loroList(doc);
  lists.set(doc, list);
  return list;
}

/** Loro stores JSON values: a field left `undefined` is left out, as a reader treats it anyway. */
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function loroList(doc: LoroDoc): ListDoc {
  const ops: LoroList = doc.getList("ops");
  const settle: LoroList = doc.getList("settle");
  let depth = 0;
  // Readers compare records by identity across reads: hold the values read until the list grows
  // (the lists only append).
  let records: unknown[] = [];
  let settles: SettleRecord[] = [];
  return {
    records: () => {
      if (records.length !== ops.length) records = ops.toArray();
      return records;
    },
    settles: () => {
      if (settles.length !== settle.length) settles = settle.toArray() as SettleRecord[];
      return settles;
    },
    recordCount: () => ops.length,
    settleCount: () => settle.length,
    pushRecords: (records) => {
      for (const record of records) ops.push(plain(record));
    },
    pushSettles: (settles) => {
      for (const entry of settles) settle.push(plain(entry));
    },
    transact: (change, origin) => {
      depth++;
      try {
        change();
      } finally {
        depth--;
        if (depth === 0) doc.commit({ origin });
      }
    },
  };
}

/**
 * Whether a copy changed since `mark`: the lists never delete, so their lengths name a version of
 * the copy exactly, whoever appended.
 */
export function listMark(doc: LoroDoc): string {
  const list = listOf(doc);
  return `${list.recordCount()}/${list.settleCount()}`;
}
