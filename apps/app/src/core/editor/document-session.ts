/**
 * document-session — owns the lifecycle of one document's Live copy in this tab.
 *
 * A copy is a `RoomDocs` (the structure doc and a text doc per block, design §1), its IndexedDB
 * store (`local-copy-store.ts`), the room transport (`loro-room-transport.ts`), presence on
 * the room's ephemeral store, and the writer's Undo. Every local write reaches the copy through
 * one path, `publish`: stored, sent to the other tabs of this browser, then to the server.
 * Every peer's batch reaches it through `importRemote`, which goes through the binding's
 * composition guard.
 *
 * Status, derived from local persistence and the transport together:
 *   - `detached`  — no server transport attached yet.
 *   - `syncing`   — the local load or the first Join is not done, or the socket is reconnecting.
 *   - `synced`    — loaded, connected and joined. Not that the server holds the latest edits:
 *                   `serverHasLocalChanges` says that.
 *   - `offline`   — loaded, socket down; edits wait in IndexedDB and go with the next Join.
 *   - `access-lost` — the server ended this room for good; local edits will not upload.
 *   - `destroyed` — torn down.
 *
 * `access` is the server's scope for the room. A `read` room still receives peers' changes and
 * sends nothing.
 */
import type { ClosedOwnerWhy } from "@meridian/contracts/commands";
import type { DocumentRoom } from "@meridian/contracts/protocol";
import { WS_CLOSE } from "@meridian/contracts/protocol";
import {
  type DocChange,
  type DocKey,
  type DocVersion,
  decodeRoomVersion,
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
  importRemoteUpdate,
  notifyChanged,
  UNTRACKED_ORIGIN,
  writeProseMirror,
} from "@meridian/loro-prosemirror";
import type { ConnectionState } from "@meridian/thread-client";
import type { Editor } from "@tiptap/core";
import type { Node } from "@tiptap/pm/model";
import { requireReload } from "@/client/release/release";
import type { LoroRoomTransport } from "@/core/transport/loro-room-transport";
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

/** Give normal IndexedDB replay priority without letting blocked storage hold collaboration offline. */
const LOCAL_PERSISTENCE_TRANSPORT_TIMEOUT_MS = 1_000;
/** How long the server's mark waits for typing to pause before it is stored. */
const NOTE_SERVER_MS = 1_000;
/** The log is folded into snapshots after this many appended batches. */
const COMPACT_EVERY = 200;

export type DocumentSessionStatus =
  | "detached"
  | "syncing"
  | "synced"
  | "offline"
  | "access-lost"
  | "destroyed";

export type DocumentSessionSnapshot = {
  documentId: string;
  /** The room key: the bare document id. */
  roomKey: string;
  room: DocumentRoom;
  status: DocumentSessionStatus;
  /** Server acknowledged every local change on this connection (see file header). */
  serverHasLocalChanges: boolean;
  connectionState: DocumentSessionConnectionState | null;
  /**
   * The scope the server last named for this room, kept across reconnects and transport
   * restarts; `null` until it names one. An unnamed room is writable (local-first).
   */
  access: DocumentSessionAccess | null;
  /** Why a read-only room is read-only, when its owner is closed. */
  closedWhy: ClosedOwnerWhy | null;
  localPersistenceSynced: boolean;
  /** The document has reached this session from the server once; stays true offline. */
  contentHeld: boolean;
  schemaFence: SchemaFence | null;
  /**
   * The room holds edits the server lacks and can never take: it was admitted read-only with
   * them, or the server ended it for history below its cutoff.
   */
  holdsUndeliverableEdits: boolean;
};

export type DocumentSessionAccess = "edit" | "read";

export type DocumentSessionResetReason =
  | typeof WS_CLOSE.CLIENT_SCHEMA_SUPERSEDED.reason
  | typeof WS_CLOSE.DOCUMENT_SCHEMA_STALE.reason
  /** The document was deleted or discarded; its rooms never reopen. */
  | typeof WS_CLOSE.DOCUMENT_DELETED.reason;

/**
 * How a terminal room reset treats its unacknowledged edits. `removed`: the document was purged,
 * so nothing reconnects on its own; the session stays read-only until its owner closes it, or an
 * exact open proves the document present and restarts it.
 */
