import type { DraftId } from "@meridian/contracts";
import type { AccountId, DocumentRoom } from "@meridian/contracts/protocol";
import type { DocumentId, ProjectId } from "@meridian/contracts/runtime";
import { deferred } from "@/core/cross-context-locks";
import type { DocumentSessionOptions, DocumentSessionTransportFactory } from "./document-session";
import {
  DocumentSession,
  type DocumentSessionAccess,
  historyCutOff,
  sessionRoomKey,
} from "./document-session";
import type {
  DocumentSessionLease,
  PressRooms,
  RetainedLiveDocumentReference,
} from "./document-session-registry";
import { DocumentSessionTeardownOwner } from "./document-session-teardown-owner";
import {
  type CopyHold,
  documentSessionPersistenceKey,
  incarnationName,
  LocalDocumentCopies,
} from "./local-document-copies";
import { readSchemaFenceQuarantine, writeSchemaFenceQuarantine } from "./schema-fence";
import { storedOpsBeyondMark, storedWordsBeyond } from "./unsent-words";

const LIVE_DOC_SOFT_CAP = 50;
const SESSION_TEARDOWN_GRACE_MS = 3_000;
const KEPT_FOR_UNDO_CAP = 8;

type RoomState = {
  room: DocumentRoom;
  session: DocumentSession | null;
  hold: Promise<CopyHold> | null;
};

const UNSENT_EDITS_HOLD_MAX_MS = 10 * 60_000;

type RetainedLiveDocument = { lease: DocumentSessionLease; detached: boolean };

export class DocumentSessionRegistry {
  private closeAttempt: Promise<void> | null = null;
  private readonly copies: LocalDocumentCopies;
  private readonly teardownOwner = new DocumentSessionTeardownOwner(
    () => new Error("Live session teardown is unfinished"),
  );
  private readonly rooms = new Map<string, RoomState>();
  private readonly retainedByOwner = new Map<string, Map<string, RetainedLiveDocument>>();
  private readonly retainedObservers = new Set<
    (snapshot: readonly RetainedLiveDocumentReference[]) => void
  >();
  private readonly pendingTeardownTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly holdCapStops = new Map<string, () => void>();
  private readonly keptForUndo = new Map<string, { changed: number; stop: () => void }>();
  private undoClock = 0;
  private pressWaits = 0;
  private liveDocCapWarningEmitted = false;
  private readonly droppedTypingObservers = new Set<() => void>();
  private readonly copyOf = new WeakMap<DocumentSession, { key: string; incarnation: number }>();
  private readonly replacing = new WeakSet<DocumentSession>();
  private readonly replacementObservers = new Map<
    string,
    Set<(session: DocumentSession) => void>
  >();

  constructor(
    private readonly accountId: AccountId,
    private readonly accountClosing: AbortSignal,
    private readonly transportFactory: DocumentSessionTransportFactory,
  ) {
    this.copies = new LocalDocumentCopies(accountId);
  }

  admit(projectId: ProjectId, documentId: DocumentId, draftId?: DraftId): DocumentSessionLease {
    this.requireAccountOpen();
    if (draftId !== undefined) this.admit(projectId, documentId);
    const room: DocumentRoom =
      draftId === undefined ? { kind: "live", documentId } : { kind: "fork", draftId, documentId };
    const key = sessionRoomKey(room);
    this.teardownOwner.assertAvailable(key);
    const lease = Object.freeze({ accountId: this.accountId, projectId, documentId, room });
    if (!this.rooms.has(key)) this.rooms.set(key, { room, session: null, hold: null });
    return lease;
  }

  openSession(room: DocumentRoom): DocumentSession | null {
    return this.rooms.get(sessionRoomKey(room))?.session ?? null;
  }

  /** The rooms of one document: its forks first, then its Live room, the order they are torn down in. */
  private roomsOf(documentId: DocumentId): string[] {
    const keys = [...this.rooms.keys()].filter(
      (key) => this.rooms.get(key)?.room.documentId === documentId,
    );
    return keys.sort((a, b) => Number(a === documentId) - Number(b === documentId));
  }

