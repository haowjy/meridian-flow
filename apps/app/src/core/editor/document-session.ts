/**
 * document-session — owns the lifecycle of one collaborative document's CRDT.
 *
 * Wraps a Yjs `Y.Doc`, IndexedDB local persistence, awareness, and a pluggable
 * transport provider into a subscribable session with a status snapshot
 * (detached / syncing / synced / offline / access-lost / destroyed). The single place document
 * collaboration state is created and torn down; `EditorView` binds to it.
 *
 * Status semantics — derived from BOTH local persistence and the live
 * transport connection state, so the indicator stays honest after the initial
 * load:
 *   - `detached`  — local persistence is available, but no server transport
 *                   has been attached yet.
 *   - `syncing`   — initial local load and/or first server sync hasn't
 *                   completed yet, or the transport is actively reconnecting
 *                   after a drop.
 *   - `synced`    — local persistence is loaded AND the server transport is
 *                   currently connected & synced (edits are safe on the
 *                   server). Only this state may claim "synced".
 *   - `offline`   — local persistence is loaded but the socket is
 *                   disconnected (edits are buffered in IndexedDB and may
 *                   upload after reconnect).
 *   - `access-lost` — the server permanently denied this document/session;
 *                   further local edits are NOT expected to upload.
 *   - `destroyed` — the session has been torn down.
 */
import {
  parseYjsRoomName,
  type SafetyNoticeWsMessage,
  type YjsRoomName,
} from "@meridian/contracts/protocol";
import { COLLAB_SCHEMA_VERSION, createCollabYDoc } from "@meridian/prosemirror-schema";
import { IndexeddbPersistence } from "y-indexeddb";
import { Awareness, removeAwarenessStates } from "y-protocols/awareness";
import type * as Y from "yjs";

import type { ConnectionState } from "@/core/transport/ThreadTransport";

import { PROSEMIRROR_FRAGMENT_NAME } from "./schema";

/** IndexedDB name for y-indexeddb; bumps with {@link COLLAB_SCHEMA_VERSION} invalidate stale caches. */
export function documentSessionPersistenceKey(roomKey: string): string {
  return `meridian:document:v${COLLAB_SCHEMA_VERSION}:${roomKey}`;
}

const PERSISTENCE_KEY_PREFIX = "meridian:document:v";

/** Best-effort delete of pre-version-bump IndexedDB entries for one document. */
function deleteStaleVersionedIndexedDb(roomKey: string): void {
  if (typeof indexedDB === "undefined" || typeof indexedDB.databases !== "function") return;

  const suffix = `:${roomKey}`;
  void indexedDB
    .databases()
    .then((databases) => {
      for (const db of databases ?? []) {
        const name = db.name;
        if (!name?.startsWith(PERSISTENCE_KEY_PREFIX) || !name.endsWith(suffix)) continue;
        const versionPart = name.slice(PERSISTENCE_KEY_PREFIX.length, name.length - suffix.length);
        const version = Number.parseInt(versionPart, 10);
        if (Number.isFinite(version) && version < COLLAB_SCHEMA_VERSION) {
          indexedDB.deleteDatabase(name);
        }
      }
    })
    .catch(() => {
      // Fire-and-forget GC; versioned key alone guarantees correctness.
    });
}

export type DocumentSessionStatus =
  | "detached"
  | "syncing"
  | "synced"
  | "offline"
  | "access-lost"
  | "destroyed";

export type DocumentSessionSnapshot = {
  /** Live document id for live rooms; draft/branch sessions expose the room-scoped id here. */
  documentId: string;
  /** Hocuspocus room key: live documents use the bare document id, drafts use `draft:<draftId>`, branch review rooms use `branch:<branchId>:gen:<generation>`. */
  roomKey: string;
  room: YjsRoomName;
  status: DocumentSessionStatus;
  connectionState: ConnectionState | null;
  localPersistenceSynced: boolean;
  safetyNotice: SafetyNoticeWsMessage | null;
};

/**
 * Surface `DocumentSession` consumes from its transport.
 *
 * `synced` / `whenSynced` describe the FIRST server reconciliation. Live
 * connection-state changes after that (drop / reconnect / terminal close) flow
 * through `subscribeStatus` so the session can re-derive `status` whenever
 * the transport changes — without that, the pill would freeze on its startup
 * value and `offline` could never fire.
 */
