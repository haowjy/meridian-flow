import type { ClosedOwnerWhy } from "@meridian/contracts/commands";
import type { DocumentRoom } from "@meridian/contracts/protocol";
import { loroRoomName, WS_CLOSE } from "@meridian/contracts/protocol";
import {
  batchEnd,
  type DocChange,
  type DocKey,
  type DocVersion,
  decodeRoomVersion,
  docCovers,
  encodeChanges,
  encodeEnvelope,
  encodeRoomVersion,
  freshPeerId,
  mergeVersion,
  RoomDocs,
  type RoomVersion,
  versionCovers,
} from "@meridian/document-model";
import {
  forwardLocalWrite,
  importRemoteUpdate,
  notifyChanged,
  registerDraft,
  UNTRACKED_ORIGIN,
  writeProseMirror,
} from "@meridian/loro-prosemirror";
import type { Editor } from "@tiptap/core";
import type { Node } from "@tiptap/pm/model";
import { requireReload } from "@/client/release/release";
import type {
  LoroRoomTransport,
  ResetDisposition,
  RoomConnectionState,
} from "@/core/transport/loro-room-transport";
import { DocumentHistory } from "./editor-history";
import { INITIALIZED_META, LocalCopyStore, SERVER_META } from "./local-copy-store";
import {
  createLocalPresence,
  type LocalPresence,
  type LocalPresenceFields,
} from "./local-presence";
import { documentShape } from "./room-content";
import type { SchemaFence } from "./schema-fence";
import { wordsBeyond } from "./unsent-words";

export type { SchemaFence } from "./schema-fence";

const LOCAL_PERSISTENCE_TRANSPORT_TIMEOUT_MS = 1_000;
const NOTE_SERVER_MS = 1_000;
const TAB_QUIET_MS = 2_000;
const COMPACT_EVERY = 200;

export type DocumentSessionStatus =
  | "detached"
  | "syncing"
  | "synced"
  | "offline"
  | "access-lost"
  | "destroyed";

/**
 * The key a room's session goes by in this tab (registry, replacement, reading position, fence
 * quarantine): the bare document id for Live, which keeps what earlier builds stored under it,
 * and the room's name for a fork.
 */
export function sessionRoomKey(room: DocumentRoom): string {
  return room.kind === "live" ? room.documentId : loroRoomName(room);
}

export type DocumentSessionSnapshot = {
  documentId: string;
  roomKey: string;
  room: DocumentRoom;
  status: DocumentSessionStatus;
  serverHasLocalChanges: boolean;
  connectionState: RoomConnectionState | null;
  access: DocumentSessionAccess | null;
  closedWhy: ClosedOwnerWhy | null;
  localPersistenceSynced: boolean;
  contentHeld: boolean;
  schemaFence: SchemaFence | null;
  holdsUndeliverableEdits: boolean;
};

export type DocumentSessionAccess = "edit" | "read";

export function historyCutOff(state: RoomConnectionState | null | undefined): boolean {
  return state?.kind === "terminal" && state.reason === "history-cutoff";
}

export type DocumentSessionTransportProvider = LoroRoomTransport;

export type DocumentSessionTransportFactory = (opts: {
  room: DocumentRoom;
  peer: string;
  copy: {
    version(): RoomVersion;
    exportSince(since: RoomVersion): Uint8Array | null;
    importRemote(batch: Uint8Array): void;
  };
  presence: LocalPresence["store"];
}) => DocumentSessionTransportProvider;

export type DocumentSessionOptions = {
  room: DocumentRoom;
  live?: DocumentSession;
  persistence: { kind: "indexeddb"; key: string } | { kind: "none" };
  transportFactory?: DocumentSessionTransportFactory;
  persistSchemaFence?: (fence: SchemaFence) => void;
  access?: DocumentSessionAccess | null;
};

const noop = () => {};

type Listener = (snapshot: DocumentSessionSnapshot) => void;

type TabMessage = { batch: Uint8Array };

export class DocumentSession {
  readonly roomKey: string;
  readonly room: DocumentRoom;
  readonly documentId: string;
  readonly peer = freshPeerId();
  readonly docs: RoomDocs;
  readonly history: DocumentHistory;

