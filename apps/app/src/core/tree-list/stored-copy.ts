/**
 * The browser's stored copy of one tree list, shared by the browser's tabs: a Yjs document kept
 * in `y-indexeddb`, and a channel that carries each tab's records to the others. Every tab gets
 * a Yjs client id of its own (a fresh `Y.Doc`), so two tabs never fork one id; the stored copy
 * holds every id that ever wrote to it.
 *
 * A fresh copy after the server broke the connection (or named another list) starts the next
 * generation of the stored database. The records the old copy held are written into it (the
 * `carried` key) before the old generation goes, so they survive whichever tab owns the connection
 * next, until the new copy holds them. The `list` key is the id of the server's list the copy is of.
 */
import {
  clientMayWrite,
  listRecords,
  readRecords,
  recordsOf,
  type TreeRecord,
} from "@meridian/project-tree";
import type { ListCopy, Replacement } from "@meridian/tree-list-sync";
import { IndexeddbPersistence } from "y-indexeddb";
import * as Y from "yjs";

/** Ids below this are the server's; an admission refuses a client that uses one. */
const FIRST_CLIENT_ID = 1000;
const RELAY = Symbol("tree-list-relay");

/** `y-indexeddb`'s object stores: the Yjs updates, and the key-value store for the rest. */
const UPDATES_STORE = "updates";
const CUSTOM_STORE = "custom";
const CARRIED_KEY = "carried";
const LIST_KEY = "list";

/**
 * Every message names the generation it is about, and a tab hears only its own: a write made
 * against a generation that has been retired is the sender's to carry over (`reset`).
 */
type Body =
  | { kind: "update"; update: Uint8Array }
  | { kind: "hello"; stateVector: Uint8Array; reply: boolean }
  /**
   * The owner replaced the copy: every tab starts over on this generation, of `listId`. After a
   * recovery a tab writes again what it made that the owner did not carry; after a discard
   * (another list) nothing.
   */
  | { kind: "reset"; listId: string | null; carriedIds: string[] | "discard" }
  | { kind: "settled" }
  | { kind: "status"; status: string };
type Message = Body & { generation: number };

function newDoc(): Y.Doc {
  const doc = new Y.Doc({ gc: false });
  while (doc.clientID < FIRST_CLIENT_ID) doc.clientID = Math.floor(Math.random() * 2 ** 32);
  return doc;
}

export class StoredListCopy implements ListCopy {
  doc: Y.Doc = newDoc();
  /** Settles when the stored copy has been read into `doc`. */
  loaded!: Promise<void>;
  private persistence!: IndexeddbPersistence;
  private readonly channel: BroadcastChannel;
  private readonly listeners = new Set<() => void>();
  private closed = false;
  private generation: number;
  private carriedRecords: readonly TreeRecord[] = [];
  private storedListId: string | null = null;

  constructor(
    private readonly name: string,
    /** What the tab owning the connection says about it, for a peer that asks or hears it change. */
    private readonly onPeerStatus: (status: string) => void,
    private readonly currentStatus: () => string | null,
  ) {
    this.generation = Number(localStorage.getItem(this.generationKey) ?? 0);
    this.channel = new BroadcastChannel(`meridian:tree-list:v1:${name}`);
    this.channel.onmessage = ({ data }: MessageEvent<Message>) => this.receive(data);
    this.open(this.doc, this.generation);
  }

  private get generationKey() {
    return `${this.name}:generation`;
  }

  private databaseName(generation: number) {
    return generation === 0 ? this.name : `${this.name}:${generation}`;
  }

