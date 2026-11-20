/** Account-scoped owner of live document sessions. Acquisition is lease-required. */
import type { AccountId } from "@meridian/contracts/protocol";
import type { DocumentId, ProjectId } from "@meridian/contracts/runtime";
import * as Y from "yjs";
import { createHocuspocusDocumentTransport } from "@/core/transport/hocuspocus-document-transport";
import type { DocumentSessionOptions, DocumentSessionTransportFactory } from "./document-session";
import { DocumentSession, type DocumentSessionAccess, updatesRefused } from "./document-session";
import type {
  LiveDocumentSessionLease,
  RetainedLiveDocumentReference,
} from "./document-session-registry";
import { DocumentSessionTeardownOwner } from "./document-session-teardown-owner";
import type { DocumentHistory } from "./editor-history";
import type { Ranges } from "./item-ranges";
import {
  type CopyHold,
  documentSessionPersistenceKey,
  incarnationName,
  LocalDocumentCopies,
} from "./local-document-copies";
import { readBeyond, readCopy, typedText } from "./rescued-text";
import { readSchemaFenceQuarantine, writeSchemaFenceQuarantine } from "./schema-fence";

const LIVE_DOC_SOFT_CAP = 50;
const SESSION_TEARDOWN_GRACE_MS = 3_000;
/** Most sessions kept for their undo once no host holds them; the least recently changed goes first. */
const KEPT_FOR_UNDO_CAP = 8;

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
    () => new Error("Live session teardown is unfinished"),
  );
  private readonly liveRooms = new Map<DocumentId, LiveRoomState>();
  private readonly retainedByOwner = new Map<string, Map<DocumentId, RetainedLiveDocument>>();
  private readonly retainedObservers = new Set<
    (snapshot: readonly RetainedLiveDocumentReference[]) => void
  >();
  private readonly pendingTeardownTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Stops the connected-time cap of a held session kept open until the server acknowledges its edits. */
  private readonly holdCapStops = new Map<string, () => void>();
  /** Sessions no host holds, kept while their history has something to undo or redo. */
  private readonly keptForUndo = new Map<string, { changed: number; stop: () => void }>();
  private undoClock = 0;
  private readonly historyObservers = new Set<() => void>();
  private liveDocCapWarningEmitted = false;
  private readonly droppedTypingObservers = new Set<() => void>();
  /** Each session's copy: the room's key and the incarnation it opened. */
  private readonly copyOf = new WeakMap<DocumentSession, { key: string; incarnation: number }>();
  private readonly replacing = new WeakSet<DocumentSession>();
  private readonly replacementObservers = new Map<
    string,
    Set<(session: DocumentSession) => void>
  >();

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
  }

  admit(projectId: ProjectId, documentId: DocumentId): LiveDocumentSessionLease {
    this.requireAccountRuntimeOpen();
    this.teardownOwner.assertAvailable(documentId);
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
      await this.teardownOwner.retire(documentId, state.session);
    }
    await this.teardownOwner.drainRoom(documentId);
    (await state?.hold)?.release();
    await this.copies.clear(documentId, ({ update, lacking }) =>
      readCopy(update, (document) => this.dropWords(document, lacking)),
    );
  }

  /**
   * Resolves true once no open session has unsent edits the server could still acknowledge, false
   * if some are still unsent at the deadline. What a session cannot deliver (offline, refused) is
   * not waited for.
   */
  async settleUnsentEdits(timeoutMs: number): Promise<boolean> {
    const sessions = [...this.liveRooms.values()].flatMap(({ session }) =>
      session ? [session] : [],
    );
    const pending = (session: DocumentSession) =>
      session.hasUnacknowledgedEdits() && session.canDeliverUnsentEdits();
    const settled = sessions.map(
      (session) =>
        new Promise<boolean>((resolve) => {
          if (!pending(session)) return resolve(true);
          const timer = setTimeout(() => {
            stop();
            resolve(false);
          }, timeoutMs);
          const stop = session.subscribe(() => {
            if (pending(session)) return;
            clearTimeout(timer);
            stop();
            resolve(true);
          });
        }),
    );
    return (await Promise.all(settled)).every(Boolean);
  }

  /** Calls `observer` with the documents this browser holds a copy of for the account, and again as they change. */
  observeLocalCopies(observer: (documents: ReadonlySet<DocumentId>) => void): () => void {
    return this.copies.observe(observer);
  }

  get(lease: LiveDocumentSessionLease): DocumentSession {
    const state = this.requireLease(lease);
    return this.getOrCreateLiveSession(lease, state, true);
  }

  openStateVector(documentId: DocumentId): Uint8Array | null {
    const session = this.liveRooms.get(documentId)?.session;
    return session ? Y.encodeStateVector(session.document) : null;
  }

  whenLiveHeld(documentId: DocumentId): Promise<void> {
    return (
      this.liveRooms.get(documentId)?.session?.whenServerHoldsLocalChanges() ?? Promise.resolve()
    );
  }

  history(roomKey: string): DocumentHistory | null {
    return this.liveRooms.get(roomKey as DocumentId)?.session?.history ?? null;
  }

  observeHistories(observer: () => void): () => void {
    this.historyObservers.add(observer);
    return () => this.historyObservers.delete(observer);
  }

  async restartUnavailableRoom(lease: LiveDocumentSessionLease): Promise<boolean> {
    const state = this.requireLease(lease);
    const session = state.session;
    if (!session) return false;
    const snapshot = session.getSnapshot();
    if (snapshot.schemaFence || snapshot.status === "detached") return false;
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

  invalidateAll(): Promise<void> {
    this.beginCloseAccountRuntime();
    this.clearRetainedLiveDocuments();
    this.liveDocCapWarningEmitted = false;
    for (const timer of this.pendingTeardownTimers.values()) clearTimeout(timer);
    this.pendingTeardownTimers.clear();
    for (const stop of this.holdCapStops.values()) stop();
    this.holdCapStops.clear();
    for (const kept of this.keptForUndo.values()) kept.stop();
    this.keptForUndo.clear();
    const liveSessions = [...this.liveRooms.entries()].flatMap(([documentId, { session, hold }]) =>
      session ? [{ documentId, session, hold }] : [],
    );
    this.liveRooms.clear();
    const retired = liveSessions.map(async ({ documentId, session, hold }) => {
      await this.teardownOwner.retire(documentId, session);
      (await hold)?.release();
    });
    return Promise.all([...retired, this.teardownOwner.drain()]).then(() => undefined);
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
    this.teardownOwner.assertAvailable(lease.documentId);
    if (state.session) {
      if (attach && state.session.getSnapshot().status === "detached") {
        this.attachSessionTransport(state.session);
      }
      return state.session;
    }
    const { session, hold } = this.openCopy(
      lease.documentId,
      documentSessionPersistenceKey(lease.accountId, lease.documentId),
    );
    state.hold = hold;
    state.session = session;
    if (attach) this.attachSessionTransport(session);
    this.maybeWarnLiveDocCap();
    return session;
  }

  /**
   * A session on the room's current incarnation, and the hold on it. The words an older incarnation
   * held that the server lacks are dropped once the session has
   * synced, and it goes. A copy is never deleted on one session's say-so: a session that `replaced`
   * another retires it by the same path, once its editors have gone and its hold is released, so
   * words another tab wrote into the same copy meanwhile come back too.
   */
  private openCopy(
    roomKey: string,
    copyKey: string,
    replaced?: { session: DocumentSession; hold: Promise<CopyHold> | null | undefined },
  ): { session: DocumentSession; hold: Promise<CopyHold> } {
    const incarnation = this.copies.current(copyKey);
    // Named from the incarnation just read: another tab can advance the pointer in between.
    const name = incarnationName(copyKey, incarnation);
    const hold = this.copies.hold(name);
    const session = this.createSession(
      roomKey,
      { kind: "indexeddb", key: name },
      replaced?.session.getSnapshot().access ?? null,
    );
    this.copyOf.set(session, { key: copyKey, incarnation });
    // Each caller files the session under its room after this returns, where `history` finds it.
    queueMicrotask(() => {
      for (const observer of [...this.historyObservers]) observer();
    });
    if (replaced) {
      void this.teardownOwner
        .retireReplaced(replaced.session)
        .catch((error: unknown) => reportError(error))
        .then(async () => (await replaced.hold)?.release())
        .then(() => this.dropOlder(session, copyKey, incarnation))
        .catch(reportError);
    } else if (incarnation > 0) {
      void this.dropOlder(session, copyKey, incarnation).catch(reportError);
    }
    return { session, hold };
  }

  private async dropOlder(
    session: DocumentSession,
    copyKey: string,
    incarnation: number,
  ): Promise<void> {
    const older = await this.copies.openOlder(copyKey, incarnation);
    if (older.length === 0) return;
    // Until the first handshake the document is not the server's, and everything would look unsent.
    await session.whenSynced();
    const settled = session.getSnapshot().status !== "destroyed";
    const server = Y.encodeStateVector(session.document);
    await Promise.all(
      older.map(async ({ update, finish }) => {
        try {
          if (settled)
            await readBeyond(update, server, (document, lacking) =>
              this.dropWords(document, lacking),
            );
        } finally {
          await finish();
        }
      }),
    );
  }

  private createSession(
    roomKey: string,
    persistence: DocumentSessionOptions["persistence"],
    access: DocumentSessionAccess | null,
  ): DocumentSession {
    const session = this.constructSession(roomKey, persistence, access);
    return session;
  }

  private constructSession(
    roomKey: string,
    persistence: DocumentSessionOptions["persistence"],
    access: DocumentSessionAccess | null,
  ): DocumentSession {
    let session!: DocumentSession;
    session = new DocumentSession({
      roomKey,
      persistence,
      access,
      ownUserId: this.accountId,
      persistSchemaFence: (fence) => writeSchemaFenceQuarantine(session.documentId, fence),
    });
    const quarantine = readSchemaFenceQuarantine(roomKey);
    if (quarantine) session.raiseSchemaFence(quarantine);
    session.subscribe((snapshot) => {
      if (snapshot.holdsUndeliverableEdits)
        this.requestReplacement(session, updatesRefused(snapshot.connectionState));
    });
    if (session.room.kind === "live")
      session.subscribe(() => {
        this.settleDrainedRoom(session);
        this.settleRetainedTransport(session);
      });
    return session;
  }

  /** In a microtask, never inside the session's own `emit`. */
  private requestReplacement(session: DocumentSession, refused: boolean): void {
    if (this.replacing.has(session)) return;
    queueMicrotask(() => void this.replaceRoom(session, refused).catch(reportError));
  }

  private isRoomSession(session: DocumentSession): boolean {
    return this.liveRooms.get(session.documentId as DocumentId)?.session === session;
  }

  /**
   * A room the server admitted read-only holds none of the writer's edits the server lacks
   * (`.context/CONTEXT.md`, "Undeliverable edits"). A room found holding some drops the
   * typing and is replaced by a session on the next incarnation of its copy, which loads from the
   * server; the old one is inert until its editors have gone. Nothing is emptied and nothing is
   * said to other tabs: each tab replaces its own session at its own read admission.
   *
   * A room whose updates the server refused holds them with no handshake to ask: its copy's typing
   * beyond the mark is dropped and the copy advanced even when its owner retired the session first
   * (a draining room retires in the same emit), so no later open resends them.
   */
  private async replaceRoom(old: DocumentSession, refused: boolean): Promise<void> {
    if (this.replacing.has(old) || !(refused || this.isRoomSession(old))) return;
    this.replacing.add(old);
    // Words another tab stored that this one never received count too, and the verdict can end here.
    if (!refused && (!(await old.decideAgain()) || !this.isRoomSession(old))) {
      this.replacing.delete(old);
      return;
    }
    const copy = this.copyOfSession(old);
    const edits = old.undeliverableEdits();
    void old.makeInert().catch(reportError);
    // Typing into the old editor after this read goes to its copy, and the older-copy read's.
    if (edits) await readCopy(edits.copy, (document) => this.dropWords(document, edits.lacking));
    if (refused) await this.dropCopy(incarnationName(copy.key, copy.incarnation));
    await this.copies.advance(copy.key, copy.incarnation);
    if (!this.isRoomSession(old)) return;
    const state = this.liveRooms.get(old.documentId as DocumentId);
    if (!state) return;
    const { session, hold } = this.openCopy(old.roomKey, copy.key, {
      session: old,
      hold: state.hold,
    });
    state.session = session;
    state.hold = hold;
    this.attachSessionTransport(session);
    this.notifyReplacement(old.roomKey, session);
  }

  /** Calls `observer` with the session that replaces a document's room. */
  observeReplacement(roomKey: string, observer: (session: DocumentSession) => void): () => void {
    const observers = this.replacementObservers.get(roomKey) ?? new Set();
    observers.add(observer);
    this.replacementObservers.set(roomKey, observers);
    return () => {
      observers.delete(observer);
      if (observers.size === 0) this.replacementObservers.delete(roomKey);
    };
  }

  private notifyReplacement(roomKey: string, session: DocumentSession): void {
    for (const observer of [...(this.replacementObservers.get(roomKey) ?? [])]) observer(session);
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

  /** Calls `observer` each time unsent typing with words in it is dropped: its room can't take it. */
  observeDroppedTyping(observer: () => void): () => void {
    this.droppedTypingObservers.add(observer);
    return () => {
      this.droppedTypingObservers.delete(observer);
    };
  }

  private copyOfSession(session: DocumentSession): { key: string; incarnation: number } {
    const copy = this.copyOf.get(session);
    if (!copy) throw new Error(`Session has no local copy: ${session.roomKey}`);
    return copy;
  }

  private async dropCopy(name: string): Promise<void> {
    const beyond = await this.copies.beyondMark(name);
    if (beyond)
      await readCopy(beyond.update, (document) => this.dropWords(document, beyond.lacking));
  }

  /** Words in `lacking` are lost: tell the observers, who show one "Couldn't save". A change with no words (a deletion, a format change) is lost silently. */
  private dropWords(document: Y.Doc, lacking: Ranges): void {
    if (typedText(document, lacking) === null) return;
    for (const observer of this.droppedTypingObservers) observer();
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
    if (
      this.pendingTeardownTimers.has(roomKey) ||
      this.holdCapStops.has(roomKey) ||
      this.keptForUndo.has(roomKey)
    )
      return;
    const timer = setTimeout(() => {
      this.pendingTeardownTimers.delete(roomKey);
      const state = this.liveRooms.get(roomKey);
      if (!state?.session || this.isRetained(roomKey)) return;
      this.releaseUnheld(roomKey, state, state.session);
    }, this.teardownGraceMs);
    this.pendingTeardownTimers.set(roomKey, timer);
  }

  /**
   * A session no host holds. One with unsent edits stays until they are
   * acknowledged: `settleDrainedRoom` ends the hold when the room can no longer take them, and a
   * room that stays connected without acknowledging ends it at the cap; offline time never counts.
   * Then one whose room still takes writes and whose history has entries is kept for its undo,
   * wherever it was shown; a room that can't take them (ended, read-only) retires. The other exits
   * (removed document, revoked access, account close) go through `clearLocalCopy` and `invalidateAll`.
   */
  private releaseUnheld(roomKey: string, state: LiveRoomState, session: DocumentSession): void {
    if (this.mustKeepForUnsentEdits(session)) this.holdUntilAcknowledged(roomKey, state, session);
    else if (session.canDeliverUnsentEdits() && session.history.hasEntries())
      this.keepForUndo(roomKey, state, session);
    else this.retireLiveSession(roomKey, state);
  }

  /** Off the socket; a host that takes it back reattaches it, and an emptied history ends it. */
  private keepForUndo(roomKey: string, state: LiveRoomState, session: DocumentSession): void {
    const history = session.history;
    const kept = { changed: ++this.undoClock, stop: () => {} };
    kept.stop = history.subscribe(() => {
      if (history.hasEntries()) kept.changed = ++this.undoClock;
      else this.retireLiveSession(roomKey, state);
    });
    this.keptForUndo.set(roomKey, kept);
    this.detachUnwantedTransport(session);
    if (this.keptForUndo.size <= KEPT_FOR_UNDO_CAP) return;
    const [oldest] = [...this.keptForUndo].reduce((least, entry) =>
      entry[1].changed < least[1].changed ? entry : least,
    );
    const oldestState = this.liveRooms.get(oldest);
    if (oldestState) this.retireLiveSession(oldest, oldestState);
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
      .retire(roomKey, session)
      .then(async () => (await hold)?.release())
      .catch(() => undefined);
  }

  private settleDrainedRoom(session: DocumentSession): void {
    const roomKey = session.documentId;
    if (!this.holdCapStops.has(roomKey)) return;
    const state = this.liveRooms.get(roomKey);
    if (state?.session !== session) return;
    if (this.mustKeepForUnsentEdits(session)) return;
    this.cancelPendingTeardown(roomKey);
    this.releaseUnheld(roomKey, state, session);
  }

  // A restart cancels the pending teardown; a room no host retains still needs one.
  private scheduleTeardownIfUnretained(documentId: DocumentId): void {
    if (!this.isRetained(documentId)) this.scheduleTeardown(documentId);
  }

  private cancelPendingTeardown(roomKey: string): void {
    this.holdCapStops.get(roomKey)?.();
    this.holdCapStops.delete(roomKey);
    this.keptForUndo.get(roomKey)?.stop();
    this.keptForUndo.delete(roomKey);
    const timer = this.pendingTeardownTimers.get(roomKey);
    if (!timer) return;
    clearTimeout(timer);
    this.pendingTeardownTimers.delete(roomKey);
  }

  private isRetained(documentId: DocumentId): boolean {
    for (const retained of this.retainedByOwner.values()) if (retained.has(documentId)) return true;
    return false;
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