export type ResetDisposition = "schema" | "removed";

/**
 * A 4401 says the sign-in lapsed, not that access ended: the room keeps its local text and takes
 * edits like an offline one, and the account's list shows the "sign in again" prompt.
 */
export function isSignInLapse(state: DocumentSessionConnectionState | null | undefined): boolean {
  return state?.kind === "unauthorized" && state.code === WS_CLOSE.AUTH_FAILED.code;
}

export type DocumentSessionConnectionState =
  | Exclude<ConnectionState, { kind: "reset" }>
  | {
      kind: "reset";
      reason: DocumentSessionResetReason;
      disposition: ResetDisposition;
      code?: number;
    };

/** The server ended the room: its update depends on history below the room's cutoff. */
export function historyCutOff(state: DocumentSessionConnectionState | null | undefined): boolean {
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
  /** The room key: the bare document id. */
  roomKey: string;
  /** The copy's IndexedDB database, by its exact name. */
  persistence: { kind: "indexeddb"; key: string; fresh?: boolean } | { kind: "none" };
  transportFactory?: DocumentSessionTransportFactory;
  /** Registry-owned persistence hook for the first fence transition. */
  persistSchemaFence?: (fence: SchemaFence) => void;
  /** The scope of a room this session replaces: the editor is read-only from its first frame. */
  access?: DocumentSessionAccess | null;
};

const noop = () => {};

type Listener = (snapshot: DocumentSessionSnapshot) => void;

/** A batch between this browser's tabs: the copy's name and the envelope. */
type TabMessage = { batch: Uint8Array };

export class DocumentSession {
  readonly roomKey: string;
  readonly room: DocumentRoom;
  readonly documentId: string;
  /** This copy's peer id, across all its docs. */
  readonly peer = freshPeerId();
  readonly docs: RoomDocs;
  /** The writer's undo, kept with the copy: editors attach to it while mounted. */
  readonly history: DocumentHistory;