  async clearLocalCopy(documentId: DocumentId): Promise<void> {
    this.requireAccountOpen();
    const keys = this.roomsOf(documentId);
    let retainedChanged = false;
    for (const key of keys) {
      this.cancelPendingTeardown(key);
      for (const retained of this.retainedByOwner.values())
        retainedChanged = retained.delete(key) || retainedChanged;
    }
    if (retainedChanged) this.publishRetainedLiveDocuments();
    // Forks first: each reads through the Live copy until it is freed.
    for (const key of keys) {
      const state = this.rooms.get(key);
      this.rooms.delete(key);
      if (state?.session) await this.teardownOwner.retire(key, state.session);
      await this.teardownOwner.drainRoom(key);
      (await state?.hold)?.release();
    }
    await this.copies.clear(documentId, () => this.dropWords());
  }

  async settleUnsentEdits(timeoutMs: number, { storedCopies = true } = {}): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    const stored = storedCopies ? await this.openStoredUnsent(deadline) : [];
    if (!stored || stored.some((room) => !this.openSession(room))) return false;
    const sessions = [...this.rooms.values()].flatMap(({ session }) => (session ? [session] : []));
    const outcome = (session: DocumentSession) => {
      if (session.getSnapshot().status === "destroyed") return !session.hasUnacknowledgedEdits();
      if (session.hasUnacknowledgedEdits() && session.canDeliverUnsentEdits()) return null;
      return true;
    };
    const settled = sessions.map(
      (session) =>
        new Promise<boolean>((resolve) => {
          const now = outcome(session);
          if (now !== null) return resolve(now);
          const timer = setTimeout(() => {
            stop();
            resolve(false);
          }, deadline - Date.now());
          const stop = session.subscribe(() => {
            const settledAs = outcome(session);
            if (settledAs === null) return;
            clearTimeout(timer);
            stop();
            resolve(settledAs);
          });
        }),
    );
    return (await Promise.all(settled)).every(Boolean);
  }

  private async openStoredUnsent(deadline: number): Promise<DocumentRoom[] | null> {
    const unsent: DocumentRoom[] = [];
    // One at a time: holding every copy's bytes at once costs their sum.
    for (const { name, room } of await this.copies.currentCopies())
      if (!this.openSession(room) && (await this.copies.holds(name, storedOpsBeyondMark)))
        unsent.push(room);
    const rooms = unsent.flatMap((room): DocumentRoom[] =>
      room.kind === "fork" ? [{ kind: "live", documentId: room.documentId }, room] : [room],
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const drained = await Promise.race([
      Promise.all(rooms.map((room) => this.teardownOwner.drainRoom(sessionRoomKey(room)))).then(
        () => true,
        (error: unknown) => {
          reportError(error);
          return false;
        },
      ),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), deadline - Date.now());
      }),
    ]);
    clearTimeout(timer);
    if (!drained || this.accountClosing.aborted) return null;
    for (const room of rooms) this.openToDeliver(room);
    return unsent;
  }

  private openToDeliver(room: DocumentRoom): void {
    const key = sessionRoomKey(room);
    const state = this.rooms.get(key) ?? { room, session: null, hold: null };
    if (state.session || this.teardownOwner.retiring(key)) return;
    if (room.kind === "fork" && !this.rooms.get(room.documentId)?.session) return;
    this.rooms.set(key, state);
    this.getOrCreateLiveSession(state, true);
    this.scheduleTeardownIfUnretained(key);
  }

  observeLocalCopies(observer: (documents: ReadonlySet<DocumentId>) => void): () => void {
    return this.copies.observe(observer);
  }

  get(lease: DocumentSessionLease): DocumentSession {
    this.requireAccountOpen();
    return this.getOrCreateLiveSession(this.requireLease(lease), true);
  }

  openRoomVersion(documentId: DocumentId): Uint8Array | null {
    return this.rooms.get(documentId)?.session?.roomVersion() ?? null;
  }

  async whenSentAcknowledged(
    projectId: ProjectId,
    { drafts, documents }: PressRooms,
  ): Promise<void> {
    this.requireAccountOpen();
    const copies = await this.copies.currentCopies();
    const forks = new Map<string, DocumentRoom>();
    for (const room of [
      ...[...this.rooms.values()].map(({ room }) => room),
      ...copies.map(({ room }) => room),
    ])
      if (
        room.kind === "fork" &&
        drafts.includes(room.draftId) &&
        (!documents || documents.includes(room.documentId))
      )
        forks.set(sessionRoomKey(room), room);
    const lives = new Set([...(documents ?? []), ...[...forks.values()].map((r) => r.documentId)]);
    const rooms: DocumentRoom[] = [
      ...forks.values(),
      ...[...lives].map((documentId): DocumentRoom => ({ kind: "live", documentId })),
    ];
    const leases = (
      await Promise.all(
        rooms.map(async (room) => {
          const key = sessionRoomKey(room);
          if (!this.rooms.get(key)?.session) {
            const copy = copies.find((each) => sessionRoomKey(each.room) === key);
            if (!copy || !(await this.copies.holds(copy.name, storedOpsBeyondMark))) return null;
          }
          return this.admit(
            projectId,
            room.documentId,
            room.kind === "fork" ? room.draftId : undefined,
          );
        }),
      )
    ).filter((lease) => lease !== null);
    if (leases.length === 0) return;
    const owner = `press:${++this.pressWaits}`;
    this.retain(owner, leases);
    try {
      await Promise.all(
        leases.map((lease) =>
          this.rooms.get(sessionRoomKey(lease.room))?.session?.whenSentAcknowledged(),
        ),
      );
    } finally {
      this.release(owner);
    }
  }

  async restartUnavailableRoom(lease: DocumentSessionLease): Promise<boolean> {
    this.requireAccountOpen();
    const state = this.requireLease(lease);
    const session = state.session;
    if (!session) return false;
    const snapshot = session.getSnapshot();
    if (snapshot.schemaFence || snapshot.status === "detached") return false;
    if (snapshot.status !== "access-lost" && snapshot.connectionState?.kind !== "terminal") {
      return false;
    }
    const key = sessionRoomKey(lease.room);
    this.cancelPendingTeardown(key);
    try {
      session.restartTransport(this.transportFactory);
    } finally {
      this.scheduleTeardownIfUnretained(key);
    }
    return true;
  }

  retain(
    ownerId: string,
    leases: Iterable<DocumentSessionLease>,
    options: { detachedDocumentIds?: Iterable<DocumentId> } = {},
  ): void {
    this.requireAccountOpen();
    const detached = new Set<string>(options.detachedDocumentIds);
    const retained = new Map<string, RetainedLiveDocument>();
    for (const lease of leases) {
      this.requireLease(lease);
      retained.set(sessionRoomKey(lease.room), {
        lease,
        detached: detached.has(lease.documentId),
      });
    }
    this.retainedByOwner.set(ownerId, retained);
    this.reconcileRetainedSessions();
    this.publishRetainedLiveDocuments();
  }

  setHosted(ownerId: string, hosted: boolean): void {
    this.requireAccountOpen();
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

  close(): Promise<void> {
    if (!this.accountClosing.aborted) throw new Error("Abort the account signal before closing");
    if (this.closeAttempt) return this.closeAttempt;
    const attempt = this.retireAll();
    this.closeAttempt = attempt;
    attempt.catch(() => {
      if (this.closeAttempt === attempt) this.closeAttempt = null;
    });
    return attempt;
  }

  private retireAll(): Promise<void> {
    this.clearRetainedLiveDocuments();
    this.liveDocCapWarningEmitted = false;
    for (const timer of this.pendingTeardownTimers.values()) clearTimeout(timer);
    this.pendingTeardownTimers.clear();
    for (const stop of this.holdCapStops.values()) stop();
    this.holdCapStops.clear();
    for (const kept of this.keptForUndo.values()) kept.stop();
    this.keptForUndo.clear();
    const open = [...this.rooms.entries()].flatMap(([key, { session, hold }]) =>
      session ? [{ key, session, hold }] : [],
    );
    this.rooms.clear();
    const retire = async ({ key, session, hold }: (typeof open)[number]) => {
      await this.teardownOwner.retire(key, session);
      (await hold)?.release();
    };
    // Forks first: each reads through its Live copy until it is freed.
    const forks = open.filter(({ session }) => session.room.kind === "fork");
    const retired = Promise.all(forks.map(retire)).then(() =>
      Promise.all(open.filter(({ session }) => session.room.kind === "live").map(retire)),
    );
    return Promise.all([retired, this.teardownOwner.drain()]).then(() => undefined);
  }

  private clearRetainedLiveDocuments(): void {
    const hadRetainedReferences = [...this.retainedByOwner.values()].some(
      (retained) => retained.size > 0,
    );
    this.retainedByOwner.clear();
    if (hadRetainedReferences) this.publishRetainedLiveDocuments();
  }

  private requireLease(lease: DocumentSessionLease): RoomState {
    if (lease.accountId !== this.accountId) throw new Error("Lease belongs to another account");
    const key = sessionRoomKey(lease.room);
    const state = this.rooms.get(key);
    if (!state) throw new Error(`Lease is stale for ${key}`);
    return state;
  }

  private getOrCreateLiveSession(state: RoomState, attach: boolean): DocumentSession {
    const key = sessionRoomKey(state.room);
    this.cancelPendingTeardown(key);
    this.teardownOwner.assertAvailable(key);
    if (state.session) {
      if (attach && state.session.getSnapshot().status === "detached") {
        this.attachSessionTransport(state.session);
      }
      return state.session;
    }
    const { session, hold } = this.openCopy(
      state.room,
      documentSessionPersistenceKey(this.accountId, state.room),
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
   * another retires it by the same path, once its editors have gone, `after` has settled and its
   * hold is released, so words another tab wrote into the same copy meanwhile come back too.
   */
  private openCopy(
    room: DocumentRoom,
    copyKey: string,
    replaced?: {
      session: DocumentSession;
      hold: Promise<CopyHold> | null | undefined;
      after?: Promise<unknown>;
    },
  ): { session: DocumentSession; hold: Promise<CopyHold>; retired: Promise<void> } {
    const incarnation = this.copies.current(copyKey);
    // Named from the incarnation just read: another tab can advance the pointer in between.
    const name = incarnationName(copyKey, incarnation);
    const hold = this.copies.hold(name);
    const session = this.createSession(
      room,
      { kind: "indexeddb", key: name },
      replaced?.session.getSnapshot().access ?? null,
    );
    this.copyOf.set(session, { key: copyKey, incarnation });
    let retired = Promise.resolve();
    if (replaced) {
      retired = Promise.resolve(replaced.after)
        .then(() => this.teardownOwner.retireReplaced(replaced.session))
        .catch((error: unknown) => reportError(error))
        .then(async () => (await replaced.hold)?.release());
      void retired.then(() => this.dropOlder(session, copyKey, incarnation)).catch(reportError);
    } else if (incarnation > 0) {
      void this.dropOlder(session, copyKey, incarnation).catch(reportError);
    }
    return { session, hold, retired };
  }

  private async dropOlder(
    session: DocumentSession,
    copyKey: string,
    incarnation: number,
  ): Promise<void> {
    const older = await this.copies.openOlder(copyKey, incarnation);
    if (older.length === 0) return;
    // Until the first Join the copy is not the server's, and everything would look unsent.
    await session.whenSynced();
    const settled = session.getSnapshot().status !== "destroyed" && !session.docs.isFreed;
    const server = settled ? session.docs.version() : null;
    await Promise.all(
      older.map(async ({ loaded, finish }) => {
        try {
          if (server && storedWordsBeyond(loaded, server)) this.dropWords();
        } finally {
          await finish();
        }
      }),
    );
  }

  private createSession(
    room: DocumentRoom,
    persistence: DocumentSessionOptions["persistence"],
    access: DocumentSessionAccess | null,
  ): DocumentSession {
    const live =
      room.kind === "fork" ? (this.rooms.get(room.documentId)?.session ?? undefined) : undefined;
    if (room.kind === "fork" && !live)
      throw new Error(`No Live session under ${sessionRoomKey(room)}`);
    const roomKey = sessionRoomKey(room);
    let session!: DocumentSession;
    session = new DocumentSession({
      room,
      live,
      persistence,
      access,
      persistSchemaFence: (fence) => writeSchemaFenceQuarantine(session.roomKey, fence),
    });
    const quarantine = readSchemaFenceQuarantine(roomKey);
    if (quarantine) session.raiseSchemaFence(quarantine);
    session.subscribe((snapshot) => {
      if (snapshot.holdsUndeliverableEdits)
        this.requestReplacement(session, historyCutOff(snapshot.connectionState));
    });
    session.subscribe((snapshot) => {
      this.settleDrainedRoom(session);
      this.settleRetainedTransport(session);
      if (snapshot.undeliveredTabWrites) queueMicrotask(() => this.deliverTabWrites(session));
    });
    return session;
  }

  /** In a microtask, never inside the session's own `emit`. */
  private requestReplacement(session: DocumentSession, refused: boolean): void {
    if (this.replacing.has(session)) return;
    queueMicrotask(() => void this.replaceRoom(session, refused).catch(reportError));
  }

  private isRoomSession(session: DocumentSession): boolean {
    return this.rooms.get(session.roomKey)?.session === session;
  }

  private async replaceRoom(old: DocumentSession, refused: boolean): Promise<void> {
    if (this.replacing.has(old) || !(refused || this.isRoomSession(old))) return;
    this.replacing.add(old);
    const copy = this.copyOfSession(old);
    const words = old.undeliverableWords();
    old.makeInert();
    if (words) this.dropWords();
    if (refused) await this.dropCopy(incarnationName(copy.key, copy.incarnation));
    await this.copies.advance(copy.key, copy.incarnation);
    if (!this.isRoomSession(old)) return;
    const state = this.rooms.get(old.roomKey);
    if (!state) return;
    // A fork reads through its Live session's docs: each fork over this room is rebuilt over the
    // new one, and the old Live session retires only after the old forks have.
    const forks = old.room.kind === "live" ? this.forkStatesOver(old.documentId) : [];
    const forksRetired = deferred<unknown>();
    this.installReplacement(
      state,
      this.openCopy(old.room, copy.key, {
        session: old,
        hold: state.hold,
        after: forksRetired.promise,
      }),
    );
    forksRetired.resolve(Promise.all(forks.map((fork) => this.rebuildFork(fork))));
  }

  private forkStatesOver(documentId: DocumentId): RoomState[] {
    return [...this.rooms.values()].filter(
      ({ session }) => session?.room.kind === "fork" && session.documentId === documentId,
    );
  }

  private rebuildFork(state: RoomState): Promise<void> {
    const old = state.session;
    if (!old) return Promise.resolve();
    this.replacing.add(old);
    old.makeInert();
    const opened = this.openCopy(old.room, this.copyOfSession(old).key, {
      session: old,
      hold: state.hold,
    });
    this.installReplacement(state, opened);
    return opened.retired;
  }

  private installReplacement(
    state: RoomState,
    { session, hold }: { session: DocumentSession; hold: Promise<CopyHold> },
  ): void {
    state.session = session;
    state.hold = hold;
    this.cancelPendingTeardown(session.roomKey);
    this.attachSessionTransport(session);
    this.notifyReplacement(session.roomKey, session);
    this.scheduleTeardownIfUnretained(session.roomKey);
  }

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

  // `release` stays unguarded: a view unmounting during the close still lets go of its hold.
  private requireAccountOpen(): void {
    if (this.accountClosing.aborted) throw new Error("Account is closing");
  }

  private attachSessionTransport(session: DocumentSession): void {
    if (session.getSnapshot().schemaFence) return;
    session.attachTransport(this.transportFactory);
  }

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
    if (await this.copies.holds(name, storedWordsBeyond)) this.dropWords();
  }

  private dropWords(): void {
    for (const observer of this.droppedTypingObservers) observer();
  }

  private retainedSnapshot(): readonly RetainedLiveDocumentReference[] {
    const references = new Map<string, RetainedLiveDocumentReference>();
    for (const retained of this.retainedByOwner.values()) {
      for (const { lease } of retained.values()) {
        if (lease.room.kind !== "live") continue;
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
    const keep = new Map<string, { state: RoomState; detached: boolean }>();
    const add = (state: RoomState, detached: boolean) => {
      const key = sessionRoomKey(state.room);
      keep.set(key, { state, detached: (keep.get(key)?.detached ?? true) && detached });
    };
    for (const retained of this.retainedByOwner.values())
      for (const { lease, detached } of retained.values()) {
        add(this.requireLease(lease), detached);
        const live = lease.room.kind === "fork" && this.rooms.get(lease.documentId);
        if (live) add(live, detached);
      }
    // Live rooms first: a fork's session is made over its Live room's.
    const ordered = [...keep.values()].sort(
      (a, b) => Number(a.state.room.kind === "fork") - Number(b.state.room.kind === "fork"),
    );
    for (const { state, detached } of ordered) {
      const session = this.getOrCreateLiveSession(state, !detached);
      if (detached) this.detachUnwantedTransport(session);
    }
    for (const [key, state] of this.rooms) {
      if (state.session && !keep.has(key) && !this.isRetained(key)) {
        this.scheduleTeardown(key);
      }
    }
  }

  private deliverTabWrites(session: DocumentSession): void {
    const key = session.roomKey;
    const state = this.rooms.get(key);
    if (state?.session !== session || this.accountClosing.aborted) return;
    if (session.getSnapshot().status !== "detached" || !this.mustKeepForUnsentEdits(session))
      return;
    this.cancelPendingTeardown(key);
    this.attachSessionTransport(session);
    if (!this.isRetained(key)) this.releaseUnheld(key, state, session);
  }

  private detachUnwantedTransport(session: DocumentSession): void {
    if (session.getSnapshot().status === "detached" || this.mustKeepForUnsentEdits(session)) return;
    session.detachTransport();
  }

  private settleRetainedTransport(session: DocumentSession): void {
    const key = session.roomKey;
    if (this.rooms.get(key)?.session !== session) return;
    let retained = false;
    for (const owners of this.retainedByOwner.values()) {
      const owner = owners.get(key);
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
      const state = this.rooms.get(roomKey);
      if (!state?.session || this.isRetained(roomKey)) return;
      this.releaseUnheld(roomKey, state, state.session);
    }, SESSION_TEARDOWN_GRACE_MS);
    this.pendingTeardownTimers.set(roomKey, timer);
  }

  private releaseUnheld(roomKey: string, state: RoomState, session: DocumentSession): void {
    if (this.mustKeepForUnsentEdits(session)) this.holdUntilAcknowledged(roomKey, state, session);
    else if (session.canDeliverUnsentEdits() && session.history.hasEntries())
      this.keepForUndo(roomKey, state, session);
    else this.retireLiveSession(roomKey, state);
  }

  private keepForUndo(roomKey: string, state: RoomState, session: DocumentSession): void {
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
    const oldestState = this.rooms.get(oldest);
    if (oldestState) this.retireLiveSession(oldest, oldestState);
  }

  private holdUntilAcknowledged(roomKey: string, state: RoomState, session: DocumentSession): void {
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

  private retireLiveSession(roomKey: string, state: RoomState): void {
    const session = state.session;
    if (!session) return;
    const hold = state.hold;
    state.session = null;
    state.hold = null;
    this.cancelPendingTeardown(roomKey);
    void this.teardownOwner
      .retire(roomKey, session)
      .then(async () => {
        (await hold)?.release();
        if (session.room.kind === "fork") this.scheduleTeardownIfUnretained(session.documentId);
      })
      .catch(() => undefined);
  }

  private settleDrainedRoom(session: DocumentSession): void {
    const roomKey = session.roomKey;
    if (!this.holdCapStops.has(roomKey)) return;
    const state = this.rooms.get(roomKey);
    if (state?.session !== session) return;
    if (this.mustKeepForUnsentEdits(session)) return;
    this.cancelPendingTeardown(roomKey);
    this.releaseUnheld(roomKey, state, session);
  }

  private scheduleTeardownIfUnretained(roomKey: string): void {
    if (this.rooms.get(roomKey)?.session && !this.isRetained(roomKey))
      this.scheduleTeardown(roomKey);
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

  private isRetained(roomKey: string): boolean {
    for (const retained of this.retainedByOwner.values()) if (retained.has(roomKey)) return true;
    for (const { session } of this.rooms.values())
      if (session?.room.kind === "fork" && session.documentId === roomKey) return true;
    return false;
  }

  private maybeWarnLiveDocCap(): void {
    const liveCount = [...this.rooms.values()].filter(({ session }) => session).length;
    if (this.liveDocCapWarningEmitted || liveCount <= LIVE_DOC_SOFT_CAP) return;
    this.liveDocCapWarningEmitted = true;
    console.warn(
      `[document-session-registry] live document session count (${liveCount}) exceeds soft cap (${LIVE_DOC_SOFT_CAP})`,
    );
  }
}
