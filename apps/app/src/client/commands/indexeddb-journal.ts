import type { CommandRecord, Journal, JournalChange } from "@meridian/command-driver";
import { openIndexedDbDatabase, settled } from "@/core/indexeddb-database";

const RECORDS = "records";
const META = "meta";
const COUNTER = "nextSeq";

export function createIndexedDbJournal(accountId: string): Journal {
  const database = openIndexedDbDatabase(`meridian-commands:${accountId}`, (db) => {
    db.createObjectStore(RECORDS, { keyPath: "id" });
    db.createObjectStore(META);
  });

  return {
    transact: (decide) =>
      database.transact([RECORDS, META], "readwrite", async (tx) => {
        const [records, counter] = await Promise.all([
          settled(tx.objectStore(RECORDS).getAll() as IDBRequest<CommandRecord[]>),
          settled(tx.objectStore(META).get(COUNTER) as IDBRequest<number | undefined>),
        ]);
        const decision = decide({ records, nextSeq: counter ?? 1 });
        write(tx, decision.change);
        return decision.result;
      }),
    read: () =>
      database.transact([RECORDS], "readonly", (tx) =>
        settled(tx.objectStore(RECORDS).getAll() as IDBRequest<CommandRecord[]>),
      ),
    close: () => database.close(),
  };
}

function write(tx: IDBTransaction, change: JournalChange) {
  const records = tx.objectStore(RECORDS);
  for (const record of change.put ?? []) records.put(record);
  for (const id of change.remove ?? []) records.delete(id);
  if (change.nextSeq !== undefined) tx.objectStore(META).put(change.nextSeq, COUNTER);
}
