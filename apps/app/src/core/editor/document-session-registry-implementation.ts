/**
 * Account-scoped owner of live document sessions and stable-id draft rooms.
 * Live acquisition is lease-required; draft rooms retain their stable room identity.
 */
import type { ClosedDraftCause } from "@meridian/contracts/branches";
import { type AccountId, parseYjsRoomName } from "@meridian/contracts/protocol";
import type { DocumentId, ProjectId } from "@meridian/contracts/runtime";
import * as Y from "yjs";
import { createHocuspocusDocumentTransport } from "@/core/transport/hocuspocus-document-transport";
import type { DocumentSessionOptions, DocumentSessionTransportFactory } from "./document-session";
import {
  DocumentSession,
  type DocumentSessionAccess,
  type DocumentSessionSnapshot,
  type ResetDisposition,
} from "./document-session";
import type {
  LiveDocumentSessionLease,
  RetainedLiveDocumentReference,
  UnsentTyping,
  UnsentTypingCause,
  UnsentTypingObserver,
} from "./document-session-registry";
import { DocumentSessionTeardownOwner } from "./document-session-teardown-owner";
import { type DraftCloseCause, DraftRoomPool, type DraftRoomRef } from "./draft-room-pool";
import type { DocumentHistory } from "./editor-history";
import {
  createHandBackNotices,
  type HandBackNotice,
  type HandBackNotices,
} from "./hand-back-notices";
import type { Ranges } from "./item-ranges";
import {
  type CopyHold,
  documentSessionPersistenceKey,
  draftRoomPersistenceKey,
  incarnationName,
  LocalDocumentCopies,
} from "./local-document-copies";
import { readBeyond, readCopy, typedText } from "./rescued-text";
import { readSchemaFenceQuarantine, writeSchemaFenceQuarantine } from "./schema-fence";

const LIVE_DOC_SOFT_CAP = 50;
const SESSION_TEARDOWN_GRACE_MS = 3_000;
/** Closed-draft copies the start sweep loads at once. */
const SWEEP_LOADS = 4;
/** Most sessions kept for their undo once no host holds them; the least recently edited goes first. */
const KEPT_FOR_UNDO_CAP = 8;

/**
 * The resets that end a room for good: its unsent typing is handed back when the session retires,
 * not at the reset. A session kept on screen still shows that text, and a restore that restarts it
 * delivers it, so handing it back earlier would offer text the document then gets too. Handing
 * back never deletes the copy: Undo Discard reopens a closed draft and replays the copy into it, so
 * the writer may see the notice and also get the words back; losing them is the failure.
 */
const UNSENT_CAUSE_OF_RESET: Readonly<
  Record<ResetDisposition | "none", UnsentTypingCause | undefined>
