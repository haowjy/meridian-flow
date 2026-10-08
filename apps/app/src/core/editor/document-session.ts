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
 *                   currently connected and has completed its handshake. This
 *                   does NOT say the server has the writer's latest edits:
 *                   Hocuspocus sets `synced` on the server's SyncStep2 and its
 *                   own docs say it "does not mean all updates from the client
 *                   have been persisted". Use `serverHasLocalChanges` for that.
 *   - `offline`   — local persistence is loaded but the socket is
 *                   disconnected (edits are buffered in IndexedDB and may
 *                   upload after reconnect).
 *   - `access-lost` — the server permanently denied this document/session;
 *                   further local edits are NOT expected to upload.
 *   - `destroyed` — the session has been torn down.
 *
 * `access` is separate from status: the server's scope for this room. A `read`
 * room stays live (peers' changes still arrive) but takes no local edits.
 *
 * `serverHasLocalChanges` is separate from `status`: true only while `synced`
 * AND the server has acknowledged every local change on the current
 * connection (for a live room it journaled each update and applied it to its
 * in-memory document before replying; only the debounced full-document store
 * is asynchronous, and the next handshake re-sends anything lost). It
 * turns false on the next local edit and on any disconnect, then true again
 * after the acknowledgements arrive, so subscribers can show "back online and
 * saved" after an outage.
 */
import {
  type ChangeEventWsMessage,
  parseYjsRoomName,
  WS_CLOSE,
  type YjsRoomName,
} from "@meridian/contracts/protocol";
import { createCollabYDoc } from "@meridian/prosemirror-schema";
import { IndexeddbPersistence } from "y-indexeddb";
import { Awareness, removeAwarenessStates } from "y-protocols/awareness";
import type * as Y from "yjs";

import type { ConnectionState } from "@/core/transport/ThreadTransport";
import {
  commitContentInitialization,
  readContentInitialization,
} from "./local-content-initialization";
import { LocalDocumentPeers } from "./local-document-peers";
import {
  createLocalPresence,
  type LocalPresence,
  type LocalPresenceFields,
} from "./local-presence";
import { PROSEMIRROR_FRAGMENT_NAME } from "./schema";
import {
  attemptClientSchemaReload,
  clearClientSchemaReloadGuard,
  type SchemaFence,
} from "./schema-fence";
import type { SchemaRepairEvent } from "./schema-repair-witness";

export type { SchemaFence } from "./schema-fence";

import { SessionMarkerStore } from "./session-marker-store";

/** Give normal IndexedDB replay priority without letting blocked storage hold collaboration offline. */
const LOCAL_PERSISTENCE_TRANSPORT_TIMEOUT_MS = 1_000;

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
  /** Hocuspocus room key: the bare document id for a live document, `branch:<branchId>:gen:<generation>` for a branch room. */
  roomKey: string;
  room: YjsRoomName;
  status: DocumentSessionStatus;
  /** Server acknowledged every local change on this connection (see file header). */
  serverHasLocalChanges: boolean;
  connectionState: DocumentSessionConnectionState | null;
  /**
   * The scope the server last named for this room, kept across reconnects and
   * transport restarts; `null` until it names one. An unnamed room is writable
   * (local-first).
   */
  access: DocumentSessionAccess | null;
  localPersistenceSynced: boolean;
  /** Derived: true only while `detached` after a reported adoption failure; edits stay local only. */
  adoptionStalled: boolean;
  schemaFence: SchemaFence | null;
  schemaRepairs: SchemaRepairEvent[];
};

export type DocumentSessionAccess = "edit" | "read";

export type DocumentSessionResetReason =
  /** The room's access changed while local edits were pending; the server refused them. */
  | typeof WS_CLOSE.ACCESS_CHANGED.reason
  | typeof WS_CLOSE.BRANCH_STALE.reason
  | typeof WS_CLOSE.CLIENT_SCHEMA_SUPERSEDED.reason
  | typeof WS_CLOSE.DOCUMENT_SCHEMA_STALE.reason
  | "branch-generation-stale";

