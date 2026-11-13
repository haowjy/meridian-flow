/**
 * The browser's stored copy of one tree list, shared by the browser's tabs: a Yjs document kept
 * in `y-indexeddb`, and a channel that carries each tab's records to the others. Every tab gets
 * a Yjs client id of its own (a fresh `Y.Doc`), so two tabs never fork one id; the stored copy
 * holds every id that ever wrote to it.
 */
import type { ListCopy } from "@meridian/tree-list-sync";
import { IndexeddbPersistence } from "y-indexeddb";
import * as Y from "yjs";

/** Ids below this are the server's; an admission refuses a client that uses one. */
const FIRST_CLIENT_ID = 1000;
const RELAY = Symbol("tree-list-relay");

type Message =
  | { kind: "update"; update: Uint8Array }
  | { kind: "hello"; stateVector: Uint8Array; reply: boolean }
  /** The owner's copy was rebuilt: every tab throws its own away and asks the owner for the new one. */
  | { kind: "reset"; generation: number }
  | { kind: "status"; status: string };

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
  /**
   * Which stored database is the copy: a rebuild opens the next one and the old one is deleted
   * once every tab has let go of it, so a tab never waits on another's connection to delete.
   */
  private generation: number;

  constructor(
    private readonly name: string,
    /** What the tab owning the connection says about it, for a peer that asks or hears it change. */
    private readonly onPeerStatus: (status: string) => void,
    private readonly currentStatus: () => string | null,
  ) {
    this.generation = Number(localStorage.getItem(this.generationKey) ?? 0);
    this.channel = new BroadcastChannel(`meridian:tree-list:v1:${name}`);
    this.channel.onmessage = ({ data }: MessageEvent<Message>) => void this.receive(data);
    this.attach(this.doc);
  }

  private get generationKey() {
    return `${this.name}:generation`;
  }

  private databaseName(generation: number) {
    return generation === 0 ? this.name : `${this.name}:${generation}`;
  }

  private attach(doc: Y.Doc) {
    this.doc = doc;
    this.persistence = new IndexeddbPersistence(this.databaseName(this.generation), doc);
    doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin !== RELAY) this.post({ kind: "update", update });
    });
    this.loaded = this.persistence.whenSynced.then(() => {
      this.post({ kind: "hello", stateVector: Y.encodeStateVector(doc), reply: false });
    });
    for (const listener of this.listeners) listener();
  }

  private post(message: Message) {
    if (!this.closed) this.channel.postMessage(message);
  }

  private async receive(message: Message) {
    if (this.closed) return;
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
      case "reset":
        await this.persistence.destroy();
        this.generation = message.generation;
        this.attach(newDoc());
        return;
    }
  }

  /** The connection's state, for the tabs that do not own it. */
  announceStatus(status: string) {
    this.post({ kind: "status", status });
  }

  /** The rebuild after a whole refusal: the stored copy goes, and every tab starts over. */
  async replace() {
    const old = this.databaseName(this.generation);
    await this.persistence.destroy();
    this.generation += 1;
    localStorage.setItem(this.generationKey, String(this.generation));
    this.attach(newDoc());
    this.post({ kind: "reset", generation: this.generation });
    // Blocked until every tab has let go of the old copy, then done.
    indexedDB.deleteDatabase(old);
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
