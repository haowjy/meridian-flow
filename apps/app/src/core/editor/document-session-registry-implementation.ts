/**
 * Account-scoped owner of live document sessions and stable-id draft rooms.
 * Live acquisition is lease-required; draft rooms retain their stable room identity.
 */
import type { AccountId } from "@meridian/contracts/protocol";
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
} from "./document-session-registry";
import { DocumentSessionTeardownOwner } from "./document-session-teardown-owner";
import { DraftRoomPool, type DraftRoomRef } from "./draft-room-pool";
import { type Ranges, union } from "./item-ranges";
import {
  type CopyHold,
  documentSessionPersistenceKey,
  draftRoomPersistenceKey,
  incarnationName,
  LocalDocumentCopies,
} from "./local-document-copies";
import { type Offer, offer, readBeyond, readCopy } from "./rescued-text";
import { readSchemaFenceQuarantine, writeSchemaFenceQuarantine } from "./schema-fence";

const LIVE_DOC_SOFT_CAP = 50;
const SESSION_TEARDOWN_GRACE_MS = 3_000;

/**
 * The resets that end a room for good: its unsent typing is handed back when the session retires,
 * not at the reset. A session kept on screen still shows that text, and a restore that restarts it
 * delivers it, so handing it back earlier would offer text the document then gets too.
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
      const cause = UNSENT_CAUSE_OF_RESET[session.resetDisposition ?? "none"];
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
  private liveDocCapWarningEmitted = false;
  private readonly sessionObservers = new Map<
    string,
    Map<(snapshot: DocumentSessionSnapshot) => void, (() => void) | undefined>
  >();
  private readonly unsentTypingObservers = new Set<(typing: UnsentTyping) => void>();
  private readonly handedBack = new WeakSet<DocumentSession>();
  /**
   * The start's read of the notices not acted on (`offerUnacted`), begun before any session: it
   * locks the copies it reads, and the readers that would skip a locked copy wait for it.
   */
  private readonly unactedOffered: Promise<void>;
  /**
   * Notices shown here that the writer is not done with yet, by the copy they came from, as what
   * each offered. Reads here offer none of it again; until `done` records it in the copy, the
   * copy holds those words outside its acted-on sets, so it is kept.
   */
  private readonly pendingHandBacks = new Map<string, Set<Ranges>>();
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
    this.unactedOffered = this.offerUnacted().catch((error: unknown) => reportError(error));
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
    let recorded = true;
    if (state?.session) {
      // Read before the copy goes: its records say what the writer already took back.
      const handedBack = this.handBackUnsent(state.session, "removed");
      await this.teardownOwner.retire({ kind: "live", roomKey: documentId }, state.session);
      recorded = await handedBack.then(
        () => true,
        (error: unknown) => {
          reportError(error);
          return false;
        },
      );
    }
    await this.teardownOwner.drainRoom({ kind: "live", roomKey: documentId });
    (await state?.hold)?.release();
    // A notice whose offer the copy could not record has only the copy left to come back from.
    if (recorded) {
      // The start's read takes each copy it offers from: one cleared meanwhile would be skipped.
      await this.unactedOffered;
      await this.copies.clear(documentId);
    }
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

  closeDraftRoom(roomKey: string): Promise<void> {
    return this.draftRooms.close(roomKey);
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
    if (session) this.handedBack.add(session);
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
    // The start's read holds the copies it offers from, and its notices must be pending before this subtracts them.
    await this.unactedOffered;
    const older = await this.copies.openOlder(copyKey, incarnation);
    if (older.length === 0) return;
    // Until the first handshake the document is not the server's, and everything would look unsent.
    await session.whenSynced();
    const settled = session.getSnapshot().status !== "destroyed";
    const server = Y.encodeStateVector(session.document);
    const kept = new Set<string>();
    try {
      if (settled)
        for (const { name, update, handedBack } of older)
          readBeyond(update, server, (document, lacking) => {
            // Deletable only when nothing beyond the server has words outside the acted-on sets.
            const left = offer(document, lacking, handedBack);
            if (left.text === null) return;
            kept.add(name);
            const notice = offer(document, left.ranges, union(...this.pendingIn(name)));
            if (notice.text) void this.handBack("owner-closed", name, notice).catch(reportError);
          });
    } finally {
      await Promise.all(older.map((copy) => copy.finish(!settled || kept.has(copy.name))));
    }
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
        this.retireDrainedRoom(session);
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
    const handedBack = union(await this.copies.handedBack(name), ...this.pendingIn(name));
    if (!this.isRoomSession(old)) {
      this.replacing.delete(old);
      return;
    }
    const edits = old.undeliverableEdits(handedBack);
    // Wordless edits made by another tab or an earlier page are not told to this one.
    if (edits && (edits.text !== null || edits.own))
      void this.handBack("owner-closed", name, edits).catch(reportError);
    void old.makeInert().catch(reportError);
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

  observeUnsentTyping(observer: (typing: UnsentTyping) => void): () => void {
    this.unsentTypingObservers.add(observer);
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
   * The typing a retiring session never delivered, handed back like every notice: what is left
   * after the acted-on records and this tab's pending notices of its copy. Read synchronously,
   * because the session is destroyed next; the records are read after. Rejects when the copy
   * could not record the notice's offer.
   */
  private async handBackUnsent(session: DocumentSession, cause: UnsentTypingCause): Promise<void> {
    if (this.handedBack.has(session)) return;
    const unsent = session.unsentEdits();
    if (!unsent) return;
    this.handedBack.add(session);
    const copy = this.copyOfSession(session);
    const name = incarnationName(copy.key, copy.incarnation);
    const acted = await this.copies.handedBack(name).catch((error: unknown) => {
      // An unreadable record offers the words again rather than losing them.
      reportError(error);
      return new Map() as Ranges;
    });
    const notice = readCopy(unsent.copy, (document) =>
      offer(document, unsent.lacking, union(acted, ...this.pendingIn(name))),
    );
    if (notice.text !== null) await this.handBack(cause, name, notice);
  }

  /**
   * The notices shown before this start, in any tab, that the writer has not acted on: offered
   * again from the copies no tab holds, each under its own id, without opening its document. A
   * copy another tab holds is that tab's to offer from.
   */
  private async offerUnacted(): Promise<void> {
    for (const copy of await this.copies.openUnacted()) {
      let offered = false;
      // Items whose words are gone hold none again: nothing is left to offer from them.
      const wordless = new Map<string, Ranges>();
      try {
        readCopy(copy.update, (document) => {
          // Notices can overlap (two tabs showing the same words): each item is offered once.
          let covered = union(copy.handedBack, ...this.pendingIn(copy.name));
          for (const { id, cause, ranges } of copy.offered) {
            const notice = offer(document, ranges, covered);
            covered = union(covered, notice.ranges);
            if (notice.text !== null) {
              offered = true;
              // Under its own id: its record of the offer is already in the copy.
              this.show(cause, copy.name, notice, id);
            } else if (notice.ranges.size > 0) wordless.set(id, notice.ranges);
          }
        });
      } finally {
        await copy.finish(!copy.retired || offered, wordless);
      }
    }
  }

  /**
   * Shows `notice`, made from the copy `name` by `offer`. It is pending until the writer is done
   * with it, then recorded in the copy, so no later read offers its words again. A notice with
   * words records its offer in the copy too, so until then the copy is kept and every start
   * offers it again; the promise is that record. `text` is null for a change that has no words (a
   * deletion, a format change), which has nothing to lose.
   */
  private handBack(cause: UnsentTypingCause, name: string, notice: Offer): Promise<void> {
    const id = crypto.randomUUID();
    this.show(cause, name, notice, id);
    return notice.text === null
      ? Promise.resolve()
      : this.copies.recordOffered(name, id, cause, notice.ranges);
  }

  /** The notice `id` on screen, pending until the writer is done with it. */
  private show(cause: UnsentTypingCause, name: string, notice: Offer, id: string): void {
    const pending = this.pendingHandBacks.get(name) ?? new Set();
    pending.add(notice.ranges);
    this.pendingHandBacks.set(name, pending);
    let recorded = false;
    const done = () => {
      if (recorded) return;
      recorded = true;
      // Pending until written: a read here in between must not offer the words again.
      void this.copies
        .recordHandedBack(name, id, notice.ranges)
        .then(() => {
          pending.delete(notice.ranges);
          if (pending.size === 0 && this.pendingHandBacks.get(name) === pending)
            this.pendingHandBacks.delete(name);
        })
        .catch(reportError);
    };
    const typing = Object.freeze({ id, cause, text: notice.text, done });
    for (const observer of this.unsentTypingObservers) observer(typing);
  }

  private pendingIn(name: string): Ranges[] {
    return [...(this.pendingHandBacks.get(name) ?? [])];
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
      // The other exits (removed document, revoked access, account close) go
      // through `clearLocalCopy` and `invalidateAll`.
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