export type DocumentSessionConnectionState =
  | Exclude<ConnectionState, { kind: "reset" }>
  | {
      kind: "reset";
      reason: DocumentSessionResetReason;
      code?: number;
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
  synced?: boolean;
  whenSynced?: Promise<void>;
  /**
   * Re-armable signal: the server has acknowledged the handshake and every
   * document update sent on the current connection. False on any local change,
   * on disconnect, and in terminal states; never inferred from the provider's
   * `unsyncedChanges` counter, which a reconnect resets mid-flight. Emits the
   * current value synchronously on subscribe, then on every change.
   */
  subscribeServerAcknowledgement?: (listener: (acknowledged: boolean) => void) => () => void;
  /**
   * Subscribe to live connection-state updates from the underlying socket.
   * Implementations MUST emit the current state synchronously on subscribe
   * and on every subsequent change. Returns an unsubscribe function.
   */
  subscribeStatus?: (listener: (state: DocumentSessionConnectionState) => void) => () => void;
  /**
   * Every scope the server names for this room, and on subscribe the one it
   * last named. Nothing until it names one: a transport never invents a scope.
   */
  subscribeAccess?: (listener: (access: DocumentSessionAccess) => void) => () => void;
  subscribeChangeEvents?: (listener: (message: ChangeEventWsMessage) => void) => () => void;
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
  /** Hocuspocus room key: the bare document id for a live document, `branch:<branchId>:gen:<generation>` for a branch room. */
  roomKey: string;
  /** Exact cache identity. Only the owner that just reserved it may declare it fresh. */
  persistence: { kind: "indexeddb"; key: string; fresh?: boolean } | { kind: "none" };
  /** Plugs the server document-sync provider into the session-owned Y.Doc. */
  transportFactory?: DocumentSessionTransportFactory;
  /** Registry-owned persistence hook for the first fence transition. */
  persistSchemaFence?: (fence: SchemaFence) => void;
  ownUserId?: string | null;
};

type Listener = (snapshot: DocumentSessionSnapshot) => void;
type DestroyStage = { settled: boolean; run: () => void | Promise<void> };

export class DocumentSession {
  roomKey: string;
  room: YjsRoomName;
  documentId: string;
  readonly document: Y.Doc;
  readonly awareness: Awareness;
  readonly fragmentName = PROSEMIRROR_FRAGMENT_NAME;
  readonly markerStore: SessionMarkerStore;