  private store: LocalCopyStore | null = null;
  private readonly storeName: string | null;
  private appended = 0;
  private tabs: BroadcastChannel | null = null;
  private transportProvider: DocumentSessionTransportProvider | null = null;
  private transportAttachmentPending = false;
  private readonly listeners = new Set<Listener>();
  private readonly contentListeners = new Set<() => void>();
  private readonly unsubscribers: (() => void)[] = [];
  private destroyed = false;
  private destroyPromise: Promise<void> | null = null;
  private localPersistenceSynced = false;
  private transportInitialSyncComplete = false;
  private contentHeld = false;
  private transportAcknowledged = false;
  private readonly pending = new Map<DocKey, DocVersion>();
  private noteServerTimer: ReturnType<typeof setTimeout> | undefined;
  private tabQuietTimer: ReturnType<typeof setTimeout> | undefined;
  private status: DocumentSessionStatus = "detached";
  private serverHasLocalChanges = false;
  private emittedKey = "";
  private transportState: RoomConnectionState | null = null;
  private access: DocumentSessionAccess | null = null;
  private closedWhy: ClosedOwnerWhy | null = null;
  private readonly server = new Map<DocKey, DocVersion>();
  private holdsUndeliverable = false;
  private inert = false;
  private importing = false;
  private readonly unregisterDraft: () => void;
  private boundEditors = 0;
  private readonly unbound = new Set<() => void>();
  private schemaFence: SchemaFence | null = null;
  private readonly persistSchemaFence: ((fence: SchemaFence) => void) | undefined;
  private readonly localPresence: LocalPresence;
  private presenceHeldForTransport = false;
  private presenceHeldForPageHide = false;
  private readonly onPageHide = () => {
    if (this.presenceHeldForPageHide) return;
    this.presenceHeldForPageHide = true;
    this.localPresence.suspend();
  };
  private readonly onPageShow = () => {
    if (!this.presenceHeldForPageHide) return;
    this.presenceHeldForPageHide = false;
    this.localPresence.resume();
  };
  private readonly localPersistenceSyncedPromise: Promise<void>;
  private readonly transportAttachedPromise: Promise<void>;
  private resolveTransportAttached!: () => void;
  private readonly lifecycleCompletedPromise: Promise<void>;
  private resolveLifecycleCompleted!: () => void;

  constructor({
    room,
    live,
    persistence,
    transportFactory,
    persistSchemaFence,
    access = null,
  }: DocumentSessionOptions) {
    if ((room.kind === "fork") !== (live !== undefined))
      throw new Error("a fork session takes its Live session, and only a fork session does");
    this.roomKey = sessionRoomKey(room);
    this.access = access;
    this.room = room;
    this.documentId = room.documentId;
    this.docs = live
      ? RoomDocs.draftOf(live.docs, this.peer)
      : RoomDocs.create(documentShape(), this.peer);
    this.unregisterDraft = live
      ? registerDraft(this.docs, (changes) => this.publish(changes))
      : noop;
    this.history = new DocumentHistory(this.docs, (changes) => this.publish(changes));
    this.persistSchemaFence = persistSchemaFence;
    this.localPresence = createLocalPresence(this.peer);
    if (typeof window !== "undefined") {
      window.addEventListener("pagehide", this.onPageHide);
      window.addEventListener("pageshow", this.onPageShow);
    }
    this.storeName = persistence.kind === "indexeddb" ? persistence.key : null;
    this.transportAttachedPromise = new Promise((resolve) => {
      this.resolveTransportAttached = resolve;
    });
    this.lifecycleCompletedPromise = new Promise((resolve) => {
      this.resolveLifecycleCompleted = resolve;
    });
    this.localPersistenceSyncedPromise = this.loadLocalCopy();
    if (transportFactory) this.attachTransport(transportFactory);
    this.emit();
  }

  /**
   * Every local write, from any writer in this tab (the editor, Undo, a command run here): store
   * it, tell the other tabs, send it. A read room sends nothing; its writes stay in the copy and
   * count as undeliverable.
   */
  publish(changes: readonly DocChange[]): void {
    if (this.destroyed || changes.length === 0) return;
    this.publishBatch(encodeChanges(changes));
    if (!this.importing && !this.docs.live)
      forwardLocalWrite(
        this.docs,
        changes.map((change) => change.key),
      );
  }

