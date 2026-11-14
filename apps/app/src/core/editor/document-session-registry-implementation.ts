/**
 * Account-scoped owner of live document sessions and stable-id draft rooms.
 * Live acquisition is lease-required; draft rooms retain their stable room identity.
 */
import type { AccountId } from "@meridian/contracts/protocol";
import type { DocumentId, ProjectId } from "@meridian/contracts/runtime";

import { createHocuspocusDocumentTransport } from "@/core/transport/hocuspocus-document-transport";
import type { DocumentSessionOptions, DocumentSessionTransportFactory } from "./document-session";
import { DocumentSession, type DocumentSessionSnapshot } from "./document-session";
import type {
  LiveDocumentSessionLease,
  RetainedLiveDocumentReference,
} from "./document-session-registry";
import { DocumentSessionTeardownOwner } from "./document-session-teardown-owner";
import { DraftRoomPool } from "./draft-room-pool";
import {
  type CopyHold,
  documentSessionPersistenceKey,
  LocalDocumentCopies,
} from "./local-document-copies";
import { readSchemaFenceQuarantine, writeSchemaFenceQuarantine } from "./schema-fence";

const LIVE_DOC_SOFT_CAP = 50;
const SESSION_TEARDOWN_GRACE_MS = 3_000;

type LiveRoomState = {
  session: DocumentSession | null;
  lease: LiveDocumentSessionLease;
  /** The shared hold on the session's local copy, taken with the session and released with it. */
  hold: Promise<CopyHold> | null;
};

/**
 * Longest a released live session stays connected to the server without it acknowledging the
 * unsent edits. The clock runs only while connected and restarts on every drop, so being offline
 * never runs it down.
 */
const UNSENT_EDITS_HOLD_MAX_MS = 10 * 60_000;

/** `detached`: this owner does not want the socket open. The registry attaches when any owner does. */
type RetainedLiveDocument = { lease: LiveDocumentSessionLease; detached: boolean };

export class DocumentSessionRegistry {
  private accountRuntimeState: "open" | "closing" | "closed" = "open";
  private accountCloseAttempt: Promise<void> | null = null;
  private readonly copies: LocalDocumentCopies;
  private readonly teardownOwner = new DocumentSessionTeardownOwner(
    (key) => new Error(`${key.kind === "live" ? "Live" : "Draft"} session teardown is unfinished`),
  );
  private readonly liveRooms = new Map<DocumentId, LiveRoomState>();
  private readonly draftRooms: DraftRoomPool;
  private readonly retainedByOwner = new Map<string, Map<DocumentId, RetainedLiveDocument>>();
  private readonly retainedObservers = new Set<
    (snapshot: readonly RetainedLiveDocumentReference[]) => void
  >();
  private readonly pendingTeardownTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Stops the connected-time cap of a held session kept open until the server acknowledges its edits. */
  private readonly holdCapStops = new Map<string, () => void>();
  private liveDocCapWarningEmitted = false;
  private readonly sessionObservers = new Map<
    string,
    Map<(snapshot: DocumentSessionSnapshot) => void, (() => void) | undefined>
  >();
  /** Each refused live session's drop: running, or settled whether or not it removed the room. */
  private readonly refusedRoomDrops = new WeakMap<DocumentSession, Promise<void> | "settled">();

  constructor(
    private readonly accountId: AccountId,
    private readonly transportFactory: DocumentSessionTransportFactory = ({
      roomKey,
      document,
      awareness,
    }) => createHocuspocusDocumentTransport({ roomName: roomKey, document, awareness }),
    private readonly teardownGraceMs = SESSION_TEARDOWN_GRACE_MS,
    copies: LocalDocumentCopies = new LocalDocumentCopies(accountId),
  ) {
    this.copies = copies;
    this.draftRooms = new DraftRoomPool({
      openSession: (roomKey) => {
        const session = this.createSession(roomKey, { kind: "indexeddb", key: roomKey });
        this.attachSessionTransport(session);
        return session;
      },
      teardownOwner: this.teardownOwner,
      teardownGraceMs,
    });
  }

  admit(projectId: ProjectId, documentId: DocumentId): LiveDocumentSessionLease {
    this.requireAccountRuntimeOpen();
    this.teardownOwner.assertAvailable({ kind: "live", roomKey: documentId });
    const lease = Object.freeze({ accountId: this.accountId, projectId, documentId });
    const state = this.liveRooms.get(documentId);
    if (state) state.lease = lease;
    else this.liveRooms.set(documentId, { session: null, lease, hold: null });
    return lease;
  }