  /**
   * Makes `doc` the copy and stores it in `generation`'s database. `fresh` is what a replacement
   * puts into it, stored before the copy is said to be loaded; a tab joining one reads it.
   */
  private open(
    doc: Y.Doc,
    generation: number,
    fresh?: { carried: readonly TreeRecord[]; listId: string | null },
  ) {
    this.doc = doc;
    this.generation = generation;
    const persistence = new IndexeddbPersistence(this.databaseName(generation), doc);
    this.persistence = persistence;
    doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin !== RELAY && this.doc === doc) this.post({ kind: "update", update });
    });
    this.loaded = persistence.whenSynced.then(async () => {
      if (fresh) {
        this.carriedRecords = fresh.carried;
        this.storedListId = fresh.listId;
        await this.commit([CUSTOM_STORE], (custom) => {
          custom.put(fresh.carried, CARRIED_KEY);
          if (fresh.listId !== null) custom.put(fresh.listId, LIST_KEY);
        });
      } else {
        // Written by another tab, perhaps of an older build: read like any list value.
        const carried: unknown = await persistence.get(CARRIED_KEY);
        this.carriedRecords = Array.isArray(carried) ? readRecords(carried) : [];
        const listId: unknown = await persistence.get(LIST_KEY);
        this.storedListId = typeof listId === "string" ? listId : null;
      }
      this.post({ kind: "hello", stateVector: Y.encodeStateVector(doc), reply: false });
    });
    for (const listener of this.listeners) listener();
  }

  /** Runs a write on the open database and settles once the browser has committed it. */
  private commit(stores: string[], write: (store: IDBObjectStore) => void) {
    const db = this.persistence.db;
    if (!db) throw new Error("The stored tree list is not open");
    const transaction = db.transaction(stores, "readwrite");
    // Both stores in one transaction, so it commits after every write already queued on either.
    write(transaction.objectStore(stores.at(-1) as string));
    return new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  }

  private post(message: Body) {
    if (!this.closed) this.channel.postMessage({ generation: this.generation, ...message });
  }

  private receive(message: Message) {
    if (this.closed) return;
    if (message.kind === "reset") {
      if (message.generation > this.generation) this.followReset(message);
      return;
    }
    if (message.generation !== this.generation) return;
    switch (message.kind) {
      case "update":
        Y.applyUpdate(this.doc, message.update, RELAY);
        return;
      case "hello": {
        this.post({
          kind: "update",
          update: Y.encodeStateAsUpdate(this.doc, message.stateVector),
        });
        if (!message.reply)
          this.post({
            kind: "hello",
            stateVector: Y.encodeStateVector(this.doc),
            reply: true,
          });
        const status = this.currentStatus();
        if (status !== null) this.post({ kind: "status", status });
        return;
      }
      case "status":
        this.onPeerStatus(message.status);
        return;
      case "settled":
        this.carriedRecords = [];
        return;
    }
  }

  /** The connection's state, for the tabs that do not own it. */
  announceStatus(status: string) {
    this.post({ kind: "status", status });
  }

  listId(): string | null {
    return this.storedListId;
  }

  async setListId(id: string) {
    this.storedListId = id;
    await this.persistence.set(LIST_KEY, id);
  }

  carried(): readonly TreeRecord[] {
    return this.carriedRecords;
  }

  async settleCarried() {
    this.carriedRecords = [];
    this.post({ kind: "settled" });
    // After the records appended again are in the stored copy: one transaction over both stores.
    await this.commit([UPDATES_STORE, CUSTOM_STORE], (custom) => custom.delete(CARRIED_KEY));
  }

  /**
   * The replacement after the server broke the connection or named another list: the next
   * generation holds what the old copy carries, and only then is the old one retired. The swap
   * itself is immediate, so a record written meanwhile goes into the copy that survives.
   */
  async replace(replacement: Replacement) {
    const old = { persistence: this.persistence, generation: this.generation };
    const carried = replacement.kind === "recover" ? replacement.carried : [];
    this.open(newDoc(), old.generation + 1, { carried, listId: replacement.listId });
    await this.loaded;
    localStorage.setItem(this.generationKey, String(this.generation));
    this.post({
      kind: "reset",
      listId: replacement.listId,
      carriedIds: replacement.kind === "recover" ? carried.map((record) => record.id) : "discard",
    });
    await old.persistence.destroy();
    // Blocked until every tab has let go of the old copy, then done.
    indexedDB.deleteDatabase(this.databaseName(old.generation));
  }

  /**
   * The owner replaced the copy. This tab starts over on the new generation at once. After a
   * recovery it writes again what it made that the owner had not yet carried, through the filter
   * the owner's own append uses; after a discard the old list's records go with it.
   */
  private followReset(message: Message & { kind: "reset" }) {
    const carried = message.carriedIds === "discard" ? null : new Set(message.carriedIds);
    const late = carried
      ? listRecords(this.doc).filter((record) => !carried.has(record.id) && clientMayWrite(record))
      : [];
    const retired = this.persistence;
    this.open(newDoc(), message.generation);
    this.storedListId = message.listId;
    if (late.length > 0) this.doc.transact(() => recordsOf(this.doc).push(late));
    void retired.destroy();
  }

  /** Called when `doc` is replaced. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close() {
    this.closed = true;
    this.channel.close();
    this.listeners.clear();
    void this.persistence.destroy();
  }
}