  private persistence: IndexeddbPersistence | null;
  private localPeers: LocalDocumentPeers | null = null;
  private initialization: Promise<void> | null = null;
  private transportProvider: DocumentSessionTransportProvider | null = null;
  private transportAttachmentPending = false;
  /** Adopter-reported failure to reach server ownership; surfaced only while the session is `detached`. */
  private adoptionFailed = false;
  private readonly listeners = new Set<Listener>();
  private unsubscribeTransportStatus: (() => void) | null = null;
  private unsubscribeTransportAccess: (() => void) | null = null;
  private unsubscribeChangeEvents: (() => void) | null = null;
  private unsubscribeAcknowledgement: (() => void) | null = null;
  private destroyed = false;
  private destroyPromise: Promise<void> | null = null;
  private destroyStages: DestroyStage[] | null = null;
  private localPersistenceSynced = false;
  /** True after the transport's first `whenSynced` — blocks empty-local false `synced`. */
  private transportInitialSyncComplete = false;
  /** Raw transport signal; the snapshot exposes it only while `status` is `synced`. */
  private transportAcknowledged = false;
  private status: DocumentSessionStatus = "detached";
  private serverHasLocalChanges = false;
  /**
   * Latest live connection-state from the transport. When the transport is
   * pre-`whenSynced` we treat the session as syncing; this field lets us
   * distinguish "connected & synced" from "disconnected" after that.
   */
  private transportState: DocumentSessionConnectionState | null = null;
  private access: DocumentSessionAccess | null = null;
  private schemaFence: SchemaFence | null = null;
  private schemaRepairs: SchemaRepairEvent[] = [];
  private readonly persistSchemaFence: ((fence: SchemaFence) => void) | undefined;
  private readonly localPresence: LocalPresence;
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
    ownUserId = null,
  }: DocumentSessionOptions) {
    const room = parseYjsRoomName(roomKey);
    if (!room) throw new Error(`Invalid Yjs room key: ${roomKey}`);
    this.roomKey = roomKey;
    this.room = room;
    this.documentId = room.kind === "live" ? room.documentId : room.branchId;
    this.document = createCollabYDoc();
    this.persistSchemaFence = persistSchemaFence;
    this.markerStore = new SessionMarkerStore(ownUserId);
    this.awareness = new Awareness(this.document);
    this.localPresence = createLocalPresence(this.awareness);
    if (persistence.kind === "indexeddb") {
      this.persistence = new IndexeddbPersistence(persistence.key, this.document);
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
    if (persistence.kind === "indexeddb" && persistence.fresh)
      this.establishContentInitialization();
    if (transportFactory) this.attachTransport(transportFactory);
    this.emit();
  }

  /** Attach the session's only server transport after local replay, without replacing its Y.Doc. */
  attachTransport(transportFactory: DocumentSessionTransportFactory): void {
    if (this.destroyed)
      throw new Error(`Cannot attach transport to destroyed room: ${this.roomKey}`);
    if (this.transportProvider || this.transportAttachmentPending) {
      throw new Error(`Transport already attached to room: ${this.roomKey}`);
    }

    this.transportAttachmentPending = true;
    this.adoptionFailed = false;
    this.recomputeStatus();
    if (this.persistence && !this.localPersistenceSynced) {
      void this.waitForLocalPersistenceTransportGate().then(() => {
        if (!this.destroyed) this.connectTransport(transportFactory);
      });
      return;
    }
    this.connectTransport(transportFactory);
  }

  private connectTransport(transportFactory: DocumentSessionTransportFactory): void {
    try {
      this.transportProvider = transportFactory({
        roomKey: this.roomKey,
        room: this.room,
        document: this.document,
        awareness: this.awareness,
        fragmentName: this.fragmentName,
      });
    } catch (error) {
      this.transportAttachmentPending = false;
      this.recomputeStatus();
      this.emit();
      throw error;
    }
    this.transportAttachmentPending = false;
    this.resolveTransportAttached();
    this.status = "syncing";
    this.unsubscribeTransportStatus =
      this.transportProvider.subscribeStatus?.((state) => {
        this.transportState = state;
        if (state.kind === "unauthorized" || state.kind === "reset") this.localPeers?.stop();
        if (state.kind === "reset" && state.reason === WS_CLOSE.CLIENT_SCHEMA_SUPERSEDED.reason) {
          if (!attemptClientSchemaReload(this.roomKey)) {
            this.raiseSchemaFence({ reason: "client-superseded" });
          }
        }
        this.recomputeStatus();
      }) ?? null;
    this.unsubscribeTransportAccess =
      this.transportProvider.subscribeAccess?.((access) => {
        if (access === this.access) return;
        this.access = access;
        this.emit();
      }) ?? null;
    this.unsubscribeChangeEvents =
      this.room.kind === "live"
        ? (this.transportProvider.subscribeChangeEvents?.((message) => {
            if (message.documentId === this.documentId) this.markerStore.replaceGroup(message);
          }) ?? null)
        : null;
    this.unsubscribeAcknowledgement =
      this.transportProvider.subscribeServerAcknowledgement?.((acknowledged) => {
        this.transportAcknowledged = acknowledged;
        this.recomputeStatus();
      }) ?? null;
    void this.watchTransportSync(this.transportProvider);
    this.recomputeStatus();
    this.emit();
  }

  /** Replace a terminal transport while preserving local persistence and the live Y.Doc. */
  async restartTransport(transportFactory: DocumentSessionTransportFactory): Promise<void> {
    if (this.destroyed) {
      throw new Error(`Cannot restart transport for destroyed room: ${this.roomKey}`);
    }
    if (this.refusedLocalEdits()) {
      // A reconnect would replay the refused edits from this Y.Doc.
      throw new Error(`Cannot restart a room whose local edits were refused: ${this.roomKey}`);
    }
    const previous = this.transportProvider;
    this.unsubscribeTransportStatus?.();
    this.unsubscribeTransportAccess?.();
    this.unsubscribeChangeEvents?.();
    this.unsubscribeAcknowledgement?.();
    this.unsubscribeTransportStatus = null;
    this.unsubscribeTransportAccess = null;
    this.unsubscribeChangeEvents = null;
    this.unsubscribeAcknowledgement = null;
    this.transportProvider = null;
    this.transportState = null;
    this.transportInitialSyncComplete = false;
    this.transportAcknowledged = false;
    this.status = "detached";
    this.serverHasLocalChanges = false;
    await previous?.destroy();
    await this.localPeers?.drain();
    this.localPeers = null;
    this.attachTransport(transportFactory);
    this.startLocalPeers();
  }

  /** The server refused this Y.Doc's pending edits; only a rebuilt room may sync again. */
  refusedLocalEdits(): boolean {
    return (
      this.transportState?.kind === "reset" &&
      this.transportState.reason === WS_CLOSE.ACCESS_CHANGED.reason
    );
  }

  private waitForLocalPersistenceTransportGate(): Promise<void> {
    return new Promise((resolve) => {
      let complete = false;
      const finish = () => {
        if (complete) return;
        complete = true;
        clearTimeout(timeout);
        resolve();
      };
      const timeout = setTimeout(finish, LOCAL_PERSISTENCE_TRANSPORT_TIMEOUT_MS);
      void this.localPersistenceSyncedPromise.then(finish, finish);
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
      localPersistenceSynced: this.localPersistenceSynced,
      adoptionStalled: this.adoptionFailed && this.status === "detached",
      schemaFence: this.schemaFence,
      schemaRepairs: this.schemaRepairs,
    };
  }

  /**
   * The adopter reports whether a cached session cannot reach server ownership
   * (authority unreachable or adoption failed). A failure is recorded only while
   * the session is `detached` with no transport; otherwise it is a no-op, so a
   * transport-owned or destroyed session is never labelled stalled.
   */
  reportAdoptionStalled(stalled: boolean): void {
    if (this.destroyed) return;
    const next = stalled && this.status === "detached";
    if (this.adoptionFailed === next) return;
    this.adoptionFailed = next;
    this.emit();
  }

  /** Append one session-scoped repair verdict and notify every report surface. */
  reportSchemaRepair(event: SchemaRepairEvent): void {
    if (this.destroyed) return;
    this.schemaRepairs = [...this.schemaRepairs, event];
    this.emit();
  }

  /** Permanently stop editing for this session while preserving its connection status. */
  raiseSchemaFence(fence: SchemaFence): void {
    if (this.destroyed || this.schemaFence) return;
    this.schemaFence = fence;
    this.localPeers?.stop();
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

  /** Local-only same-session identity change used by conflict remint. */
  prepareDetachedReidentity(documentId: string): { commit(): void; abort(): void } {
    if (this.transportProvider || this.status !== "detached")
      throw new Error("Only a detached local session may be reminted");
    const room = parseYjsRoomName(documentId);
    if (room?.kind !== "live") throw new Error("Invalid reminted document identity");
    let settled = false;
    return {
      commit: () => {
        if (settled) return;
        settled = true;
        this.roomKey = documentId;
        this.room = room;
        this.documentId = documentId;
        try {
          this.emit();
        } catch {
          // Durable lineage authority already committed; observers cannot roll identity back.
        }
      },
      abort: () => {
        settled = true;
      },
    };
  }

  get persistenceName(): string | null {
    return this.persistence?.name ?? null;
  }

  /** Separate from replay readiness; absent evidence never authorizes empty initialization. */
  async hasInitializedLocalContent(): Promise<boolean> {
    await Promise.race([this.localPersistenceSyncedPromise, this.lifecycleCompletedPromise]);
    await this.initialization?.catch(() => undefined);
    if (this.destroyed || !this.persistence?.db) return false;
    return readContentInitialization(this.persistence.db);
  }

  private establishContentInitialization(): void {
    if (!this.persistence || this.initialization) return;
    const attempt = (async () => {
      await Promise.race([this.localPersistenceSyncedPromise, this.lifecycleCompletedPromise]);
      if (this.destroyed || this.schemaFence || !this.persistence?.db) return;
      const database = this.persistence.db;
      if (await readContentInitialization(database)) return;
      if (this.destroyed || this.schemaFence) return;
      await commitContentInitialization(database, this.document);
    })().finally(() => {
      if (this.initialization === attempt) this.initialization = null;
    });
    this.initialization = attempt;
    void attempt.catch((error) => reportError(error));
  }

  /** Opaque identity observation for authority transfer; callers cannot mutate the provider. */
  get localPersistenceProvider(): object | null {
    return this.persistence;
  }

  /**
   * Where every local awareness field is written, by every publisher in the
   * editor — including TipTap's caret and y-prosemirror's cursor plugin, which
   * reach it through `caretProvider` (`local-presence.ts`).
   *
   * The session owns whether this client is on the wire, so it has to own the
   * fields too: a publisher writing to `Awareness` directly loses its write
   * whenever presence is suspended, and suspension would then restore a value
   * the publisher had already corrected. This is the editor's whole reach into
   * awareness; `this.awareness` is the transport's.
   */
  get presence(): LocalPresenceFields {
    return this.localPresence;
  }

  /** Take this client off the wire. Field writes made meanwhile still count. */
  suspendPresence(): void {
    if (this.destroyed) return;
    this.localPresence.suspend();
  }

  /** Put this client back, with the fields as they now stand. */
  resumePresence(): void {
    if (this.destroyed) return;
    this.localPresence.resume();
  }

  /**
   * Cleanup ordering is intentionally caller-friendly: React unmounts the
   * TipTap editor first, then calls this method so providers can detach before
   * the Y.Doc is destroyed.
   */
  destroy(options: { clearPersistence?: boolean } = {}): Promise<void> {
    if (this.destroyPromise) return this.destroyPromise;
    if (!this.destroyStages) {
      this.destroyed = true;
      this.localPeers?.stop();
      this.resolveTransportAttached();
      this.resolveLifecycleCompleted();
      this.status = "destroyed";
      this.serverHasLocalChanges = false;
      this.destroyStages = [
        { settled: false, run: () => this.emit() },
        { settled: false, run: () => this.markerStore.clear() },
        { settled: false, run: () => this.localPresence.release() },
        {
          settled: false,
          run: () =>
            removeAwarenessStates(
              this.awareness,
              [this.awareness.clientID],
              "document-session-destroy",
            ),
        },
        { settled: false, run: () => this.unsubscribeTransportStatus?.() },
        { settled: false, run: () => this.unsubscribeTransportAccess?.() },
        { settled: false, run: () => this.unsubscribeChangeEvents?.() },
        { settled: false, run: () => this.unsubscribeAcknowledgement?.() },
        { settled: false, run: () => this.transportProvider?.destroy() },
        { settled: false, run: () => this.localPeers?.drain() },
        {
          settled: false,
          run: async () => {
            await this.initialization?.catch(() => undefined);
          },
        },
        {
          settled: false,
          run: () =>
            options.clearPersistence ? this.persistence?.clearData() : this.persistence?.destroy(),
        },
        { settled: false, run: () => this.awareness.destroy() },
        { settled: false, run: () => this.document.destroy() },
        { settled: false, run: () => this.listeners.clear() },
      ];
    }

    const attempt = (async () => {
      const errors: unknown[] = [];
      for (const stage of this.destroyStages ?? []) {
        if (stage.settled) continue;
        try {
          await stage.run();
          stage.settled = true;
        } catch (error) {
          errors.push(error);
        }
      }

      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, "Document session teardown failed");
    })().finally(() => {
      if (this.destroyPromise === attempt) this.destroyPromise = null;
    });
    this.destroyPromise = attempt;
    return attempt;
  }

  private async watchLocalPersistence(): Promise<void> {
    await this.persistence?.whenSynced;
    if (this.destroyed) return;
    this.localPersistenceSynced = true;
    this.startLocalPeers();
    this.recomputeStatus();
  }

  private startLocalPeers(): void {
    if (
      this.localPersistenceSynced &&
      !this.destroyed &&
      !this.localPeers &&
      this.persistence &&
      !this.schemaFence &&
      this.transportState?.kind !== "unauthorized" &&
      this.transportState?.kind !== "reset" &&
      typeof window !== "undefined" &&
      typeof BroadcastChannel === "function"
    )
      try {
        this.localPeers = new LocalDocumentPeers(this.document, this.persistence, this.awareness);
      } catch (error) {
        // A denied peer channel must not make successfully loaded writing unavailable.
        reportError(error);
      }
  }

  private async watchTransportSync(provider: DocumentSessionTransportProvider): Promise<void> {
    await provider.whenSynced;
    if (this.destroyed || provider !== this.transportProvider) return;
    this.transportInitialSyncComplete = true;
    if (provider.whenSynced) this.establishContentInitialization();
    clearClientSchemaReloadGuard(this.roomKey);
    this.recomputeStatus();
  }

  /**
   * Single derivation site for `status`. Called on every input change —
   * local persistence load, transport connection-state transition, transport
   * first-sync resolution — so the indicator never freezes on a startup value.
   *
   * Honesty matters here: `synced` means the transport is connected and its
   * first handshake is complete, not that the server holds the latest edits;
   * `serverHasLocalChanges` carries that and is derived here too so both
   * change together. When the transport has no server channel, it remains
   * explicitly detached rather than presenting local persistence as a
   * successful server sync.
   */
  private recomputeStatus(): void {
    if (this.destroyed) return;
    const next = this.deriveStatus();
    const acknowledged = next === "synced" && this.transportAcknowledged;
    if (next === this.status && acknowledged === this.serverHasLocalChanges) return;
    this.status = next;
    this.serverHasLocalChanges = acknowledged;
    this.emit();
  }

  private deriveStatus(): DocumentSessionStatus {
    if (!this.transportProvider) return this.transportAttachmentPending ? "syncing" : "detached";
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