  /** The session closes without waiting for unsent edits: nothing can deliver them to this account. */
  async clearLocalCopy(documentId: DocumentId): Promise<void> {
    this.cancelPendingTeardown(documentId);
    let retainedChanged = false;
    for (const retained of this.retainedByOwner.values()) {
      retainedChanged = retained.delete(documentId) || retainedChanged;
    }
    if (retainedChanged) this.publishRetainedLiveDocuments();
    const state = this.liveRooms.get(documentId);
    this.liveRooms.delete(documentId);
    if (state?.session) {
      await this.teardownOwner.retire({ kind: "live", roomKey: documentId }, state.session);
    }
    await this.teardownOwner.drainRoom({ kind: "live", roomKey: documentId });
    (await state?.hold)?.release();
    await this.copies.clear(documentId);
  }

  localCopies(): Promise<DocumentId[]> {
    return this.copies.list();
  }

  get(lease: LiveDocumentSessionLease): DocumentSession {
    const state = this.requireLease(lease);
    return this.getOrCreateLiveSession(lease, state, true);
  }

  async restartUnavailableRoom(lease: LiveDocumentSessionLease): Promise<boolean> {
    const state = this.requireLease(lease);
    const session = state.session;
    if (!session) return false;
    const snapshot = session.getSnapshot();
    if (
      snapshot.schemaFence ||
      snapshot.status === "detached" ||
      session.resetDisposition === "refused"
    )
      return false;
    if (
      snapshot.status !== "access-lost" &&
      snapshot.connectionState?.kind !== "unauthorized" &&
      snapshot.connectionState?.kind !== "terminal"
    ) {
      return false;
    }
    this.cancelPendingTeardown(lease.documentId);
    try {
      await session.restartTransport(this.transportFactory);
    } finally {
      this.scheduleTeardownIfUnretained(lease.documentId);
    }
    return true;
  }

  retain(
    ownerId: string,
    leases: Iterable<LiveDocumentSessionLease>,
    options: { detachedDocumentIds?: Iterable<DocumentId> } = {},
  ): void {
    const detached = new Set(options.detachedDocumentIds);
    const retained = new Map<DocumentId, RetainedLiveDocument>();
    for (const lease of leases) {
      this.requireLease(lease);
      retained.set(lease.documentId, { lease, detached: detached.has(lease.documentId) });
    }
    this.retainedByOwner.set(ownerId, retained);
    this.reconcileRetainedSessions();
    this.publishRetainedLiveDocuments();
  }

  setHosted(ownerId: string, hosted: boolean): void {
    const retained = this.retainedByOwner.get(ownerId);
    if (!retained) return;
    for (const owner of retained.values()) owner.detached = !hosted;
    this.reconcileRetainedSessions();
  }

  release(ownerId: string): void {
    if (!this.retainedByOwner.delete(ownerId)) return;
    this.reconcileRetainedSessions();
    this.publishRetainedLiveDocuments();
  }

  observeRetainedLiveDocuments(
    observer: (snapshot: readonly RetainedLiveDocumentReference[]) => void,
  ): () => void {
    this.retainedObservers.add(observer);
    this.notifyRetainedObserver(observer, this.retainedSnapshot());
    return () => this.retainedObservers.delete(observer);
  }

  retainDraftRooms(ownerId: string, refs: readonly string[]): void {
    this.draftRooms.retain(ownerId, refs);
  }

  releaseDraftRooms(ownerId: string): void {
    this.draftRooms.release(ownerId);
  }

  rebuildDraftRoom(roomKey: string): Promise<DocumentSession> {
    return this.draftRooms.rebuild(roomKey);
  }

  closeDraftRoom(roomKey: string): Promise<void> {
    return this.draftRooms.close(roomKey);
  }

  getDraftRoom(roomKey: string): DocumentSession {
    return this.draftRooms.get(roomKey);
  }

  beginCloseAccountRuntime(): void {
    if (this.accountRuntimeState === "open") this.accountRuntimeState = "closing";
  }