export type DocumentSessionTransportProvider = {
  awareness?: Awareness;
  synced?: boolean;
  whenSynced?: Promise<void>;
  /**
   * Resolves after initial reconciliation and after the server's SyncStatus
   * acknowledgement has reduced the provider's unsynced update count to zero.
   *
   * Meridian's collaboration server journals an inbound Yjs update before it
   * sends that acknowledgement, so this is the transport's durable-upload
   * barrier. Hocuspocus' initial `whenSynced` is not such a barrier.
   */
  whenDurablySynced?: Promise<void>;
  /**
   * Subscribe to live connection-state updates from the underlying socket.
   * Implementations MUST emit the current state synchronously on subscribe
   * and on every subsequent change. Returns an unsubscribe function.
   */
  subscribeStatus?: (listener: (state: ConnectionState) => void) => () => void;
  subscribeSafetyNotices?: (listener: (notice: SafetyNoticeWsMessage) => void) => () => void;
  destroy: () => void | Promise<void>;
};

export type DocumentSessionTransportFactory = (opts: {
  roomKey: string;
  room: YjsRoomName;
  document: Y.Doc;
  awareness: Awareness;
  fragmentName: typeof PROSEMIRROR_FRAGMENT_NAME;
}) => DocumentSessionTransportProvider;

export type DocumentSessionOptions = {
  /** Hocuspocus room key: live documents use the bare document id, drafts use `draft:<draftId>`, branch review rooms use `branch:<branchId>:gen:<generation>`. */
  roomKey: string;
  /** Defaults to y-indexeddb's document name, scoped to Meridian app content. */
  persistenceKey?: string;
  /** Tests and SSR can disable IndexedDB; browser sessions enable it by default. */
  enableIndexedDb?: boolean;
  /** Plugs the server document-sync provider into the session-owned Y.Doc. */
  transportFactory?: DocumentSessionTransportFactory;
};

type Listener = (snapshot: DocumentSessionSnapshot) => void;

function canUseIndexedDb(): boolean {
  return typeof indexedDB !== "undefined";
}

export class DocumentSession {
  readonly roomKey: string;
  readonly room: YjsRoomName;
  readonly documentId: string;
  readonly document: Y.Doc;
  readonly awareness: Awareness;
  readonly fragmentName = PROSEMIRROR_FRAGMENT_NAME;

  private readonly persistence: IndexeddbPersistence | null;
  private transportProvider: DocumentSessionTransportProvider | null = null;
  private readonly listeners = new Set<Listener>();
  private unsubscribeTransportStatus: (() => void) | null = null;
  private unsubscribeSafetyNotices: (() => void) | null = null;
  private destroyed = false;
  private localPersistenceSynced = false;
  /** True after the transport's first `whenSynced` — blocks empty-local false `synced`. */
  private transportInitialSyncComplete = false;
  private transportDurableSyncComplete = false;
  private status: DocumentSessionStatus = "detached";
  /**
   * Latest live connection-state from the transport. When the transport is
   * pre-`whenSynced` we treat the session as syncing; this field lets us
   * distinguish "connected & synced" from "disconnected" after that.
   */
  private transportState: ConnectionState | null = null;
  private safetyNotice: SafetyNoticeWsMessage | null = null;
  private presenceSuspendDepth = 0;
  private suspendedLocalAwarenessState: Record<string, unknown> | null = null;
  private readonly localPersistenceSyncedPromise: Promise<void>;
  private readonly transportAttachedPromise: Promise<void>;
  private resolveTransportAttached!: () => void;
  private readonly lifecycleCompletedPromise: Promise<void>;
  private resolveLifecycleCompleted!: () => void;

  constructor({
    roomKey,
    persistenceKey = documentSessionPersistenceKey(roomKey),
    enableIndexedDb = canUseIndexedDb(),
    transportFactory,
  }: DocumentSessionOptions) {
    const room = parseYjsRoomName(roomKey);
    if (!room) throw new Error(`Invalid Yjs room key: ${roomKey}`);
    this.roomKey = roomKey;
    this.room = room;
    this.documentId = room.kind === "live" ? room.documentId : room.branchId;
    this.document = createCollabYDoc();
    this.awareness = new Awareness(this.document);
    if (enableIndexedDb) {
      deleteStaleVersionedIndexedDb(roomKey);
      this.persistence = new IndexeddbPersistence(persistenceKey, this.document);
    } else {
      this.persistence = null;
    }
    this.transportAttachedPromise = new Promise((resolve) => {
      this.resolveTransportAttached = resolve;
    });
    this.lifecycleCompletedPromise = new Promise((resolve) => {
      this.resolveLifecycleCompleted = resolve;
    });
    this.localPersistenceSyncedPromise = this.watchLocalPersistence();
    if (transportFactory) this.attachTransport(transportFactory);
    this.emit();
  }

