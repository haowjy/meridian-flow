import * as Y from "yjs";

interface Range {
  client: number;
  clock: number;
  len: number;
}
interface Pair {
  deleted: Range[];
  inserted: Range[];
}
const META = "meridian:replacements";

const deletedSoFar = (transaction: Y.Transaction) =>
  new Map([...transaction.deleteSet.clients].map(([client, items]) => [client, items.length]));
function deletedSince(transaction: Y.Transaction, mark: Map<number, number>): Range[] {
  const out: Range[] = [];
  for (const [client, items] of transaction.deleteSet.clients)
    for (const item of items.slice(mark.get(client) ?? 0))
      out.push({ client, clock: item.clock, len: item.len });
  return out;
}

/**
 * PROTOTYPE (#1591). One splice: `remove` deletes a range and `insert` writes where it was. The
 * pair of what each did is left on the transaction, for whoever collects its update.
 */
export function replacing(doc: Y.Doc, remove: () => void, insert: () => void): void {
  doc.transact((transaction) => {
    const mark = deletedSoFar(transaction);
    remove();
    const deleted = deletedSince(transaction, mark);
    const client = doc.clientID,
      from = Y.getState(doc.store, client);
    insert();
    const to = Y.getState(doc.store, client);
    if (!deleted.length || to === from) return;
    const pairs = (transaction.meta.get(META) as Pair[] | undefined) ?? [];
    pairs.push({ deleted, inserted: [{ client, clock: from, len: to - from }] });
    transaction.meta.set(META, pairs);
  });
}
export const takeReplacements = (transaction: Y.Transaction): Pair[] =>
  (transaction.meta.get(META) as Pair[] | undefined) ?? [];

const pendingByDoc = new WeakMap<Y.Doc, Pair[]>();
/** Harness only: the splices recorded on `doc` by the patched `Y.Text` methods. */
export const pendingReplacements = (doc: Y.Doc): Pair[] | undefined => pendingByDoc.get(doc);

/**
 * Harness only: every `Y.Text` records `delete(i, n)` followed by `insert(i, ...)` at the same
 * index as one splice, the way `applyTextOp` runs one, so harnesses that write with raw Yjs calls
 * feed the planner what the real write would.
 */
export function installHarnessRecorder(): void {
  const proto = Y.Text.prototype as unknown as {
    delete(index: number, length: number): void;
    insert(index: number, value: string, attrs?: object): void;
    __recorded?: boolean;
  };
  if (proto.__recorded) return;
  proto.__recorded = true;
  const { delete: del, insert: ins } = proto;
  const last = new WeakMap<object, { index: number; deleted: Range[] }>();
  proto.delete = function (this: Y.Text, index: number, length: number) {
    const doc = this.doc;
    if (!doc) return del.call(this, index, length);
    doc.transact((transaction) => {
      const mark = deletedSoFar(transaction);
      del.call(this, index, length);
      last.set(this, { index, deleted: deletedSince(transaction, mark) });
    });
  };
  proto.insert = function (this: Y.Text, index: number, value: string, attrs?: object) {
    const doc = this.doc;
    if (!doc) return ins.call(this, index, value, attrs);
    const was = last.get(this);
    last.delete(this);
    const client = doc.clientID,
      from = Y.getState(doc.store, client);
    ins.call(this, index, value, attrs);
    const to = Y.getState(doc.store, client);
    if (!was || was.index !== index || !was.deleted.length || to === from) return;
    const pairs = pendingByDoc.get(doc) ?? [];
    pairs.push({ deleted: was.deleted, inserted: [{ client, clock: from, len: to - from }] });
    pendingByDoc.set(doc, pairs);
  };
}
