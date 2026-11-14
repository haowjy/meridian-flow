/**
 * The command journal in IndexedDB, one database per account. Every change is one `readwrite`
 * transaction, which the browser runs one at a time across tabs: it reads every record, decides,
 * and writes before it commits. The schema version never changes, so no tab waits on another's
 * upgrade; a connection that is asked to close does, and the next call reopens.
 */
import type { CommandRecord, Journal, JournalChange } from "@meridian/command-driver";

const RECORDS = "records";
const META = "meta";
const COUNTER = "nextSeq";

const settled = <T>(request: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

export function createIndexedDbJournal(accountId: string): Journal {
  let opened: Promise<IDBDatabase> | null = null;

  const open = () => {
    opened ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(`meridian-commands:${accountId}`, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore(RECORDS, { keyPath: "id" });
        request.result.createObjectStore(META);
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => {
          db.close();
          opened = null;
        };
        resolve(db);
      };
      request.onerror = () => reject(request.error);
    }).catch((cause) => {
      opened = null;
      throw cause;
    });
    return opened;
  };

  return {
    async transact(decide) {
      const db = await open();
      const tx = db.transaction([RECORDS, META], "readwrite");
      const [records, counter] = await Promise.all([
        settled(tx.objectStore(RECORDS).getAll() as IDBRequest<CommandRecord[]>),
        settled(tx.objectStore(META).get(COUNTER) as IDBRequest<number | undefined>),
      ]);
      let decision: ReturnType<typeof decide>;
      try {
        decision = decide({ records, nextSeq: counter ?? 1 });
      } catch (cause) {
        tx.abort();
        throw cause;
      }
      write(tx, decision.change);
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error ?? new DOMException("Aborted", "AbortError"));
      });
      return decision.result;
    },
    async read() {
      const db = await open();
      return settled(
        db.transaction(RECORDS).objectStore(RECORDS).getAll() as IDBRequest<CommandRecord[]>,
      );
    },
    close() {
      void opened?.then((db) => db.close());
      opened = null;
    },
  };
}

function write(tx: IDBTransaction, change: JournalChange) {
  const records = tx.objectStore(RECORDS);
  for (const record of change.put ?? []) records.put(record);
  for (const id of change.remove ?? []) records.delete(id);
  if (change.nextSeq !== undefined) tx.objectStore(META).put(change.nextSeq, COUNTER);
}