  closeAccountRuntime(): Promise<void> {
    this.beginCloseAccountRuntime();
    if (this.accountRuntimeState === "closed") return Promise.resolve();
    if (this.accountCloseAttempt) return this.accountCloseAttempt;
    const attempt = this.invalidateAll().then(() => {
      this.accountRuntimeState = "closed";
    });
    this.accountCloseAttempt = attempt;
    void attempt
      .finally(() => {
        if (this.accountCloseAttempt === attempt) this.accountCloseAttempt = null;
      })
      .catch(() => undefined);
    return attempt;
  }

  observeDraftRoom(
    roomKey: string,
    observer: (snapshot: DocumentSessionSnapshot) => void,
  ): () => void {
    return this.observeRoom(roomKey, observer);
  }

  invalidateAll(): Promise<void> {
    this.beginCloseAccountRuntime();
    this.clearRetainedLiveDocuments();
    this.draftRooms.invalidate();
    this.liveDocCapWarningEmitted = false;
    for (const timer of this.pendingTeardownTimers.values()) clearTimeout(timer);
    this.pendingTeardownTimers.clear();
    for (const stop of this.holdCapStops.values()) stop();
    this.holdCapStops.clear();
    const liveSessions = [...this.liveRooms.entries()].flatMap(([documentId, { session, hold }]) =>
      session ? [{ documentId, session, hold }] : [],
    );
    this.liveRooms.clear();
    for (const { documentId, session, hold } of liveSessions) {
      void this.teardownOwner
        .retire({ kind: "live", roomKey: documentId }, session)
        .then(async () => (await hold)?.release())
        .catch(() => undefined);
    }
    return this.teardownOwner.drain();
  }

  private clearRetainedLiveDocuments(): void {
    const hadRetainedReferences = [...this.retainedByOwner.values()].some(
      (retained) => retained.size > 0,
    );
    this.retainedByOwner.clear();
    if (hadRetainedReferences) this.publishRetainedLiveDocuments();
  }

  private requireLease(lease: LiveDocumentSessionLease): LiveRoomState {
    if (lease.accountId !== this.accountId) throw new Error("Lease belongs to another account");
    const state = this.liveRooms.get(lease.documentId);
    if (!state) throw new Error(`Lease is stale for ${lease.documentId}`);
    return state;
  }

  private getOrCreateLiveSession(
    lease: LiveDocumentSessionLease,
    state: LiveRoomState,
    attach: boolean,
  ): DocumentSession {
    this.cancelPendingTeardown(lease.documentId);
    this.teardownOwner.assertAvailable({ kind: "live", roomKey: lease.documentId });
    if (state.session) {
      if (attach && state.session.getSnapshot().status === "detached") {
        this.attachSessionTransport(state.session);
      }
      return state.session;
    }
    state.hold = this.copies.hold(lease.documentId);
    const session = this.createSession(lease.documentId, {
      kind: "indexeddb",
      key: documentSessionPersistenceKey(lease.accountId, lease.documentId),
    });
    state.session = session;
    if (attach) this.attachSessionTransport(session);
    this.maybeWarnLiveDocCap();
    return session;
  }

  private createSession(
    roomKey: string,
    persistence: DocumentSessionOptions["persistence"],
  ): DocumentSession {
    const session = this.constructSession(roomKey, persistence);
    this.publishSession(roomKey, session);
    return session;
  }

  private constructSession(
    roomKey: string,
    persistence: DocumentSessionOptions["persistence"],
  ): DocumentSession {
    let session!: DocumentSession;
    session = new DocumentSession({
      roomKey,
      persistence,
      ownUserId: this.accountId,
      persistSchemaFence: (fence) => writeSchemaFenceQuarantine(session.documentId, fence),
    });
    const quarantine = readSchemaFenceQuarantine(roomKey);
    if (quarantine) session.raiseSchemaFence(quarantine);
    // Subscribed before any host can be, so a refusal's drop is already
    // running when a host hears of it (`whenRefusedRoomDropped`).
    if (session.room.kind === "live")
      session.subscribe(() => {
        this.dropRefusedRoom(session);
        this.retireDrainedRoom(session);
        this.settleRetainedTransport(session);
      });
    return session;
  }

  private requireAccountRuntimeOpen(): void {
    if (this.accountRuntimeState !== "open") {
      throw new Error("Account document session runtime is closing");
    }
  }

  private attachSessionTransport(session: DocumentSession): void {
    if (session.getSnapshot().schemaFence) return;
    session.attachTransport(this.transportFactory);
  }