  writeDocument(doc: Node): void {
    if (this.destroyed || this.docs.isFreed) return;
    const changes = writeProseMirror(this.docs, doc, { origin: UNTRACKED_ORIGIN });
    this.publish(changes);
    notifyChanged(
      this.docs,
      changes.map((change) => change.key),
    );
  }

  private publishBatch(batch: Uint8Array): void {
    mergeVersion(this.pending, batchEnd(batch));
    this.append(batch);
    this.contentChanged();
    if (this.inert) return;
    this.tabs?.postMessage({ batch } satisfies TabMessage);
    if (this.access === "read") {
      this.holdsUndeliverable = this.computeUndeliverable();
      this.recomputeStatus();
      return;
    }
    this.transportProvider?.send(batch);
    this.recomputeStatus();
  }

  private importRemote(batch: Uint8Array, store = true): void {
    if (this.destroyed || this.docs.isFreed) return;
    this.importing = true;
    try {
      importRemoteUpdate(this.docs, batch, (changes) => this.publish(changes));
    } catch (error) {
      reportError(error);
      return;
    } finally {
      this.importing = false;
    }
    if (store) this.append(batch);
    this.contentChanged();
  }

  subscribeContent(listener: () => void): () => void {
    this.contentListeners.add(listener);
    return () => this.contentListeners.delete(listener);
  }

  private contentChanged(): void {
    for (const listener of [...this.contentListeners]) listener();
  }

  private append(batch: Uint8Array): void {
    const store = this.store;
    if (!store) return;
    void store.append(batch).catch(noop);
    if (++this.appended >= COMPACT_EVERY) this.compact();
  }

  private compact(): void {
    const store = this.store;
    if (!store || this.docs.isFreed) return;
    this.appended = 0;
    void store.compact(this.docs.snapshots()).catch(noop);
  }

  private async loadLocalCopy(): Promise<void> {
    if (!this.storeName || typeof indexedDB === "undefined") {
      this.localPersistenceSynced = true;
      this.recomputeStatus();
      return;
    }
    try {
      const store = await LocalCopyStore.open(indexedDB, this.storeName);
      if (this.destroyed) {
        void store.close();
        return;
      }
      const loaded = await store.read();
      if (this.destroyed) {
        void store.close();
        return;
      }
      if (loaded.snapshots.size > 0) this.importRemote(encodeEnvelope(loaded.snapshots), false);
      for (const batch of loaded.updates) this.importRemote(batch, false);
      this.forwardFromLive();
      const server = loaded.meta.get(SERVER_META);
      if (server instanceof Uint8Array) mergeVersion(this.server, decodeRoomVersion(server));
      this.countStored();
      this.store = store;
      store.db.onversionchange = () => {
        this.store = null;
        void store.close();
      };
      if (loaded.updates.length > 0) this.compact();
      this.localPersistenceSynced = true;
      this.startTabs();
      this.recomputeStatus();
    } catch (error) {
      reportError(error);
      this.countStored();
      this.localPersistenceSynced = true;
      this.recomputeStatus();
    }
  }

  /** The copy's stored ops beyond the server's stored mark: one pass over the document, at open. */
  private countStored(): void {
    const stored = [...this.docs.version()].filter(
      ([key, version]) => !docCovers(this.server.get(key), version),
    );
    mergeVersion(this.pending, new Map(stored));
  }

  private forwardFromLive(): void {
    if (!this.docs.live || this.docs.isFreed) return;
    const forwarded = this.docs.forward();
    if (forwarded.restore.length) this.publish(forwarded.restore);
    if (forwarded.changed.length > 0) notifyChanged(this.docs, forwarded.changed);
  }

  private startTabs(): void {
    if (
      this.tabs ||
      this.inert ||
      this.destroyed ||
      !this.storeName ||
      typeof BroadcastChannel !== "function"
    )
      return;
    const tabs = new BroadcastChannel(`meridian:copy:${this.storeName}`);
    tabs.onmessage = (event: MessageEvent<TabMessage>) => {
      const batch = event.data?.batch;
      if (!(batch instanceof Uint8Array)) return;
      this.importRemote(batch, false);
      mergeVersion(this.pending, batchEnd(batch));
      this.recomputeStatus();
      // A tab closed while offline never sends what it wrote: once it is quiet, this tab does.
      clearTimeout(this.tabQuietTimer);
      this.tabQuietTimer = setTimeout(() => {
        if (this.hasUnacknowledgedEdits()) this.transportProvider?.sendLacking();
      }, TAB_QUIET_MS);
    };
    this.tabs = tabs;
  }

