import { LoroDoc, type LoroList, VersionVector } from "loro-crdt";
import type * as Y from "yjs";
import type { SettleRecord, TreeRecord } from "./record.js";

/**
 * A copy of the list: a Yjs document (the browser's, until it moves to Loro) or a Loro document
 * (the server's tree room). Both hold the same two append-only lists, `ops` and `settle`, and
 * every reader here goes through `listOf`, so the records, the replay and the rules are one for
 * both. The Yjs half goes with the cutover.
 */
export type TreeDoc = Y.Doc | LoroDoc;

/** One copy's two lists, read and appended the same way whichever CRDT holds them. */
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

const yjsLists = new WeakMap<Y.Doc, ListDoc>();
const loroLists = new WeakMap<LoroDoc, ListDoc>();

export function listOf(doc: TreeDoc): ListDoc {
  if (doc instanceof LoroDoc) {
    const held = loroLists.get(doc);
    if (held) return held;
    const list = loroList(doc);
    loroLists.set(doc, list);
    return list;
  }
  const held = yjsLists.get(doc);
  if (held) return held;
  const list = yjsList(doc);
  yjsLists.set(doc, list);
  return list;
}

function yjsList(doc: Y.Doc): ListDoc {
  const ops = doc.getArray<unknown>("ops");
  const settle = doc.getArray<SettleRecord>("settle");
  return {
    records: () => ops.toArray(),
    settles: () => settle.toArray(),
    recordCount: () => ops.length,
    settleCount: () => settle.length,
    pushRecords: (records) => ops.push([...records]),
    pushSettles: (settles) => settle.push([...settles]),
    transact: (change, origin) => doc.transact(change, origin),
  };
}

/** Loro stores JSON values: a field left `undefined` is left out, as a reader treats it anyway. */
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function loroList(doc: LoroDoc): ListDoc {
  const ops: LoroList = doc.getList("ops");
  const settle: LoroList = doc.getList("settle");
  let depth = 0;
  // Readers compare records by identity across reads, as a Yjs array hands back the same values each
  // time: hold the values read until the list grows (the lists only append).
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
 * the copy exactly, whichever CRDT holds it and whoever appended.
 */
export function listMark(doc: TreeDoc): string {
  const list = listOf(doc);
  return `${list.recordCount()}/${list.settleCount()}`;
}

/** Whether the Loro copy holds every op a copy at version `saw` held. */
export function loroCovers(doc: LoroDoc, saw: Uint8Array): boolean {
  const have = doc.oplogVersion().toJSON();
  for (const [peer, counter] of VersionVector.decode(saw).toJSON())
    if ((have.get(peer) ?? 0) < counter) return false;
  return true;
}