  /** Attach the session's only server transport without replacing its Y.Doc. */
  attachTransport(transportFactory: DocumentSessionTransportFactory): void {
    if (this.destroyed)
      throw new Error(`Cannot attach transport to destroyed room: ${this.roomKey}`);
    if (this.transportProvider) {
      throw new Error(`Transport already attached to room: ${this.roomKey}`);
    }

    this.transportProvider = transportFactory({
      roomKey: this.roomKey,
      room: this.room,
      document: this.document,
      awareness: this.awareness,
      fragmentName: this.fragmentName,
    });
    this.resolveTransportAttached();
    this.status = "syncing";
    this.unsubscribeTransportStatus =
      this.transportProvider.subscribeStatus?.((state) => {
        this.transportState = state;
        this.recomputeStatus();
      }) ?? null;
    this.unsubscribeSafetyNotices =
      this.transportProvider.subscribeSafetyNotices?.((notice) => {
        if (notice.documentId !== this.documentId) return;
        this.safetyNotice = notice;
        this.emit();
      }) ?? null;
    void this.watchTransportSync(this.transportProvider);
    void this.watchTransportDurableSync(this.transportProvider);
    this.recomputeStatus();
    this.emit();
  }

  get cursorProvider(): { awareness: Awareness } {
    return { awareness: this.transportProvider?.awareness ?? this.awareness };
  }

  getSnapshot(): DocumentSessionSnapshot {
    return {
      documentId: this.documentId,
      roomKey: this.roomKey,
      room: this.room,
      status: this.status,
      connectionState: this.transportState,
      localPersistenceSynced: this.localPersistenceSynced,
      safetyNotice: this.safetyNotice,
    };
  }