  private stopTabs(): void {
    clearTimeout(this.tabQuietTimer);
    this.tabs?.close();
    this.tabs = null;
  }

  roomVersion(): Uint8Array {
    return encodeRoomVersion(this.docs.version());
  }

  attachTransport(transportFactory: DocumentSessionTransportFactory): void {
    if (this.destroyed)
      throw new Error(`Cannot attach transport to destroyed room: ${this.roomKey}`);
    if (this.inert) return;
    if (this.transportProvider || this.transportAttachmentPending)
      throw new Error(`Transport already attached to room: ${this.roomKey}`);
    this.transportAttachmentPending = true;
    this.recomputeStatus();
    void this.waitForLocalPersistenceTransportGate().then(() => {
      if (
        !this.destroyed &&
        !this.inert &&
        this.resetDisposition === null &&
        this.transportAttachmentPending
      )
        this.connectTransport(transportFactory);
    });
  }

  private connectTransport(transportFactory: DocumentSessionTransportFactory): void {
    this.resumePresenceForTransport();
    const provider = transportFactory({
      room: this.room,
      peer: this.peer,
      copy: {
        version: () => this.docs.version(),
        exportSince: (since) => {
          const entries = this.docs.exportSince(since);
          return entries.size > 0 ? encodeEnvelope(entries) : null;
        },
        importRemote: (batch) => {
          this.importRemote(batch);
          this.recomputeStatus();
        },
      },
      presence: this.localPresence.store,
    });
    this.transportAttachmentPending = false;
    this.transportProvider = provider;
    this.resolveTransportAttached();
    this.unsubscribers.push(
      provider.subscribeStatus((state) => {
        this.transportState = state;
        if (state.kind === "unauthorized" || state.kind === "reset") this.stopTabs();
        if (state.kind === "reset" && state.reason === WS_CLOSE.CLIENT_SCHEMA_SUPERSEDED.reason) {
          requireReload();
          this.raiseSchemaFence({ reason: "client-superseded" });
        }
        if (historyCutOff(state)) this.holdsUndeliverable = this.computeUndeliverable();
        this.recomputeStatus();
      }),
      provider.subscribeAccess((access, closedWhy) => {
        this.access = access;
        this.closedWhy = closedWhy;
        this.holdsUndeliverable = access === "read" && this.computeUndeliverable();
        this.recomputeStatus();
        this.emit();
      }),
      provider.subscribeServerAcknowledgement((acknowledged) => {
        this.transportAcknowledged = acknowledged;
        if (acknowledged) this.noteServerSoon();
        this.recomputeStatus();
      }),
    );
    void this.watchTransportSync(provider);
    this.recomputeStatus();
    this.emit();
  }

  private noteServerSoon(): void {
    if (this.noteServerTimer !== undefined) return;
    this.noteServerTimer = setTimeout(() => this.noteServer(), NOTE_SERVER_MS);
  }

  private noteServer(): void {
    clearTimeout(this.noteServerTimer);
    this.noteServerTimer = undefined;
    const provider = this.transportProvider;
    if (!provider || this.docs.isFreed) return;
    const known = provider.serverVersion();
    if (versionCovers(this.server, known)) return;
    mergeVersion(this.server, known);
    void this.store?.putMeta(SERVER_META, encodeRoomVersion(this.server)).catch(noop);
  }

  private computeUndeliverable(): boolean {
    const server = this.transportProvider?.serverVersion() ?? this.server;
    return wordsBeyond(this.docs, server);
  }

  private async watchTransportSync(provider: DocumentSessionTransportProvider): Promise<void> {
    await provider.whenSynced;
    if (this.destroyed || provider !== this.transportProvider) return;
    this.transportInitialSyncComplete = true;
    const first = !this.contentHeld;
    this.contentHeld = true;
    this.recomputeStatus();
    if (first) this.emit();
    await this.whenLocalPersistenceSynced();
    this.markContentInitialized();
  }

