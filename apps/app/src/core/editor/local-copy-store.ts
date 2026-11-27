import {
  type DocKey,
  decodeRoomVersion,
  encodeRoomVersion,
  mergeVersion,
  type RoomVersion,
} from "@meridian/document-model";

const VERSION = 1;
const SNAPSHOTS = "snapshots";
const UPDATES = "updates";
const META = "meta";
// Builds before saved frames stored the received version under this key; they read as saved.
export const SAVED_META = "server";
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

/** Merged into the stored mark, never over it: each tab writes its own view of the server. */
async function mergeMark(meta: IDBObjectStore, version: RoomVersion): Promise<void> {
  const stored = await request(meta.get(SAVED_META));
  const merged = stored instanceof Uint8Array ? decodeRoomVersion(stored) : new Map();
  mergeVersion(merged, version);
  meta.put(encodeRoomVersion(merged), SAVED_META);
}

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

  readMeta(key: string): Promise<unknown> {
    return request(this.db.transaction(META, "readonly").objectStore(META).get(key));
  }

  append(batch: Uint8Array): Promise<void> {
    return this.queue(async () => {
      const transaction = this.db.transaction(UPDATES, "readwrite");
      transaction.objectStore(UPDATES).add(batch);
      await done(transaction);
    });
  }

  compact(snapshots: ReadonlyMap<DocKey, Uint8Array>): Promise<void> {
    return this.queue(async () => {
      const transaction = this.db.transaction([SNAPSHOTS, UPDATES], "readwrite");
      const store = transaction.objectStore(SNAPSHOTS);
      for (const [key, bytes] of snapshots) store.put(bytes, key);
      transaction.objectStore(UPDATES).clear();
      await done(transaction);
    });
  }

  markSaved(version: RoomVersion): Promise<void> {
    return this.queue(async () => {
      const transaction = this.db.transaction(META, "readwrite");
      await mergeMark(transaction.objectStore(META), version);
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