  dismissSafetyNotice(): void {
    if (!this.safetyNotice) return;
    this.safetyNotice = null;
    this.emit();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Resolve after first local + server sync, or when destruction ends that lifecycle. */
  whenSynced(): Promise<void> {
    const syncSequence = async () => {
      await this.localPersistenceSyncedPromise;
      await this.transportAttachedPromise;
      await this.transportProvider?.whenSynced;
    };
    return Promise.race([syncSequence(), this.lifecycleCompletedPromise]);
  }

  /** Resolve once IndexedDB has replayed this room into the session-owned Y.Doc. */
  whenLocalPersistenceSynced(): Promise<void> {
    return Promise.race([this.localPersistenceSyncedPromise, this.lifecycleCompletedPromise]);
  }

  waitForCurrentSync(timeoutMs: number): Promise<void> {
    if (this.status === "synced" || this.status === "access-lost" || this.status === "destroyed") {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      let done = false;
      let unsubscribe: (() => void) | null = null;
      const finish = () => {
        if (done) return;
        done = true;
        if (unsubscribe) unsubscribe();
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(finish, timeoutMs);
      unsubscribe = this.subscribe((snapshot) => {
        if (
          snapshot.status === "synced" ||
          snapshot.status === "access-lost" ||
          snapshot.status === "destroyed"
        ) {
          finish();
        }
      });
    });
  }

  /**
   * Settle once every update present at attachment is server-acknowledged, or
   * once terminal denial/destruction makes that impossible. Callers must
   * inspect the snapshot afterwards before treating the upload as durable.
   */
  waitForDurableSync(): Promise<void> {
    if (
      this.transportDurableSyncComplete ||
      this.status === "access-lost" ||
      this.status === "destroyed"
    ) {
      return Promise.resolve();
    }
    const durableSequence = async () => {
      await this.localPersistenceSyncedPromise;
      await this.transportAttachedPromise;
      await this.transportProvider?.whenDurablySynced;
    };
    const terminal = new Promise<void>((resolve) => {
      let unsubscribe: (() => void) | null = null;
      unsubscribe = this.subscribe((snapshot) => {
        if (snapshot.status !== "access-lost" && snapshot.status !== "destroyed") return;
        unsubscribe?.();
        resolve();
      });
    });
    return Promise.race([durableSequence(), terminal, this.lifecycleCompletedPromise]);
  }

  /**
   * Wait for all IndexedDB transactions queued before this call. Applying a
   * Yjs update starts y-indexeddb's write transaction synchronously; a later
   * readonly transaction cannot complete until that write commits.
   */
  async flushLocalPersistence(): Promise<void> {
    await this.whenLocalPersistenceSynced();
    const db = this.persistence?.db;
    if (!db || this.destroyed) return;
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction("updates", "readonly");
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB flush aborted"));
    });
  }

  suspendPresence(): void {
    if (this.destroyed) return;
    if (this.presenceSuspendDepth++ > 0) return;
    this.suspendedLocalAwarenessState = this.awareness.getLocalState() as Record<
      string,
      unknown
    > | null;
    this.awareness.setLocalState(null);
  }

  resumePresence(): void {
    if (this.destroyed || this.presenceSuspendDepth === 0) return;
    this.presenceSuspendDepth -= 1;
    if (this.presenceSuspendDepth > 0) return;
    const state = this.suspendedLocalAwarenessState;
    this.suspendedLocalAwarenessState = null;
    if (state) this.awareness.setLocalState(state);
  }

  /**
   * Cleanup ordering is intentionally caller-friendly: React unmounts the
   * TipTap editor first, then calls this method so providers can detach before
   * the Y.Doc is destroyed.
   */
  async destroy(options: { clearPersistence?: boolean } = {}): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    this.resolveTransportAttached();
    this.resolveLifecycleCompleted();
    this.status = "destroyed";
    this.emit();

    this.presenceSuspendDepth = 0;
    this.suspendedLocalAwarenessState = null;
    removeAwarenessStates(this.awareness, [this.document.clientID], "document-session-destroy");

    this.unsubscribeTransportStatus?.();
    this.unsubscribeSafetyNotices?.();
    await this.transportProvider?.destroy();
    if (options.clearPersistence) {
      await this.persistence?.clearData();
    } else {
      await this.persistence?.destroy();
    }
    this.awareness.destroy();
    this.document.destroy();
    this.listeners.clear();
  }

  private async watchLocalPersistence(): Promise<void> {
    await this.persistence?.whenSynced;
    if (this.destroyed) return;
    this.localPersistenceSynced = true;
    this.recomputeStatus();
  }

  private async watchTransportSync(provider: DocumentSessionTransportProvider): Promise<void> {
    await provider.whenSynced;
    if (this.destroyed || provider !== this.transportProvider) return;
    this.transportInitialSyncComplete = true;
    this.recomputeStatus();
  }

  private async watchTransportDurableSync(
    provider: DocumentSessionTransportProvider,
  ): Promise<void> {
    await provider.whenDurablySynced;
    if (this.destroyed || provider !== this.transportProvider) return;
    this.transportDurableSyncComplete = true;
  }

  /**
   * Single derivation site for `status`. Called on every input change —
   * local persistence load, transport connection-state transition, transport
   * first-sync resolution — so the indicator never freezes on a startup value.
   *
   * Honesty matters here: only emit `synced` when edits are actually on the
   * server (transport connected AND first sync complete). When the transport
   * has no server channel, it remains explicitly detached rather than
   * presenting local persistence as a successful server sync.
   */
  private recomputeStatus(): void {
    if (this.destroyed) return;
    const next = this.deriveStatus();
    if (next === this.status) return;
    this.status = next;
    this.emit();
  }

  private deriveStatus(): DocumentSessionStatus {
    if (!this.transportProvider) return "detached";
    if (!this.localPersistenceSynced) return "syncing";

    const state = this.transportState;

    // Terminal transport states pre-empt the initial-sync gate: first sync will
    // never complete after permanent denial or a session-level terminal close.
    if (state?.kind === "unauthorized") return "access-lost";
    if (state?.kind === "reset") return "access-lost";
    if (state?.kind === "terminal") return "offline";

    // Empty local cache after a schema bump must resync from the server first.
    if (!this.transportInitialSyncComplete) return "syncing";

    const serverSynced = this.transportProvider.synced !== false;

    // Live disconnect: edits buffer locally until reconnect.
    if (state?.kind === "disconnected") return "offline";

    // Actively reconnecting/degraded after a drop — still syncing.
    if (state?.kind === "reconnecting" || state?.kind === "degraded") return "syncing";

    // Connecting or connected-but-not-yet-server-synced → syncing.
    if (state?.kind === "connecting") return "syncing";
    if (!serverSynced) return "syncing";

    // state?.kind === "connected" || (no state yet but provider reports synced)
    return "synced";
  }

  private emit(): void {
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) listener(snapshot);
  }
}