  detachTransport(): void {
    this.transportAttachmentPending = false;
    const previous = this.transportProvider;
    if (this.destroyed || !previous) {
      this.recomputeStatus();
      return;
    }
    this.noteServer();
    for (const stop of this.unsubscribers.splice(0)) stop();
    if (!this.presenceHeldForTransport) {
      this.presenceHeldForTransport = true;
      this.localPresence.suspend();
    }
    this.transportProvider = null;
    this.transportState = null;
    this.transportInitialSyncComplete = false;
    this.transportAcknowledged = false;
    this.status = "detached";
    this.serverHasLocalChanges = false;
    previous.destroy();
    this.emit();
  }

  restartTransport(transportFactory: DocumentSessionTransportFactory): void {
    if (this.destroyed)
      throw new Error(`Cannot restart transport for destroyed room: ${this.roomKey}`);
    this.detachTransport();
    this.attachTransport(transportFactory);
    this.startTabs();
  }

  get resetDisposition(): ResetDisposition | null {
    return this.transportState?.kind === "reset" ? this.transportState.disposition : null;
  }

  async whenSentAcknowledged(): Promise<void> {
    if (this.transportAttachmentPending)
      await new Promise<void>((resolve) => {
        const stop = this.subscribe(() => {
          if (this.transportAttachmentPending && !this.destroyed) return;
          resolve();
          queueMicrotask(() => stop());
        });
      });
    await this.transportProvider?.whenSentAcknowledged();
  }

  undeliverableWords(): boolean {
    return this.holdsUndeliverable && this.computeUndeliverable();
  }

  get replaced(): boolean {
    return this.inert;
  }

  makeInert(): void {
    this.inert = true;
    this.transportAttachmentPending = false;
    this.stopTabs();
    this.recomputeStatus();
    this.detachTransport();
  }

  hasUnacknowledgedEdits(): boolean {
    // Until the copy loads, what it stores is uncounted, not absent.
    if (!this.localPersistenceSynced) return true;
    const server = this.transportProvider?.serverVersion() ?? this.server;
    for (const [key, version] of this.pending) {
      if (!docCovers(server.get(key), version)) return true;
      this.pending.delete(key);
    }
    return false;
  }

  canDeliverUnsentEdits(): boolean {
    return !this.isRoomEnded() && this.access !== "read";
  }

  isRoomEnded(): boolean {
    return (
      this.destroyed || this.status === "access-lost" || this.transportState?.kind === "terminal"
    );
  }

  private waitForLocalPersistenceTransportGate(): Promise<void> {
    return new Promise((resolve) => {
      const timeout = setTimeout(resolve, LOCAL_PERSISTENCE_TRANSPORT_TIMEOUT_MS);
      void this.localPersistenceSyncedPromise.finally(() => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }

  getSnapshot(): DocumentSessionSnapshot {
    return {
      documentId: this.documentId,
      roomKey: this.roomKey,
      room: this.room,
      status: this.status,
      serverHasLocalChanges: this.serverHasLocalChanges,
      connectionState: this.transportState,
      access: this.access,
      closedWhy: this.closedWhy,
      localPersistenceSynced: this.localPersistenceSynced,
      contentHeld: this.contentHeld,
      schemaFence: this.schemaFence,
      holdsUndeliverableEdits: this.holdsUndeliverable,
    };
  }

  bindEditor(construct: () => Editor): { editor: Editor; release: () => void } {
    if (this.destroyed) throw new Error("Cannot bind an editor to a destroyed session");
    const editor = construct();
    this.boundEditors += 1;
    let released = false;
    return {
      editor,
      release: () => {
        if (released) return;
        released = true;
        this.boundEditors -= 1;
        if (this.boundEditors === 0) for (const done of [...this.unbound]) done();
      },
    };
  }

  whenUnbound(): Promise<void> {
    if (this.boundEditors === 0) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        this.unbound.delete(done);
        resolve();
      };
      this.unbound.add(done);
    });
  }

  raiseSchemaFence(fence: SchemaFence): void {
    if (this.destroyed || this.schemaFence) return;
    this.schemaFence = fence;
    this.stopTabs();
    this.persistSchemaFence?.(fence);
    this.suspendPresence();
    this.emit();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => {
      this.listeners.delete(listener);
    };
  }

  whenSynced(): Promise<void> {
    const syncSequence = async () => {
      await this.localPersistenceSyncedPromise;
      await this.transportAttachedPromise;
      await this.transportProvider?.whenSynced;
    };
    return Promise.race([syncSequence(), this.lifecycleCompletedPromise]);
  }

