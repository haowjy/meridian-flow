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

import type { ClosedOwnerWhy } from "@meridian/contracts/commands";
import {
  type ChangeEventWsMessage,
  parseYjsRoomName,
  WS_CLOSE,
  type YjsRoomName,
} from "@meridian/contracts/protocol";
import type { ConnectionState } from "@meridian/thread-client";
import type { Editor } from "@tiptap/core";
import { IndexeddbPersistence } from "y-indexeddb";
import { Awareness, removeAwarenessStates } from "y-protocols/awareness";
import * as Y from "yjs";
import { requireReload } from "@/client/release/release";
import { DocumentHistory } from "./editor-history";
import type { Ranges } from "./item-ranges";
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
import type { SchemaFence } from "./schema-fence";
import {
  createSchemaRepairWitness,
  type SchemaRepairEvent,
  type SchemaRepairWitness,
} from "./schema-repair-witness";

export type { SchemaFence } from "./schema-fence";

import { createServerMark, type ServerMark } from "./server-mark";
import { SessionMarkerStore } from "./session-marker-store";
import { UnsentEdits } from "./unsent-edits";

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
  documentId: string;
  /** Hocuspocus room key: the bare document id. */
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
  /** Why a read-only room is read-only, when its owner is closed (a Work archived or deleted, a chat in Trash). */
  closedWhy: ClosedOwnerWhy | null;
  /** A read admission whose reason has not arrived yet: `closedWhy` may still change. */
  reasonPending: boolean;
  localPersistenceSynced: boolean;
  schemaFence: SchemaFence | null;
  schemaRepairs: SchemaRepairEvent[];
  /**
   * The room holds the writer's edits that the server lacks and can never deliver them: it was
   * admitted read-only and its last handshake found them, or the server kept refusing its updates
   * (`updatesRefused`).
   */
  holdsUndeliverableEdits: boolean;
};

/** What one read-admitted handshake found: the update the server lacks, and its snapshot (state vector and delete set), encoded. */
export type HandshakeDifference = { lacking: Uint8Array; server: Uint8Array };

export type DocumentSessionAccess = "edit" | "read";

export type DocumentSessionResetReason =
  | typeof WS_CLOSE.CLIENT_SCHEMA_SUPERSEDED.reason
  | typeof WS_CLOSE.DOCUMENT_SCHEMA_STALE.reason
  /** The document was deleted or discarded; its rooms never reopen. */
  | typeof WS_CLOSE.DOCUMENT_DELETED.reason;

/**
 * How a terminal room reset treats its unacknowledged writer updates.
 * `removed`: the server closed the room because the document was purged, so nothing reconnects,
 * rebuilds or replays on its own; the session stays read-only until its owner
 * closes it, or an exact open proves the document present and restarts it.
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

/**
 * Client-side terminal reason: the server could not store this room's updates on several
 * reconnects in a row. Its edits are undeliverable, and its owner replaces the room.
 */
export const UPDATES_REFUSED = "updates-refused";

