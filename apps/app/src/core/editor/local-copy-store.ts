/**
 * The local copy of one room in IndexedDB (design §6, "The local copy"): a `snapshot` record per
 * doc key and an `updates` log of envelope batches, appended from local commits and remote imports
 * alike. Opening reads both; the session imports them, writes fresh snapshots and clears the log
 * (`compact`). The `meta` store keeps what the server is known to hold (`server`, a room
 * version) and the content-initialization marker.
 */
import type { DocKey } from "@meridian/document-model";

const VERSION = 1;
const SNAPSHOTS = "snapshots";
const UPDATES = "updates";
const META = "meta";
/** The room version the server is known to hold. */
export const SERVER_META = "server";
/** Set once the copy has held the server's content: its first sync. */
export const INITIALIZED_META = "content-initialization";

export type LoadedCopy = {
  snapshots: Map<DocKey, Uint8Array>;
  updates: Uint8Array[];
  meta: Map<string, unknown>;
};

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
  });
}

function done(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction failed"));
  });
}

export function openCopyDatabase(idb: IDBFactory, name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = idb.open(name, VERSION);
    open.onupgradeneeded = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains(SNAPSHOTS)) db.createObjectStore(SNAPSHOTS);
      if (!db.objectStoreNames.contains(UPDATES))
        db.createObjectStore(UPDATES, { autoIncrement: true });
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META);
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error ?? new Error("IndexedDB open failed"));
  });
}

export async function readCopy(db: IDBDatabase): Promise<LoadedCopy> {
  const transaction = db.transaction([SNAPSHOTS, UPDATES, META], "readonly");
  const snapshots = transaction.objectStore(SNAPSHOTS);
  const meta = transaction.objectStore(META);
  const [keys, values, updates, metaKeys, metaValues] = await Promise.all([
    request(snapshots.getAllKeys()),
    request(snapshots.getAll()),
    request(transaction.objectStore(UPDATES).getAll()),
    request(meta.getAllKeys()),
    request(meta.getAll()),
  ]);
  await done(transaction);
  return {
    snapshots: new Map(keys.map((key, i) => [String(key), values[i] as Uint8Array])),
    updates: updates as Uint8Array[],
    meta: new Map(metaKeys.map((key, i) => [String(key), metaValues[i]])),
  };
}

/**
 * One copy's store, open for a session. Writes are queued in order; `flushed()` settles once every
 * write issued so far is durable.
 */
export class LocalCopyStore {
  private chain: Promise<void> = Promise.resolve();
  private closed = false;

  private constructor(readonly db: IDBDatabase) {}

  static async open(idb: IDBFactory, name: string): Promise<LocalCopyStore> {
    return new LocalCopyStore(await openCopyDatabase(idb, name));
  }

  get name(): string {
    return this.db.name;
  }

  read(): Promise<LoadedCopy> {
    return readCopy(this.db);
  }

  /** Append one envelope batch to the log. */
  append(batch: Uint8Array): Promise<void> {
    return this.queue(async () => {
      const transaction = this.db.transaction(UPDATES, "readwrite");
      transaction.objectStore(UPDATES).add(batch);
      await done(transaction);
    });
  }

  /**
   * Replace the log with snapshots taken now. Writes run in order, so every batch appended before
   * this call is in the snapshots, and every one after is appended after the log is cleared.
   */
  compact(snapshots: ReadonlyMap<DocKey, Uint8Array>): Promise<void> {
    return this.queue(async () => {
      const transaction = this.db.transaction([SNAPSHOTS, UPDATES], "readwrite");
      const store = transaction.objectStore(SNAPSHOTS);
      for (const [key, bytes] of snapshots) store.put(bytes, key);
      transaction.objectStore(UPDATES).clear();
      await done(transaction);
    });
  }

  putMeta(key: string, value: unknown): Promise<void> {
    return this.queue(async () => {
      const transaction = this.db.transaction(META, "readwrite");
      transaction.objectStore(META).put(value, key);
      await done(transaction);
    });
  }

  flushed(): Promise<void> {
    return this.chain;
  }

  close(): Promise<void> {
    if (this.closed) return this.chain;
    this.closed = true;
    return this.chain.finally(() => this.db.close());
  }

  private queue(write: () => Promise<void>): Promise<void> {
    if (this.closed) return Promise.reject(new Error(`copy ${this.db.name} is closed`));
    const next = this.chain.then(write);
    this.chain = next.catch((error) => reportError(error));
    return next;
  }
}