  whenLocalPersistenceSynced(): Promise<void> {
    return Promise.race([this.localPersistenceSyncedPromise, this.lifecycleCompletedPromise]);
  }

  waitForCurrentSync(timeoutMs: number): Promise<void> {
    if (this.status === "synced" || this.status === "access-lost" || this.status === "destroyed")
      return Promise.resolve();
    return new Promise((resolve) => {
      let done = false;
      let unsubscribe: (() => void) | null = null;
      const finish = () => {
        if (done) return;
        done = true;
        unsubscribe?.();
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(finish, timeoutMs);
      unsubscribe = this.subscribe((snapshot) => {
        if (
          snapshot.status === "synced" ||
          snapshot.status === "access-lost" ||
          snapshot.status === "destroyed"
        )
          finish();
      });
    });
  }

  get persistenceName(): string | null {
    return this.storeName;
  }

  async hasInitializedLocalContent(): Promise<boolean> {
    await this.whenLocalPersistenceSynced();
    const store = this.store;
    if (this.destroyed || !store) return false;
    return (await store.read()).meta.get(INITIALIZED_META) === true;
  }

  private markContentInitialized(): void {
    void this.store?.putMeta(INITIALIZED_META, true).catch(noop);
  }

  get presence(): LocalPresenceFields {
    return this.localPresence;
  }

  private resumePresenceForTransport(): void {
    if (!this.presenceHeldForTransport) return;
    this.presenceHeldForTransport = false;
    this.localPresence.resume();
  }

  suspendPresence(): void {
    if (this.destroyed) return;
    this.localPresence.suspend();
  }

  resumePresence(): void {
    if (this.destroyed) return;
    this.localPresence.resume();
  }

  /**
   * Tear down: the transport, the other tabs' channel, the store (after its writes land and a
   * last compaction), presence, history, and last the docs, which are WASM memory only `free()`
   * releases. Editors must be destroyed first (the registry waits for `whenUnbound`).
   */
  destroy(): Promise<void> {
    if (this.destroyPromise) return this.destroyPromise;
    this.destroyed = true;
    this.stopTabs();
    this.resolveTransportAttached();
    this.resolveLifecycleCompleted();
    this.status = "destroyed";
    this.serverHasLocalChanges = false;
    this.emit();
    if (typeof window !== "undefined") {
      window.removeEventListener("pagehide", this.onPageHide);
      window.removeEventListener("pageshow", this.onPageShow);
    }
    this.noteServer();
    for (const stop of this.unsubscribers.splice(0)) stop();
    this.transportProvider?.destroy();
    this.transportProvider = null;
    this.localPresence.release();
    this.unregisterDraft();
    this.history.destroy();
    const store = this.store;
    this.store = null;
    this.destroyPromise = (async () => {
      if (store && !this.docs.isFreed && this.appended > 0)
        await store.compact(this.docs.snapshots()).catch(noop);
      await store?.close();
      await this.localPersistenceSyncedPromise.catch(noop);
      this.docs.free();
      this.listeners.clear();
    })();
    return this.destroyPromise;
  }

  private recomputeStatus(): void {
    if (this.destroyed) return;
    const next = this.deriveStatus();
    const acknowledged =
      next === "synced" &&
      (this.access === "read" ? !this.holdsUndeliverable : this.transportAcknowledged);
    const key = `${next}|${acknowledged}|${this.holdsUndeliverable}|${this.hasUnacknowledgedEdits()}`;
    if (key === this.emittedKey && this.transportState === this.lastEmittedState) return;
    this.emittedKey = key;
    this.lastEmittedState = this.transportState;
    this.status = next;
    this.serverHasLocalChanges = acknowledged;
    this.emit();
  }

  private lastEmittedState: RoomConnectionState | null = null;

  private deriveStatus(): DocumentSessionStatus {
    if (!this.transportProvider) return this.transportAttachmentPending ? "syncing" : "detached";
    const state = this.transportState;
    if (state?.kind === "unauthorized" || state?.kind === "reset") return "access-lost";
    if (!this.localPersistenceSynced) return "syncing";
    if (state?.kind === "terminal" || state?.kind === "signed-out") return "offline";
    if (!this.transportInitialSyncComplete) return "syncing";
    if (state?.kind === "disconnected") return "offline";
    if (state?.kind === "connected") return "synced";
    return "syncing";
  }

  private emit(): void {
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) listener(snapshot);
  }
}