  private store: LocalCopyStore | null = null;
  private readonly storeName: string | null;
  private appended = 0;
  private tabs: BroadcastChannel | null = null;
  private transportProvider: DocumentSessionTransportProvider | null = null;
  private transportAttachmentPending = false;
  private detaching: Promise<void> | null = null;
  private readonly listeners = new Set<Listener>();
  private readonly contentListeners = new Set<() => void>();
  private readonly unsubscribers: (() => void)[] = [];
  private destroyed = false;
  private destroyPromise: Promise<void> | null = null;
  private localPersistenceSynced = false;
  private transportInitialSyncComplete = false;
  private contentHeld = false;
  private transportAcknowledged = false;
  /**
   * Whether the copy holds ops the server lacks; null until read. Kept as an edge, not recomputed
   * per keystroke: comparing the room's versions costs a pass over every block's doc.
   */
  private unsent: boolean | null = null;
  private noteServerTimer: ReturnType<typeof setTimeout> | undefined;
  private status: DocumentSessionStatus = "detached";
  private serverHasLocalChanges = false;
  private emittedKey = "";
  private transportState: DocumentSessionConnectionState | null = null;
  private access: DocumentSessionAccess | null = null;
  private closedWhy: ClosedOwnerWhy | null = null;
  /** What the server is known to hold, across connections: the copy's `server` meta. */
  private readonly server = new Map<DocKey, DocVersion>();
  private holdsUndeliverable = false;
  /** Replaced by another session: nothing more goes to the server or to other tabs. */
  private inert = false;
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
    roomKey,
    persistence,
    transportFactory,
    persistSchemaFence,
    access = null,
  }: DocumentSessionOptions) {
    this.roomKey = roomKey;
    this.access = access;
    this.room = { kind: "live", documentId: roomKey };
    this.documentId = roomKey;
    this.docs = RoomDocs.create(documentShape(), this.peer);
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

  // --- the copy -------------------------------------------------------------------------------

  /**
   * Every local write, from any writer in this tab (the editor, Undo, a command run here): store
   * it, tell the other tabs, send it. A read room sends nothing; its writes stay in the copy and
   * count as undeliverable.
   */
  publish(changes: readonly DocChange[]): void {
    if (this.destroyed || changes.length === 0) return;
    this.publishBatch(encodeChanges(changes));
  }

  /**
   * Write a whole document into the copy as a writer outside any editor would (a just-made file's
   * first text): only what differs is written, published like typing, and shown in every editor
   * of the copy. No Ctrl+Z takes it back.
   */
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
    this.unsent = true;
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

  /** A peer's batch: imported through the composition guard, then stored. */
  private importRemote(batch: Uint8Array, store = true): void {
    if (this.destroyed || this.docs.isFreed) return;
    try {
      importRemoteUpdate(this.docs, batch, (changes) => this.publish(changes));
    } catch (error) {
      reportError(error);
      return;
    }
    if (store) this.append(batch);
    this.contentChanged();
  }

  /**
   * Called after the copy's content changes, by anyone: for a reader of the text that is not an
   * editor (a trashed document's preview, a name suggested from its first line).
   */
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
      // Through the binding like a peer's batch: past the bind horizon an editor may show the
      // copy already.
      if (loaded.snapshots.size > 0) this.importRemote(encodeEnvelope(loaded.snapshots), false);
      for (const batch of loaded.updates) this.importRemote(batch, false);
      const server = loaded.meta.get(SERVER_META);
      if (server instanceof Uint8Array) mergeVersion(this.server, decodeRoomVersion(server));
      this.store = store;
      store.db.onversionchange = () => {
        // Another tab is deleting this copy (a purge): stop writing to it.
        this.store = null;
        void store.close();
      };
      if (loaded.updates.length > 0) this.compact();
      this.localPersistenceSynced = true;
      this.startTabs();
      this.recomputeStatus();
    } catch (error) {
      reportError(error);
      this.localPersistenceSynced = true;
      this.recomputeStatus();
    }
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
      if (!(event.data?.batch instanceof Uint8Array)) return;
      // Another tab's batch: that tab sends it, and this copy can't tell when the server has it.
      this.unsent = null;
      this.importRemote(event.data.batch, false);
    };
    this.tabs = tabs;
  }

  private stopTabs(): void {
    this.tabs?.close();
    this.tabs = null;
  }

  /** The room version of this copy, for a command that waits on the server holding it. */
  roomVersion(): Uint8Array {
    return encodeRoomVersion(this.docs.version());
  }

  // --- the transport --------------------------------------------------------------------------

  /** Attach the session's only server transport after the local load. */
  attachTransport(transportFactory: DocumentSessionTransportFactory): void {
    if (this.destroyed)
      throw new Error(`Cannot attach transport to destroyed room: ${this.roomKey}`);
    if (this.inert) return;
    if (this.transportProvider || this.transportAttachmentPending)
      throw new Error(`Transport already attached to room: ${this.roomKey}`);
    this.transportAttachmentPending = true;
    this.recomputeStatus();
    void Promise.all([this.detaching, this.waitForLocalPersistenceTransportGate()]).then(() => {
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
        importRemote: (batch) => this.importRemote(batch),
      },
      presence: this.localPresence.store,
    });
    this.transportAttachmentPending = false;
    this.transportProvider = provider;
    this.resolveTransportAttached();
    this.unsubscribers.push(
      provider.subscribeStatus((state) => {
        this.transportState = state;
        if ((state.kind === "unauthorized" && !isSignInLapse(state)) || state.kind === "reset")
          this.stopTabs();
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
        // Joined, with everything this connection sent acknowledged: the Join sent all the copy held.
        if (acknowledged) {
          this.unsent = false;
          this.noteServerSoon();
        }
        this.recomputeStatus();
      }),
    );
    void this.watchTransportSync(provider);
    this.recomputeStatus();
    this.emit();
  }

  /**
   * Record what the server holds in the copy, for a later tab or reload, once typing pauses: a
   * mark that trails the server only offers words it has, never loses one.
   */
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

  /** Whether the copy holds words the server lacks (see `unsent-words.ts`). */
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
  }

  /**
   * Close the server transport and keep the copy, its store and its history. Edits made after
   * this wait in the copy until `attachTransport`'s Join sends them.
   */
  detachTransport(): Promise<void> {
    this.transportAttachmentPending = false;
    const previous = this.transportProvider;
    if (this.destroyed || !previous) return this.detaching ?? Promise.resolve();
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
    return Promise.resolve();
  }

  /** Replace a terminal transport while keeping the copy. */
  async restartTransport(transportFactory: DocumentSessionTransportFactory): Promise<void> {
    if (this.destroyed)
      throw new Error(`Cannot restart transport for destroyed room: ${this.roomKey}`);
    await this.detachTransport();
    this.attachTransport(transportFactory);
    this.startTabs();
  }

  get resetDisposition(): ResetDisposition | null {
    return this.transportState?.kind === "reset" ? this.transportState.disposition : null;
  }

  /** Captured now; later typing does not move this barrier. */
  whenCurrentChangesAcknowledged(): Promise<void> {
    const provider = this.transportProvider;
    if (!provider) return Promise.reject(new Error("Document session has no transport"));
    if (this.access === "read") return Promise.resolve();
    return provider.whenCurrentChangesAcknowledged();
  }

  /**
   * Settles once the server holds what this room holds now, or at once while the room is not
   * synced or is read-admitted, and when it stops being synced or becomes read.
   */
  whenServerHoldsLocalChanges(): Promise<void> {
    return new Promise<void>((resolve) => {
      let stop = () => {};
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        stop();
        resolve();
      };
      stop = this.subscribe((snapshot) => {
        if (snapshot.status !== "synced" || snapshot.access === "read") done();
      });
      if (settled) stop();
      else this.whenCurrentChangesAcknowledged().then(done, done);
    });
  }

  /** Whether this copy holds words a read-admitting server will never take. */
  undeliverableWords(): boolean {
    return this.holdsUndeliverable && this.computeUndeliverable();
  }

  get replaced(): boolean {
    return this.inert;
  }

  /** Another session replaces this room: nothing more goes to the server or to other tabs. */
  makeInert(): Promise<void> {
    this.inert = true;
    this.transportAttachmentPending = false;
    this.stopTabs();
    this.recomputeStatus();
    return this.detachTransport();
  }

  /** Whether the copy holds ops the server is not known to have. */
  hasUnacknowledgedEdits(): boolean {
    if (this.unsent === null) {
      const server = this.transportProvider?.serverVersion() ?? this.server;
      this.unsent = !versionCovers(server, this.docs.version());
    }
    return this.unsent;
  }

  /**
   * Whether this room can still take the unsent edits: false once it is reset, unauthorized,
   * terminal, destroyed or admitted read-only.
   */
  canDeliverUnsentEdits(): boolean {
    return !this.isRoomEnded() && this.access !== "read";
  }

  /** The room itself is over, whatever its access: reset, unauthorized, terminal or destroyed. */
  isRoomEnded(): boolean {
    const state = this.transportState;
    return (
      this.destroyed ||
      this.status === "access-lost" ||
      state?.kind === "reset" ||
      (state?.kind === "unauthorized" && !isSignInLapse(state)) ||
      state?.kind === "terminal"
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

  // --- editors --------------------------------------------------------------------------------

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

  /** Whether this copy's first content was written here (a new document's template). */
  async hasInitializedLocalContent(): Promise<boolean> {
    await this.whenLocalPersistenceSynced();
    const store = this.store;
    if (this.destroyed || !store) return false;
    return (await store.read()).meta.get(INITIALIZED_META) === true;
  }

  /** Record that this copy's first content is written; `hasInitializedLocalContent` reads it. */
  markContentInitialized(): void {
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

  private lastEmittedState: DocumentSessionConnectionState | null = null;

  private deriveStatus(): DocumentSessionStatus {
    if (!this.transportProvider) return this.transportAttachmentPending ? "syncing" : "detached";
    if (!this.localPersistenceSynced) return "syncing";
    const state = this.transportState;
    if (isSignInLapse(state)) return "offline";
    if (state?.kind === "unauthorized") return "access-lost";
    if (state?.kind === "reset") return "access-lost";
    if (state?.kind === "terminal") return "offline";
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