export function updatesRefused(state: DocumentSessionConnectionState | null | undefined): boolean {
  return state?.kind === "terminal" && state.reason === UPDATES_REFUSED;
}

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
  /** Local updates not acknowledged on this connection, merged; null when none. */
  unacknowledgedUpdates(): Uint8Array | null;
  whenCurrentChangesAcknowledged?: () => Promise<void>;
  synced?: boolean;
  whenSynced?: Promise<void>;
  /**
   * Re-armable signal: the server has acknowledged the handshake and every
   * document update sent on the current connection. False on any local change,
   * on disconnect, and in terminal states; never inferred from the provider's
   * `unsyncedChanges` counter, which a reconnect resets mid-flight. Emits the
   * current value synchronously on subscribe, then on every change and when
   * the local outbox becomes non-empty (with those bytes already visible).
   */
  subscribeServerAcknowledgement?: (listener: (acknowledged: boolean) => void) => () => void;
  /**
   * Subscribe to live connection-state updates from the underlying socket.
   * Implementations MUST emit the current state synchronously on subscribe
   * and on every subsequent change. Returns an unsubscribe function.
   */
  subscribeStatus?: (listener: (state: DocumentSessionConnectionState) => void) => () => void;
  /**
   * Each handshake of a read-admitted connection says what the document holds that the server
   * lacks (null when nothing). Never called on an edit admission.
   */
  subscribeDifference?: (listener: (difference: HandshakeDifference | null) => void) => () => void;
  /**
   * What the server is known to hold, as a state vector: its SyncStep1 at each handshake
   * (`handshake`), and the whole document once it acknowledged everything. Written into the copy's
   * mark (`server-mark.ts`).
   */
  subscribeServerHas?: (listener: (vector: Uint8Array, handshake: boolean) => void) => () => void;
  /** The origin of the updates the server's answers apply; every other origin is a local change. */
  readonly serverOrigin?: unknown;
  /** On a read-admitted connection, one more handshake; the server's answer is the verdict. */
  requestHandshake?: () => void;
  /**
   * Every scope the server names for this room, and on subscribe the one it
   * last named. Nothing until it names one: a transport never invents a scope.
   */
  subscribeAccess?: (
    listener: (
      access: DocumentSessionAccess,
      closedWhy: ClosedOwnerWhy | null,
      reasonPending: boolean,
    ) => void,
  ) => () => void;
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
  /** Hocuspocus room key: the bare document id. */
  roomKey: string;
  /** Exact cache identity. Only the owner that just reserved it may declare it fresh. */
  persistence: { kind: "indexeddb"; key: string; fresh?: boolean } | { kind: "none" };
  /** Plugs the server document-sync provider into the session-owned Y.Doc. */
  transportFactory?: DocumentSessionTransportFactory;
  /** Registry-owned persistence hook for the first fence transition. */
  persistSchemaFence?: (fence: SchemaFence) => void;
  ownUserId?: string | null;
  /** The scope of a room this session replaces: the editor is read-only from its first frame. */
  access?: DocumentSessionAccess | null;
};

