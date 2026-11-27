import type { LoroDoc, LoroList } from "loro-crdt";
import type { SettleRecord, TreeRecord } from "./record.js";

export interface ListDoc {
  records(): unknown[];
  settles(): SettleRecord[];
  recordCount(): number;
  settleCount(): number;
  pushRecords(records: readonly TreeRecord[]): void;
  pushSettles(settles: readonly SettleRecord[]): void;
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

const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function loroList(doc: LoroDoc): ListDoc {
  const ops: LoroList = doc.getList("ops");
  const settle: LoroList = doc.getList("settle");
  let depth = 0;
  // Cache decoded list values by identity between appends because readers compare records by identity
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

export function listMark(doc: LoroDoc): string {
  const list = listOf(doc);
  return `${list.recordCount()}/${list.settleCount()}`;
}