  whenRefusedRoomDropped(session: DocumentSession): Promise<void> | null {
    const drop = this.refusedRoomDrops.get(session);
    return drop === "settled" ? null : (drop ?? null);
  }

  /**
   * Drop a live room whose pending edits the server refused, even when no editor host holds it:
   * the session is torn down and its local copy cleared. Draft rooms hold no local copy; their
   * editor rebuilds them in place (`rebuildDraftRoom`).
   */
  private dropRefusedRoom(session: DocumentSession): void {
    if (this.refusedRoomDrops.has(session) || session.resetDisposition !== "refused") return;
    const documentId = session.documentId as DocumentId;
    if (this.liveRooms.get(documentId)?.session !== session) return;
    const settle = () => {
      this.refusedRoomDrops.set(session, "settled");
    };
    this.refusedRoomDrops.set(session, this.clearLocalCopy(documentId).then(settle, settle));
  }

  private retainedSnapshot(): readonly RetainedLiveDocumentReference[] {
    const references = new Map<string, RetainedLiveDocumentReference>();
    for (const retained of this.retainedByOwner.values()) {
      for (const { lease } of retained.values()) {
        const reference = Object.freeze({
          projectId: lease.projectId,
          documentId: lease.documentId,
        });
        references.set(`${lease.projectId}\0${lease.documentId}`, reference);
      }
    }
    return Object.freeze(
      [...references.values()].sort(
        (left, right) =>
          left.projectId.localeCompare(right.projectId) ||
          left.documentId.localeCompare(right.documentId),
      ),
    );
  }

  private publishRetainedLiveDocuments(): void {
    const snapshot = this.retainedSnapshot();
    for (const observer of this.retainedObservers) this.notifyRetainedObserver(observer, snapshot);
  }

  private notifyRetainedObserver(
    observer: (snapshot: readonly RetainedLiveDocumentReference[]) => void,
    snapshot: readonly RetainedLiveDocumentReference[],
  ): void {
    try {
      observer(snapshot);
    } catch {
      // A diagnostic observer cannot interrupt the registry's lease transaction.
    }
  }

  private reconcileRetainedSessions(): void {
    const keep = new Map<DocumentId, RetainedLiveDocument>();
    for (const retained of this.retainedByOwner.values()) {
      for (const [documentId, owner] of retained) {
        const prior = keep.get(documentId);
        keep.set(documentId, {
          lease: owner.lease,
          detached: (prior?.detached ?? true) && owner.detached,
        });
      }
    }
    for (const owner of keep.values()) {
      const state = this.requireLease(owner.lease);
      const session = this.getOrCreateLiveSession(owner.lease, state, !owner.detached);
      if (owner.detached) this.detachUnwantedTransport(session);
    }
    for (const [documentId, state] of this.liveRooms) {
      if (state.session && !keep.has(documentId)) {
        this.scheduleTeardown(documentId);
      }
    }
  }

  /**
   * The one place a retained session's socket closes: no owner wants it open and it has no
   * deliverable unsent edits. Attaching is `getOrCreateLiveSession`'s.
   */
  private detachUnwantedTransport(session: DocumentSession): void {
    if (session.getSnapshot().status === "detached" || this.mustKeepForUnsentEdits(session)) return;
    void session.detachTransport().catch(reportError);
  }

  /** A session whose unsent edits were acknowledged or became undeliverable no longer needs its socket. */
  private settleRetainedTransport(session: DocumentSession): void {
    const documentId = session.documentId as DocumentId;
    if (this.liveRooms.get(documentId)?.session !== session) return;
    let retained = false;
    for (const owners of this.retainedByOwner.values()) {
      const owner = owners.get(documentId);
      if (!owner) continue;
      if (!owner.detached) return;
      retained = true;
    }
    if (retained) this.detachUnwantedTransport(session);
  }

  private scheduleTeardown(roomKey: string): void {
    if (this.pendingTeardownTimers.has(roomKey) || this.holdCapStops.has(roomKey)) return;
    const timer = setTimeout(() => {
      this.pendingTeardownTimers.delete(roomKey);
      const state = this.liveRooms.get(roomKey);
      if (!state?.session || this.isRetained(roomKey)) return;
      // Like draft rooms, a session with unsent edits stays until they are acknowledged.
      // `retireDrainedRoom` ends the hold when the room can no longer take them; a room that
      // stays connected without acknowledging ends it at the cap. Offline time never counts.
      // The other exits (refused room, removed document, revoked access, account close) go
      // through `dropRefusedRoom`, `clearLocalCopy` and `invalidateAll`.
      if (this.mustKeepForUnsentEdits(state.session)) {
        this.holdUntilAcknowledged(roomKey, state, state.session);
        return;
      }
      this.retireLiveSession(roomKey, state);
    }, this.teardownGraceMs);
    this.pendingTeardownTimers.set(roomKey, timer);
  }