const noop = () => {};

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
  /** The writer's undo, kept with the document: editors attach to it while mounted. */
  readonly history: DocumentHistory;
  /** What the document holds that a read-admitting server lacks, and which of it is the writer's. */
  private readonly unsent: UnsentEdits;
  /** What the server is known to hold, written into the copy. */
  private readonly serverMark: ServerMark;

  private persistence: IndexeddbPersistence | null;
  private localPeers: LocalDocumentPeers | null = null;
  private initialization: Promise<void> | null = null;
  private transportProvider: DocumentSessionTransportProvider | null = null;
  private transportAttachmentPending = false;
  /** The closing of a transport `detachTransport` released; the next one opens after it. */
  private detaching: Promise<void> | null = null;
  /** Adopter-reported failure to reach server ownership; surfaced only while the session is `detached`. */
  private readonly listeners = new Set<Listener>();
  private unsubscribeTransportStatus: (() => void) | null = null;
  private unsubscribeTransportAccess: (() => void) | null = null;
  private unsubscribeChangeEvents: (() => void) | null = null;
  private unsubscribeAcknowledgement: (() => void) | null = null;
  private unsubscribeDifference: (() => void) | null = null;
  private unsubscribeServerHas: (() => void) | null = null;
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
  private observedOutboxPresence = false;
  private observedHolds = false;
  // Distinct connection states can share a status (`disconnected` and
  // `terminal` are both `offline`); subscribers still need the new one.
  private emittedTransportState: DocumentSessionConnectionState | null = null;
  /**
   * Latest live connection-state from the transport. When the transport is
   * pre-`whenSynced` we treat the session as syncing; this field lets us
   * distinguish "connected & synced" from "disconnected" after that.
   */
  private transportState: DocumentSessionConnectionState | null = null;
  private access: DocumentSessionAccess | null = null;
  private closedWhy: ClosedOwnerWhy | null = null;
  private reasonPending = false;
  /**
   * Read admission only: whether this connection's last handshake found the writer's edits the
   * server lacks. `differenceAnswered` is false from a connection's start, and from any change
   * that is not a display write, until the next handshake answers.
   */
  private holdsUndeliverable = false;
  private differenceAnswered = false;
  private lastDifference: HandshakeDifference | null = null;
  /** Called when a handshake answers, or the verdict is forgotten. */
  private readonly verdictWaiters = new Set<() => void>();
  /** Replaced by another session: nothing more goes to the server or to other tabs. */
  private inert = false;
  private boundEditors = 0;
  private readonly unbound = new Set<() => void>();
  private schemaFence: SchemaFence | null = null;
  private schemaRepairs: SchemaRepairEvent[] = [];
  private schemaRepairWitness: SchemaRepairWitness | null = null;
  private readonly persistSchemaFence: ((fence: SchemaFence) => void) | undefined;
  private readonly localPresence: LocalPresence;
  /** `detachTransport` holds one presence suspension until the next transport attaches. */
  private presenceHeldForTransport = false;
  /** Page hide is a presence suspension; `pageshow` releases it only if this listener took it. */
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
    ownUserId = null,
    access = null,
  }: DocumentSessionOptions) {
    const room = parseYjsRoomName(roomKey);
    if (room?.kind !== "live") throw new Error(`Invalid Yjs room key: ${roomKey}`);
    this.roomKey = roomKey;
    this.access = access;
    this.room = room;
    this.documentId = room.documentId;
    this.document = new Y.Doc();
    this.history = DocumentHistory.forDocument(this.document);
    this.unsent = new UnsentEdits(this.document, () => this.persistence?.db ?? null);
    this.serverMark = createServerMark(() =>
      this.destroyed ? null : (this.persistence?.db ?? null),
    );
    this.document.on("update", this.onDocumentUpdate);
    this.persistSchemaFence = persistSchemaFence;
    this.markerStore = new SessionMarkerStore(ownUserId);
    this.awareness = new Awareness(this.document);
    this.localPresence = createLocalPresence(this.awareness);
    if (typeof window !== "undefined") {
      window.addEventListener("pagehide", this.onPageHide);
      window.addEventListener("pageshow", this.onPageShow);
    }
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
    // A replaced session never reaches the server again: the words it handed back stay out of it.
    if (this.inert) return;
    if (this.transportProvider || this.transportAttachmentPending) {
      throw new Error(`Transport already attached to room: ${this.roomKey}`);
    }

    this.transportAttachmentPending = true;
    this.recomputeStatus();
    if ((this.persistence && !this.localPersistenceSynced) || this.detaching) {
      void Promise.all([
        this.detaching,
        this.persistence && !this.localPersistenceSynced
          ? this.waitForLocalPersistenceTransportGate()
          : null,
      ]).then(() => {
        if (!this.destroyed && !this.inert && this.resetDisposition === null)
          this.connectTransport(transportFactory);
      });
      return;
    }
    this.connectTransport(transportFactory);
  }

  private connectTransport(transportFactory: DocumentSessionTransportFactory): void {
    // Before the factory, so the new provider's first handshake carries this client's presence.
    this.resumePresenceForTransport();
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
        if (state.kind !== "connected") this.forgetDifference();
        if (updatesRefused(state)) this.holdsUndeliverable = true;
        if ((state.kind === "unauthorized" && !isSignInLapse(state)) || state.kind === "reset")
          this.localPeers?.stop();
        if (state.kind === "reset" && state.reason === WS_CLOSE.CLIENT_SCHEMA_SUPERSEDED.reason) {
          // Editing stops here; the app-wide reload (one per release) is what lifts it.
          requireReload();
          this.raiseSchemaFence({ reason: "client-superseded" });
        }
        this.recomputeStatus();
      }) ?? null;
    this.unsubscribeTransportAccess =
      this.transportProvider.subscribeAccess?.((access, closedWhy, reasonPending) => {
        if (
          access === this.access &&
          closedWhy === this.closedWhy &&
          reasonPending === this.reasonPending
        )
          return;
        this.access = access;
        this.closedWhy = closedWhy;
        this.reasonPending = reasonPending;
        this.forgetDifference();
        this.emit();
      }) ?? null;
    this.unsubscribeDifference =
      this.transportProvider.subscribeDifference?.((difference) => {
        this.differenceAnswered = true;
        this.lastDifference = difference;
        this.holdsUndeliverable = difference !== null && this.unsent.holdsUndeliverable(difference);
        this.recomputeStatus();
        for (const waiter of [...this.verdictWaiters]) waiter();
      }) ?? null;
    this.unsubscribeServerHas =
      this.transportProvider.subscribeServerHas?.((vector, handshake) =>
        this.serverMark.note(vector, handshake),
      ) ?? null;
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

  /**
   * Close the server transport and keep the Y.Doc, its local persistence and its history. Edits
   * made after this wait in the document until `attachTransport` syncs the difference. A
   * following `attachTransport` waits for this to finish.
   */
  detachTransport(): Promise<void> {
    const previous = this.transportProvider;
    if (this.destroyed || !previous) return this.detaching ?? Promise.resolve();
    this.unsubscribeTransportStatus?.();
    this.unsubscribeTransportAccess?.();
    this.unsubscribeChangeEvents?.();
    this.unsubscribeAcknowledgement?.();
    this.unsubscribeDifference?.();
    this.unsubscribeServerHas?.();
    this.unsubscribeTransportStatus = null;
    this.unsubscribeTransportAccess = null;
    this.unsubscribeChangeEvents = null;
    this.unsubscribeAcknowledgement = null;
    this.unsubscribeDifference = null;
    this.unsubscribeServerHas = null;
    this.forgetDifference();
    // The provider never destroys this session's Awareness, so presence is held here and put
    // back on attach.
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
    const closing = Promise.resolve(previous.destroy());
    const settled = closing.then(noop, noop).then(() => {
      if (this.detaching === settled) this.detaching = null;
    });
    this.detaching = settled;
    this.emit();
    return closing;
  }

  /** Replace a terminal transport while preserving local persistence and the live Y.Doc. */
  async restartTransport(transportFactory: DocumentSessionTransportFactory): Promise<void> {
    if (this.destroyed) {
      throw new Error(`Cannot restart transport for destroyed room: ${this.roomKey}`);
    }
    await this.detachTransport();
    await this.localPeers?.drain();
    this.localPeers = null;
    this.attachTransport(transportFactory);
    this.startLocalPeers();
  }

  get resetDisposition(): ResetDisposition | null {
    return this.transportState?.kind === "reset" ? this.transportState.disposition : null;
  }

  unacknowledgedUpdates(): Uint8Array | null {
    return this.transportProvider?.unacknowledgedUpdates() ?? null;
  }

  /** Captured synchronously with an Apply snapshot; later typing does not move this barrier. */
  whenCurrentChangesAcknowledged(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let stop = () => {};
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        stop();
        if (error) reject(error);
        else resolve();
      };
      const prefix = this.transportProvider?.whenCurrentChangesAcknowledged?.();
      stop = this.subscribe((snapshot) => {
        if (this.isRoomEnded())
          finish(new Error("Document session can no longer acknowledge this cut"));
        // A read-admitted connection acknowledges nothing: its verdict is the handshake's.
        else if ((!prefix || snapshot.access === "read") && snapshot.serverHasLocalChanges)
          finish();
      });
      if (settled) stop();
      void prefix?.then(
        () => finish(),
        (error: Error) => finish(error),
      );
    });
  }

  /**
   * Settles once the server holds what this room holds now, or at once while the room is not
   * synced or is read-admitted, and when it stops being synced or becomes read: the server will
   * never take a read room's typing, and a caller deciding from the server's state never waits on
   * a reconnect.
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

  /**
   * Reads the local copy (words another tab stored that this tab never received) and takes one
   * more handshake, so the verdict is the whole browser's. Resolves whether the room still holds
   * edits the server will not take; false when the connection ended or turned editable meanwhile.
   */
  async decideAgain(): Promise<boolean> {
    await this.localPeers?.catchUp().catch((error) => reportError(error));
    const provider = this.transportProvider;
    if (!provider || this.access !== "read") return false;
    const answered = new Promise<boolean>((resolve) => {
      const waiter = () => {
        this.verdictWaiters.delete(waiter);
        resolve(this.holdsUndeliverable);
      };
      this.verdictWaiters.add(waiter);
    });
    this.differenceAnswered = false;
    provider.requestHandshake?.();
    return answered;
  }

  /**
   * The typing the last read-admitted handshake found the server lacks (`UnsentEdits.undeliverable`),
   * as the items (`lacking`) and the document they live in, encoded so it can be read after the
   * session is made inert. Null when the room holds none.
   */
  undeliverableEdits(): { copy: Uint8Array; lacking: Ranges } | null {
    const difference = this.lastDifference;
    if (!difference || !this.holdsUndeliverable) return null;
    return {
      copy: Y.encodeStateAsUpdate(this.document),
      lacking: this.unsent.undeliverable(difference),
    };
  }

  /**
   * Another session replaces this room: stop offering anything to the server and other tabs. The
   * document stays readable until its editors have gone and it is destroyed.
   */
  get replaced(): boolean {
    return this.inert;
  }

  makeInert(): Promise<void> {
    this.inert = true;
    this.transportAttachmentPending = false;
    this.localPeers?.stop();
    this.recomputeStatus();
    return this.detachTransport();
  }

  hasUnacknowledgedEdits(): boolean {
    return this.unacknowledgedUpdates() !== null;
  }

  /**
   * Whether this room can still take the unsent edits: false once it is reset, unauthorized,
   * terminal, destroyed or admitted read-only (the server drops writes without closing).
   * Owners that keep a released session until its edits are acknowledged ask this to know the
   * wait can end.
   */
  canDeliverUnsentEdits(): boolean {
    return !this.isRoomEnded() && this.access !== "read";
  }

  /** The room itself is over, whatever its access: reset, unauthorized, terminal or destroyed. */
  isRoomEnded(): boolean {
    const { status, connectionState } = this.getSnapshot();
    return (
      this.resetDisposition !== null ||
      status === "destroyed" ||
      status === "access-lost" ||
      connectionState?.kind === "reset" ||
      (connectionState?.kind === "unauthorized" && !isSignInLapse(connectionState)) ||
      connectionState?.kind === "terminal"
    );
  }

  /**
   * A new connection, or a new scope, starts with no verdict. Called before each recompute that
   * follows one, so a stale verdict never reads as the new connection's.
   */
  private forgetDifference(): void {
    this.differenceAnswered = false;
    this.holdsUndeliverable = false;
    this.lastDifference = null;
    for (const waiter of [...this.verdictWaiters]) waiter();
  }

  /**
   * On a read-admitted connection a local change that is not a display write makes the verdict
   * unknown, and one handshake decides again. Changes the server's answers apply carry the
   * transport's origin and never get here.
   */
  private readonly onDocumentUpdate = (
    _update: Uint8Array,
    origin: unknown,
    _document: Y.Doc,
    transaction: Y.Transaction,
  ): void => {
    const provider = this.transportProvider;
    if (this.access !== "read" || !provider || origin === provider.serverOrigin) return;
    if (this.unsent.isDisplayWrite(transaction)) return;
    this.differenceAnswered = false;
    provider.requestHandshake?.();
    this.recomputeStatus();
  };

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
      closedWhy: this.closedWhy,
      reasonPending: this.reasonPending,
      localPersistenceSynced: this.localPersistenceSynced,
      schemaFence: this.schemaFence,
      schemaRepairs: this.schemaRepairs,
      holdsUndeliverableEdits: this.holdsUndeliverable,
    };
  }

  /**
   * Snapshot and arm once, immediately before the first binding is constructed.
   * Every later view contributes PM attribution to the same document witness.
   * Releasing a view removes only its attribution, never document observation.
   */
  bindEditor(
    construct: () => Editor,
    evidenceDegraded = false,
  ): {
    editor: Editor;
    release: () => void;
  } {
    if (this.destroyed) throw new Error("Cannot bind an editor to a destroyed session");
    const firstBinding = this.schemaRepairWitness === null;
    this.schemaRepairWitness ??= createSchemaRepairWitness({
      document: this.document,
      evidenceDegraded,
      onRepair: (event) => this.reportSchemaRepair(event),
    });
    const witness = this.schemaRepairWitness;
    try {
      const editor = construct();
      const leave = witness.enterLive(editor);
      this.boundEditors += 1;
      let released = false;
      return {
        editor,
        release: () => {
          leave();
          if (released) return;
          released = true;
          this.boundEditors -= 1;
          if (this.boundEditors === 0) for (const done of [...this.unbound]) done();
        },
      };
    } catch (error) {
      if (firstBinding) {
        witness.destroy();
        this.schemaRepairWitness = null;
      }
      throw error;
    }
  }

  /** Resolves once no editor is bound to this session: the moment it can be destroyed. */
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

  private resumePresenceForTransport(): void {
    if (!this.presenceHeldForTransport) return;
    this.presenceHeldForTransport = false;
    this.localPresence.resume();
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
  destroy(): Promise<void> {
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
        {
          settled: false,
          run: () => {
            if (typeof window === "undefined") return;
            window.removeEventListener("pagehide", this.onPageHide);
            window.removeEventListener("pageshow", this.onPageShow);
          },
        },
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
        { settled: false, run: () => this.unsubscribeDifference?.() },
        { settled: false, run: () => this.unsubscribeServerHas?.() },
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
          run: () => this.persistence?.destroy(),
        },
        { settled: false, run: () => this.schemaRepairWitness?.destroy() },
        { settled: false, run: () => this.awareness.destroy() },
        { settled: false, run: () => this.unsent.destroy() },
        { settled: false, run: () => this.history.destroy() },
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
    // The copy's updates are in the document; its display records are read after them.
    await this.unsent.readRecords().catch((error) => reportError(error));
    if (this.destroyed) return;
    this.localPersistenceSynced = true;
    this.startLocalPeers();
    this.recomputeStatus();
  }

  private startLocalPeers(): void {
    if (
      this.localPersistenceSynced &&
      !this.destroyed &&
      !this.inert &&
      !this.localPeers &&
      this.persistence &&
      !this.schemaFence &&
      (this.transportState?.kind !== "unauthorized" || isSignInLapse(this.transportState)) &&
      this.transportState?.kind !== "reset" &&
      typeof window !== "undefined" &&
      typeof BroadcastChannel === "function"
    )
      try {
        this.localPeers = new LocalDocumentPeers(
          this.document,
          this.persistence,
          this.awareness,
          this.unsent,
        );
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
    const acknowledged =
      next === "synced" &&
      (this.access === "read"
        ? this.differenceAnswered && !this.holdsUndeliverable
        : this.transportAcknowledged);
    const outboxPresent = this.hasUnacknowledgedEdits();
    if (
      next === this.status &&
      acknowledged === this.serverHasLocalChanges &&
      this.holdsUndeliverable === this.observedHolds &&
      outboxPresent === this.observedOutboxPresence &&
      this.transportState === this.emittedTransportState
    )
      return;
    this.observedOutboxPresence = outboxPresent;
    this.observedHolds = this.holdsUndeliverable;
    this.emittedTransportState = this.transportState;
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
    if (isSignInLapse(state)) return "offline";
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
