/**
 * document-session — owns the lifecycle of one collaborative document's CRDT.
 *
 * Wraps a Yjs `Y.Doc`, IndexedDB local persistence, awareness, and a pluggable
 * transport provider into a subscribable session with a status snapshot
 * (syncing / synced / offline / access-lost / destroyed). The single place document
 * collaboration state is created and torn down; `EditorView` binds to it.
 *
 * Status semantics — derived from BOTH local persistence and the live
 * transport connection state, so the indicator stays honest after the initial
 * load:
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
import { parseYjsRoomName, type YjsRoomName } from "@meridian/contracts/protocol";
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

export type DocumentSessionStatus = "syncing" | "synced" | "offline" | "access-lost" | "destroyed";

export type DocumentSessionSnapshot = {
  /** Back-compat live document id for existing editor consumers; draft sessions expose their draft id here. */
  documentId: string;
  /** Hocuspocus room key: live documents use the bare document id, drafts use `draft:<draftId>`. */
  roomKey: string;
  room: YjsRoomName;
  status: DocumentSessionStatus;
  connectionState: ConnectionState | null;
  localPersistenceSynced: boolean;
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
   * Subscribe to live connection-state updates from the underlying socket.
   * Implementations MUST emit the current state synchronously on subscribe
   * and on every subsequent change. Returns an unsubscribe function.
   */
  subscribeStatus?: (listener: (state: ConnectionState) => void) => () => void;
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
  /** Hocuspocus room key: live documents use the bare document id, drafts use `draft:<draftId>`. */
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
  private readonly transportProvider: DocumentSessionTransportProvider | null;
  private readonly listeners = new Set<Listener>();
  private readonly unsubscribeTransportStatus: (() => void) | null;
  private destroyed = false;
  private localPersistenceSynced = false;
  /** True after the transport's first `whenSynced` — blocks empty-local false `synced`. */
  private transportInitialSyncComplete = false;
  private status: DocumentSessionStatus = "syncing";
  /**
   * Latest live connection-state from the transport. When the transport is
   * pre-`whenSynced` we treat the session as syncing; this field lets us
   * distinguish "connected & synced" from "disconnected" after that.
   */
  private transportState: ConnectionState | null = null;
  private presenceSuspendDepth = 0;
  private suspendedLocalAwarenessState: Record<string, unknown> | null = null;
  private readonly syncedPromise: Promise<void>;

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
    this.documentId = room.kind === "live" ? room.documentId : room.draftId;
    this.document = createCollabYDoc();
    this.awareness = new Awareness(this.document);
    if (enableIndexedDb) {
      deleteStaleVersionedIndexedDb(roomKey);
      this.persistence = new IndexeddbPersistence(persistenceKey, this.document);
    } else {
      this.persistence = null;
    }
    this.transportProvider =
      transportFactory?.({
        roomKey,
        room,
        document: this.document,
        awareness: this.awareness,
        fragmentName: this.fragmentName,
      }) ?? null;

    this.unsubscribeTransportStatus =
      this.transportProvider?.subscribeStatus?.((state) => {
        this.transportState = state;
        this.recomputeStatus();
      }) ?? null;

    this.syncedPromise = this.watchSync();
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
    };
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => {
      this.listeners.delete(listener);
    };
  }

  async whenSynced(): Promise<void> {
    await this.syncedPromise;
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
  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    this.status = "destroyed";
    this.emit();

    this.presenceSuspendDepth = 0;
    this.suspendedLocalAwarenessState = null;
    removeAwarenessStates(this.awareness, [this.document.clientID], "document-session-destroy");

    this.unsubscribeTransportStatus?.();
    await this.transportProvider?.destroy();
    await this.persistence?.destroy();
    this.awareness.destroy();
    this.document.destroy();
    this.listeners.clear();
  }

  private async watchSync(): Promise<void> {
    await this.persistence?.whenSynced;
    if (this.destroyed) return;
    this.localPersistenceSynced = true;
    this.recomputeStatus();

    await this.transportProvider?.whenSynced;
    if (this.destroyed) return;
    this.transportInitialSyncComplete = true;
    this.recomputeStatus();
  }

  /**
   * Single derivation site for `status`. Called on every input change —
   * local persistence load, transport connection-state transition, transport
   * first-sync resolution — so the indicator never freezes on a startup value.
   *
   * Honesty matters here: only emit `synced` when edits are actually on the
   * server (transport connected AND first sync complete). When the transport
   * has no server channel (no factory at all), local-only IS the steady state,
   * so `synced` still applies once persistence has loaded.
   */
  private recomputeStatus(): void {
    if (this.destroyed) return;
    const next = this.deriveStatus();
    if (next === this.status) return;
    this.status = next;
    this.emit();
  }

  private deriveStatus(): DocumentSessionStatus {
    if (!this.localPersistenceSynced) return "syncing";

    // No transport at all → local-only session; persistence load IS being synced.
    if (!this.transportProvider) return "synced";

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