  private holdUntilAcknowledged(
    roomKey: string,
    state: LiveRoomState,
    session: DocumentSession,
  ): void {
    let capTimer: ReturnType<typeof setTimeout> | undefined;
    const stopClock = () => {
      clearTimeout(capTimer);
      capTimer = undefined;
    };
    const unsubscribe = session.subscribe((snapshot) => {
      if (snapshot.connectionState?.kind !== "connected") return stopClock();
      capTimer ??= setTimeout(() => {
        if (!this.isRetained(roomKey)) this.retireLiveSession(roomKey, state);
      }, UNSENT_EDITS_HOLD_MAX_MS);
    });
    this.holdCapStops.set(roomKey, () => {
      stopClock();
      unsubscribe();
    });
  }

  private mustKeepForUnsentEdits(session: DocumentSession): boolean {
    return session.hasUnacknowledgedEdits() && session.canDeliverUnsentEdits();
  }

  private retireLiveSession(roomKey: string, state: LiveRoomState): void {
    const session = state.session;
    if (!session) return;
    const hold = state.hold;
    state.session = null;
    state.hold = null;
    this.cancelPendingTeardown(roomKey);
    void this.teardownOwner
      .retire({ kind: "live", roomKey }, session)
      .then(async () => (await hold)?.release())
      .catch(() => undefined);
  }

  private retireDrainedRoom(session: DocumentSession): void {
    const roomKey = session.documentId;
    if (!this.holdCapStops.has(roomKey)) return;
    const state = this.liveRooms.get(roomKey);
    if (state?.session !== session) return;
    if (this.mustKeepForUnsentEdits(session)) return;
    // A refused room is dropped by `dropRefusedRoom`, which clears its copy.
    if (session.resetDisposition === "refused") return;
    this.retireLiveSession(roomKey, state);
  }

  // A restart cancels the pending teardown; a room no host retains still needs one.
  private scheduleTeardownIfUnretained(documentId: DocumentId): void {
    if (!this.isRetained(documentId)) this.scheduleTeardown(documentId);
  }

  private cancelPendingTeardown(roomKey: string): void {
    this.holdCapStops.get(roomKey)?.();
    this.holdCapStops.delete(roomKey);
    const timer = this.pendingTeardownTimers.get(roomKey);
    if (!timer) return;
    clearTimeout(timer);
    this.pendingTeardownTimers.delete(roomKey);
  }

  private isRetained(documentId: DocumentId): boolean {
    for (const retained of this.retainedByOwner.values()) if (retained.has(documentId)) return true;
    return false;
  }

  private publishSession(roomKey: string, session: DocumentSession): void {
    for (const [observer] of this.sessionObservers.get(roomKey) ?? []) {
      this.sessionObservers.get(roomKey)?.set(observer, session.subscribe(observer));
    }
  }

  private observeRoom(
    roomKey: string,
    observer: (snapshot: DocumentSessionSnapshot) => void,
  ): () => void {
    let observers = this.sessionObservers.get(roomKey);
    if (!observers) {
      observers = new Map();
      this.sessionObservers.set(roomKey, observers);
    }
    observers.set(
      observer,
      (this.draftRooms.peek(roomKey) ?? this.liveRooms.get(roomKey)?.session)?.subscribe(observer),
    );
    return () => {
      observers?.get(observer)?.();
      observers?.delete(observer);
      if (observers?.size === 0) this.sessionObservers.delete(roomKey);
    };
  }

  private maybeWarnLiveDocCap(): void {
    const liveCount = [...this.liveRooms.values()].filter(({ session }) => session).length;
    if (this.liveDocCapWarningEmitted || liveCount <= LIVE_DOC_SOFT_CAP) return;
    this.liveDocCapWarningEmitted = true;
    console.warn(
      `[document-session-registry] live document session count (${liveCount}) exceeds soft cap (${LIVE_DOC_SOFT_CAP})`,
    );
  }
}