> = {
  closed: "closed",
  removed: "removed",
  schema: undefined,
  none: undefined,
};

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
    (session) => {
      // A draft the server closed hands back with that close's cause whatever ended the session's socket first.
      const cause =
        this.draftRooms.closedCause(session.roomKey) ??
        UNSENT_CAUSE_OF_RESET[session.resetDisposition ?? "none"];
      if (cause) void this.handBackUnsent(session, cause).catch(reportError);
    },
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
  /** Sessions no host holds, kept while their history has something to undo or redo. */
  private readonly keptForUndo = new Map<string, { edited: number; stop: () => void }>();
  private undoClock = 0;
  private liveDocCapWarningEmitted = false;
  private readonly sessionObservers = new Map<
    string,
    Map<(snapshot: DocumentSessionSnapshot) => void, (() => void) | undefined>
  >();
  private readonly unsentTypingObservers = new Set<UnsentTypingObserver>();
  /** Each retiring session's hand-back of its copy, once: a removal waits for it before the copy goes. */
  private readonly handingBack = new WeakMap<DocumentSession, Promise<void>>();
  /** Stops following the notice store; set when the first observer starts it. */
  private stopNotices: (() => void) | null = null;
  /**
   * The stored notices shown in this tab, each once for the life of the page: Dismiss removes
   * the toast before its `act` commits, and a read in between still finds it unacted.
   */
  private readonly shownNotices = new Set<string>();
  /** Shown here and not acted on here: a tab that acts elsewhere takes these off this screen. */
  private readonly showingNotices = new Set<string>();
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
    private readonly notices: HandBackNotices = createHandBackNotices(accountId),
  ) {
    this.copies = copies;
    this.draftRooms = new DraftRoomPool({
      open: (roomKey, documentId, replaced) => {
        const { session, hold } = this.openCopy(
          roomKey,
          draftRoomPersistenceKey(accountId, documentId as DocumentId, roomKey),
          replaced,
        );
        this.attachSessionTransport(session);
        return { session, hold };
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
      await this.handingBack.get(state.session);
    }
    await this.teardownOwner.drainRoom({ kind: "live", roomKey: documentId });
    (await state?.hold)?.release();
    await this.copies.clear(documentId, (name, { update, lacking }) =>
      readCopy(update, (document) => this.handBack("removed", name, document, lacking)),
    );
  }

  /**
   * Resolves true once no open session has unsent edits the server could still acknowledge, false
   * if some are still unsent at the deadline. What a session cannot deliver (offline, refused) is
   * not waited for.
   */
  async settleUnsentEdits(timeoutMs: number): Promise<boolean> {
    const sessions = [
      ...[...this.liveRooms.values()].flatMap(({ session }) => (session ? [session] : [])),
      ...this.draftRooms.sessions(),
    ];
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

  localText(documentId: DocumentId): Promise<string | null> {
    // A copy that can't be read is a tab without the typed words, not a failed bounce.
    return this.copies.text(documentId).catch((error: unknown) => {
      reportError(error);
      return null;
    });
  }

  /** Calls `observer` with the documents this browser holds a copy of for the account, and again as they change. */
  observeLocalCopies(observer: (documents: ReadonlySet<DocumentId>) => void): () => void {
    return this.copies.observe(observer);
  }

  get(lease: LiveDocumentSessionLease): DocumentSession {
    const state = this.requireLease(lease);
    return this.getOrCreateLiveSession(lease, state, true);
  }

  liveHistory(documentId: DocumentId): DocumentHistory | null {
    return this.liveRooms.get(documentId)?.session?.history ?? null;
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

  retainDraftRooms(ownerId: string, refs: readonly DraftRoomRef[]): void {
    this.draftRooms.retain(ownerId, refs);
  }

  releaseDraftRooms(ownerId: string): void {
    this.draftRooms.release(ownerId);
  }

  rebuildDraftRoom(roomKey: string): Promise<DocumentSession> {
    return this.draftRooms.rebuild(roomKey);
  }

  /**
   * The server closed the draft, as `closed` (a Discard) or `removed` (its document went). A
   * session the pool holds retires with that cause, which hands its copy back at the right time:
   * when nothing shows its text any more. With no session
   * (the room ended earlier, by a schema reset or a terminal close, or never opened here) the copy
   * is handed back now. The copy stays either way: Undo Discard reopens the same draft.
   */
  async closeDraftRoom(roomKey: string, cause: DraftCloseCause): Promise<void> {
    const documentId = this.draftRooms.documentOf(roomKey);
    const held = this.draftRooms.peek(roomKey);
    await this.draftRooms.close(roomKey, cause);
    if (documentId && !held) {
      const key = draftRoomPersistenceKey(this.accountId, documentId as DocumentId, roomKey);
      await this.handBackCopy(incarnationName(key, this.copies.current(key)), cause);
    }
  }

  /**
   * Hands back, as `closed`, what the copies of drafts the server has closed hold beyond their
   * mark. This covers a draft that closed while no page was open: no draft owner ran
   * `closeDraftRoom` for it. The copies stay (see `closeDraftRoom`) and go with the document's
   * purge. Each is swept once: it is then recorded as swept, and a later start skips it without
   * loading it until a session opens the copy again (a restore). A room open in this tab is left
   * to its own close, and a copy with no mark proves nothing undelivered. At most
   * `SWEEP_LOADS` copies load at once.
   */
  async handBackClosedDraftCopies(
    closedOf: (draftIds: string[]) => Promise<ReadonlyMap<string, ClosedDraftCause>>,
  ): Promise<void> {
    const copies = (await this.copies.unsweptDraftCopies()).flatMap(({ name, roomKey }) => {
      const room = parseYjsRoomName(roomKey);
      return room?.kind === "draft" && !this.draftRooms.peek(roomKey)
        ? [{ name, draftId: room.draftId }]
        : [];
    });
    if (copies.length === 0) return;
    const closed = await closedOf([...new Set(copies.map(({ draftId }) => draftId))]);
    const todo = copies.flatMap(({ name, draftId }) => {
      const why = closed.get(draftId);
      return why
        ? [{ name, cause: why === "discarded" ? ("closed" as const) : ("removed" as const) }]
        : [];
    });
    const sweepOne = async () => {
      for (let next = todo.shift(); next; next = todo.shift()) {
        try {
          await this.handBackCopy(next.name, next.cause, true);
          this.copies.markSwept(next.name);
        } catch (error) {
          reportError(error);
        }
      }
    };
    await Promise.all(Array.from({ length: SWEEP_LOADS }, sweepOne));
  }

  reopenDraftRoom(roomKey: string): void {
    // The same draft id is back: the session on screen joins it again, text and readers kept.
    void this.draftRooms
      .reopen(roomKey)
      ?.restartTransport(this.transportFactory)
      .catch(reportError);
  }

  abandonDraftRoom(roomKey: string): Promise<void> {
    const session = this.draftRooms.peek(roomKey);
    if (session) this.handingBack.set(session, Promise.resolve());
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
      this.stopNotices?.();
      this.notices.close();
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
    for (const kept of this.keptForUndo.values()) kept.stop();
    this.keptForUndo.clear();
    const liveSessions = [...this.liveRooms.entries()].flatMap(([documentId, { session, hold }]) =>
      session ? [{ documentId, session, hold }] : [],
    );
    this.liveRooms.clear();
    const retired = liveSessions.map(async ({ documentId, session, hold }) => {
      await this.teardownOwner.retire({ kind: "live", roomKey: documentId }, session);
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
    this.teardownOwner.assertAvailable({ kind: "live", roomKey: lease.documentId });
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
   * held that the server lacks and no session handed back yet are handed back once the session has
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
    if (replaced) {
      void this.teardownOwner
        .retireReplaced(replaced.session.room.kind === "live" ? "live" : "draft", replaced.session)
        .catch((error: unknown) => reportError(error))
        .then(async () => (await replaced.hold)?.release())
        .then(() => this.handBackOlder(session, copyKey, incarnation))
        .catch(reportError);
    } else if (incarnation > 0) {
      void this.handBackOlder(session, copyKey, incarnation).catch(reportError);
    }
    return { session, hold };
  }

  private async handBackOlder(
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
      older.map(async ({ name, update, finish }) => {
        let claimed = false;
        try {
          claimed =
            settled &&
            (await readBeyond(update, server, (document, lacking) =>
              this.handBack("owner-closed", name, document, lacking),
            ));
        } finally {
          // A copy whose words the notice store could not take is read again at the next open.
          await finish(!claimed);
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
    this.publishSession(roomKey, session);
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
      if (snapshot.holdsUndeliverableEdits) this.requestReplacement(session);
    });
    if (session.room.kind === "live")
      session.subscribe(() => {
        this.settleDrainedRoom(session);
        this.settleRetainedTransport(session);
      });
    return session;
  }

  /** In a microtask, never inside the session's own `emit`. */
  private requestReplacement(session: DocumentSession): void {
    if (this.replacing.has(session)) return;
    queueMicrotask(() => void this.replaceRoom(session).catch(reportError));
  }

  private isRoomSession(session: DocumentSession): boolean {
    return session.room.kind === "live"
      ? this.liveRooms.get(session.documentId as DocumentId)?.session === session
      : this.draftRooms.peek(session.roomKey) === session;
  }

  /**
   * A room the server admitted read-only holds none of the writer's edits the server lacks
   * (`.context/CONTEXT.md`, "Undeliverable edits"). A room found holding some hands back the
   * typing and is replaced by a session on the next incarnation of its copy, which loads from the
   * server; the old one is inert until its editors have gone. Nothing is emptied and nothing is
   * said to other tabs: each tab replaces its own session at its own read admission.
   */
  private async replaceRoom(old: DocumentSession): Promise<void> {
    if (this.replacing.has(old) || !this.isRoomSession(old)) return;
    this.replacing.add(old);
    // Words another tab stored that this one never received count too, and the verdict can end here.
    if (!(await old.decideAgain()) || !this.isRoomSession(old)) {
      this.replacing.delete(old);
      return;
    }
    const copy = this.copyOfSession(old);
    const name = incarnationName(copy.key, copy.incarnation);
    const edits = old.undeliverableEdits();
    void old.makeInert().catch(reportError);
    // Typing into the old editor after this read goes to its copy, and the older-copy read's.
    if (edits)
      await readCopy(edits.copy, (document) =>
        this.handBack("owner-closed", name, document, edits.lacking, edits.own),
      );
    await this.copies.advance(copy.key, copy.incarnation);
    if (!this.isRoomSession(old)) return;
    if (old.room.kind === "live") {
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
    } else {
      const session = this.draftRooms.replace(old.roomKey, old);
      if (session) this.notifyReplacement(old.roomKey, session);
    }
  }

  /** Calls `observer` with the session that replaces a room's, live (by document id) or draft. */
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

  observeUnsentTyping(observer: UnsentTypingObserver): () => void {
    this.unsentTypingObservers.add(observer);
    // The account's start: what any tab stored and no tab acted on, wherever its document is.
    if (!this.stopNotices) {
      const report = (error: unknown) => reportError(error);
      this.stopNotices = this.notices.subscribe(() => void this.showUnacted().catch(report));
      void this.showUnacted().catch(report);
    }
    return () => {
      this.unsentTypingObservers.delete(observer);
    };
  }

  private copyOfSession(session: DocumentSession): { key: string; incarnation: number } {
    const copy = this.copyOf.get(session);
    if (!copy) throw new Error(`Session has no local copy: ${session.roomKey}`);
    return copy;
  }

  /**
   * What a retiring session's copy holds beyond its mark, handed back like every notice. Read
   * from the copy, which has every write of the session's by now: a claim the store can't take is
   * claimed again from it, by the removal that deletes it or by a later start.
   */
  private handBackUnsent(session: DocumentSession, cause: UnsentTypingCause): Promise<void> {
    const started = this.handingBack.get(session);
    if (started) return started;
    const copy = this.copyOfSession(session);
    const handing = this.handBackCopy(incarnationName(copy.key, copy.incarnation), cause);
    this.handingBack.set(session, handing);
    return handing;
  }

  private async handBackCopy(
    name: string,
    cause: UnsentTypingCause,
    requireMark = false,
  ): Promise<void> {
    const beyond = await this.copies.beyondMark(name, requireMark);
    if (beyond)
      await readCopy(beyond.update, (document) =>
        this.handBack(cause, name, document, beyond.lacking),
      );
  }

  /**
   * Hands back the words of `lacking` in `document`, from the copy `name`: the notice store takes
   * what no notice from that copy holds yet, and this tab shows it (another tab that holds the
   * same words shows the same notice). Never rejects. False when the store could not take them:
   * the words are shown all the same, unstored, and the caller keeps the copy if it can. `own`: a
   * change of this session's with no words (a deletion, a format change) is told too, unstored.
   */
  private async handBack(
    cause: UnsentTypingCause,
    name: string,
    document: Y.Doc,
    lacking: Ranges,
    own = false,
  ): Promise<boolean> {
    const text = typedText(document, lacking);
    if (text === null) {
      if (own)
        this.emit({ id: crypto.randomUUID(), cause, text: null, done: () => Promise.resolve() });
      return true;
    }
    try {
      const notice = await this.notices.claim(name, cause, lacking, (ranges) =>
        typedText(document, ranges),
      );
      if (notice) this.showStored(notice);
      return true;
    } catch (error) {
      reportError(error);
      this.emit({ id: crypto.randomUUID(), cause, text, done: () => Promise.resolve() });
      return false;
    }
  }

  /** Shows what the store holds unacted that this tab has not shown, and withdraws what another tab acted on. */
  private async showUnacted(): Promise<void> {
    const showing = new Set(this.showingNotices);
    const unacted = await this.notices.unacted();
    const left = new Set(unacted.map(({ id }) => id));
    for (const id of showing)
      if (!left.has(id) && this.showingNotices.delete(id))
        for (const observer of this.unsentTypingObservers) observer.withdraw(id);
    for (const notice of unacted) this.showStored(notice);
  }

  private showStored({ id, cause, text }: HandBackNotice): void {
    if (this.shownNotices.has(id)) return;
    this.shownNotices.add(id);
    this.showingNotices.add(id);
    let acting: Promise<void> | null = null;
    const done = () => {
      acting ??= this.notices.act(id).then(
        () => void this.showingNotices.delete(id),
        (error: unknown) => {
          acting = null;
          reportError(error);
          throw error;
        },
      );
      return acting;
    };
    this.emit({ id, cause, text, done });
  }

  private emit(typing: UnsentTyping): void {
    const frozen = Object.freeze(typing);
    for (const observer of this.unsentTypingObservers) observer.show(frozen);
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
   * A session no host holds. Like draft rooms, one with unsent edits stays until they are
   * acknowledged: `settleDrainedRoom` ends the hold when the room can no longer take them, and a
   * room that stays connected without acknowledging ends it at the cap; offline time never counts.
   * Then one whose history has entries is kept for its undo, wherever it was shown. The other exits
   * (removed document, revoked access, account close) go through `clearLocalCopy` and `invalidateAll`.
   */
  private releaseUnheld(roomKey: string, state: LiveRoomState, session: DocumentSession): void {
    if (this.mustKeepForUnsentEdits(session)) this.holdUntilAcknowledged(roomKey, state, session);
    else if (session.history.hasEntries()) this.keepForUndo(roomKey, state, session);
    else this.retireLiveSession(roomKey, state);
  }

  /** Off the socket; a host that takes it back reattaches it, and an emptied history ends it. */
  private keepForUndo(roomKey: string, state: LiveRoomState, session: DocumentSession): void {
    const history = session.history;
    const kept = { edited: ++this.undoClock, stop: () => {} };
    kept.stop = history.subscribe(() => {
      if (history.hasEntries()) kept.edited = ++this.undoClock;
      else this.retireLiveSession(roomKey, state);
    });
    this.keptForUndo.set(roomKey, kept);
    this.detachUnwantedTransport(session);
    if (this.keptForUndo.size <= KEPT_FOR_UNDO_CAP) return;
    const [oldest] = [...this.keptForUndo].reduce((least, entry) =>
      entry[1].edited < least[1].edited ? entry : least,
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
      .retire({ kind: "live", roomKey }, session)
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
