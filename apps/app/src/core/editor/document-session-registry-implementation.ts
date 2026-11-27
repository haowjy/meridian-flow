import type { DraftId } from "@meridian/contracts";
import type { AccountId, DocumentRoom } from "@meridian/contracts/protocol";
import type { DocumentId, ProjectId } from "@meridian/contracts/runtime";
import {
  DocumentSession,
  type DocumentSessionAccess,
  type DocumentSessionTransportFactory,
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
const UNSENT_EDITS_HOLD_MAX_MS = 10 * 60_000;

type Phase =
  | { kind: "open" }
  | { kind: "grace"; stop: () => void }
  | { kind: "holding"; stop: () => void }
  | { kind: "kept"; changed: number; stop: () => void };

const OPEN: Phase = { kind: "open" };

type Slot = {
  session: DocumentSession;
  copy: { key: string; incarnation: number; hold: Promise<CopyHold> };
  phase: Phase;
};

type Room = { room: DocumentRoom; slot: Slot | null };

type DocumentEntry = { live: Room; forks: Map<DraftId, Room> };

export class DocumentSessionRegistry {
  private closeAttempt: Promise<void> | null = null;
  private readonly copies: LocalDocumentCopies;
  private readonly teardownOwner = new DocumentSessionTeardownOwner(
    () => new Error("Live session teardown is unfinished"),
  );
  private readonly documents = new Map<DocumentId, DocumentEntry>();
  private readonly retainedByOwner = new Map<string, Map<string, DocumentSessionLease>>();
  private readonly retainedObservers = new Set<
    (snapshot: readonly RetainedLiveDocumentReference[]) => void
  >();
  private undoClock = 0;
  private pressWaits = 0;
  private liveDocCapWarningEmitted = false;
  private readonly droppedTypingObservers = new Set<() => void>();
  private readonly replacementObservers = new Map<
    string,
    Set<(session: DocumentSession) => void>
  >();

  constructor(
    private readonly accountId: AccountId,
    private readonly accountClosing: AbortSignal,
    private readonly transportFactory: DocumentSessionTransportFactory,
    private readonly signedIn: () => boolean,
  ) {
    this.copies = new LocalDocumentCopies(accountId);
    accountClosing.addEventListener("abort", () => void this.close().catch(() => undefined), {
      once: true,
    });
  }

  admit(projectId: ProjectId, documentId: DocumentId, draftId?: DraftId): DocumentSessionLease {
    this.requireAccountOpen();
    if (draftId !== undefined) this.admit(projectId, documentId);
    const room: DocumentRoom =
      draftId === undefined ? { kind: "live", documentId } : { kind: "fork", draftId, documentId };
    this.teardownOwner.assertAvailable(sessionRoomKey(room));
    this.roomFor(room);
    return Object.freeze({ accountId: this.accountId, projectId, documentId, room });
  }

  openSession(room: DocumentRoom): DocumentSession | null {
    return this.find(room)?.slot?.session ?? null;
  }

  async clearLocalCopy(documentId: DocumentId): Promise<void> {
    this.requireAccountOpen();
    const document = this.documents.get(documentId);
    if (document) {
      let retainedChanged = false;
      for (const room of roomsOf(document)) {
        const key = sessionRoomKey(room.room);
        for (const retained of this.retainedByOwner.values())
          retainedChanged = retained.delete(key) || retainedChanged;
      }
      if (retainedChanged) this.publishRetainedLiveDocuments();
      await this.retireDocument(document);
    }
    await this.copies.clear(documentId, () => this.dropWords());
  }

  async settleUnsentEdits(timeoutMs: number, { storedCopies = true } = {}): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    const seen = new Set<DocumentSession>();
    let scanDue = storedCopies;
    let waited = false;
    for (;;) {
      if (scanDue) {
        const stored = await this.openStoredUnsent(deadline);
        if (!stored || stored.some((room) => !this.openSession(room))) return false;
        scanDue = false;
      }
      if (this.accountClosing.aborted) return false;
      const open = new Set(this.slots().map(({ session }) => session));
      for (const session of seen)
        if (!open.has(session) && !session.replaced && session.hasUnsavedEdits()) return false;
      const pending = [...open].filter(
        (session) => session.hasUnsavedEdits() && session.canDeliverUnsentEdits(),
      );
      if (pending.length === 0) {
        if (storedCopies && waited) {
          waited = false;
          scanDue = true;
          continue;
        }
        return true;
      }
      if (Date.now() >= deadline) return false;
      for (const session of pending) seen.add(session);
      await nextEmit(pending, deadline);
      waited = true;
    }
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
      Promise.all(rooms.map((room) => this.teardownOwner.drain(sessionRoomKey(room)))).then(
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
    if (this.openSession(room) || this.teardownOwner.retiring(sessionRoomKey(room))) return;
    if (room.kind === "fork" && !this.openSession({ kind: "live", documentId: room.documentId }))
      return;
    const target = this.roomFor(room);
    this.open(target);
    this.scheduleTeardownIfUnretained(target);
  }

  observeLocalCopies(observer: (documents: ReadonlySet<DocumentId>) => void): () => void {
    return this.copies.observe(observer);
  }

  get(lease: DocumentSessionLease): DocumentSession {
    return this.open(this.requireLease(lease));
  }

  openRoomVersion(documentId: DocumentId): Uint8Array | null {
    return this.openSession({ kind: "live", documentId })?.roomVersion() ?? null;
  }

  async whenSentAcknowledged(
    projectId: ProjectId,
    { drafts, documents }: PressRooms,
  ): Promise<void> {
    this.requireAccountOpen();
    const copies = await this.copies.currentCopies();
    const forks = new Map<string, DocumentRoom>();
    for (const room of [...this.rooms().map(({ room }) => room), ...copies.map(({ room }) => room)])
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
          if (!this.openSession(room)) {
            const key = sessionRoomKey(room);
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
        leases.map((lease) => this.openSession(lease.room)?.whenSentAcknowledged()),
      );
    } finally {
      this.release(owner);
    }
  }

  async restartUnavailableRoom(lease: DocumentSessionLease): Promise<boolean> {
    const room = this.requireLease(lease);
    const slot = room.slot;
    if (!slot) return false;
    const snapshot = slot.session.getSnapshot();
    if (snapshot.schemaFence || snapshot.status === "detached") return false;
    if (snapshot.status !== "access-lost" && snapshot.connectionState?.kind !== "terminal") {
      return false;
    }
    this.enter(slot, OPEN);
    try {
      slot.session.restartTransport(this.transportFactory);
    } finally {
      this.scheduleTeardownIfUnretained(room);
    }
    return true;
  }

  retain(ownerId: string, leases: Iterable<DocumentSessionLease>): void {
    const retained = new Map<string, DocumentSessionLease>();
    for (const lease of leases) {
      this.requireLease(lease);
      retained.set(sessionRoomKey(lease.room), lease);
    }
    this.retainedByOwner.set(ownerId, retained);
    this.reconcileRetainedSessions();
    this.publishRetainedLiveDocuments();
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
    const hadRetainedReferences = [...this.retainedByOwner.values()].some(
      (retained) => retained.size > 0,
    );
    this.retainedByOwner.clear();
    if (hadRetainedReferences) this.publishRetainedLiveDocuments();
    this.liveDocCapWarningEmitted = false;
    const documents = [...this.documents.values()];
    this.documents.clear();
    return Promise.all([
      ...documents.map((document) => this.retireDocument(document)),
      this.teardownOwner.drain(),
    ]).then(() => undefined);
  }

  /** Forks first: each reads through its Live session's docs until they are freed. */
  private async retireDocument(document: DocumentEntry): Promise<void> {
    for (const room of roomsOf(document)) if (room.slot) this.enter(room.slot, OPEN);
    const forks = [...document.forks.values()];
    document.forks.clear();
    await Promise.all(forks.map((fork) => this.retireRoom(fork)));
    const documentId = document.live.room.documentId;
    if (this.documents.get(documentId) === document) this.documents.delete(documentId);
    await this.retireRoom(document.live);
  }

  private async retireRoom(room: Room): Promise<void> {
    const key = sessionRoomKey(room.room);
    const slot = room.slot;
    room.slot = null;
    if (slot) await this.teardownOwner.retire(key, slot.session);
    await this.teardownOwner.drain(key);
    (await slot?.copy.hold)?.release();
  }

  private requireLease(lease: DocumentSessionLease): Room {
    if (lease.accountId !== this.accountId) throw new Error("Lease belongs to another account");
    const room = this.find(lease.room);
    if (!room) throw new Error(`Lease is stale for ${sessionRoomKey(lease.room)}`);
    return room;
  }

  private find(room: DocumentRoom): Room | undefined {
    const document = this.documents.get(room.documentId);
    return room.kind === "live" ? document?.live : document?.forks.get(room.draftId);
  }

  private roomFor(room: DocumentRoom): Room {
    let document = this.documents.get(room.documentId);
    if (!document) {
      document = {
        live: { room: { kind: "live", documentId: room.documentId }, slot: null },
        forks: new Map(),
      };
      this.documents.set(room.documentId, document);
    }
    if (room.kind === "live") return document.live;
    let fork = document.forks.get(room.draftId);
    if (!fork) {
      fork = { room, slot: null };
      document.forks.set(room.draftId, fork);
    }
    return fork;
  }

  private rooms(): Room[] {
    return [...this.documents.values()].flatMap(roomsOf);
  }

  private slots(): Slot[] {
    return this.rooms().flatMap(({ slot }) => (slot ? [slot] : []));
  }

  private roomOf(session: DocumentSession): Room | null {
    const room = this.find(session.room);
    return room?.slot?.session === session ? room : null;
  }

  private open(room: Room): DocumentSession {
    if (room.slot) this.enter(room.slot, OPEN);
    this.teardownOwner.assertAvailable(sessionRoomKey(room.room));
    if (room.slot) {
      const { session } = room.slot;
      if (session.getSnapshot().status === "detached") this.attachSessionTransport(session);
      return session;
    }
    const slot = this.openCopy(
      room.room,
      documentSessionPersistenceKey(this.accountId, room.room),
      null,
    );
    if (slot.copy.incarnation > 0) void this.dropOlder(slot).catch(reportError);
    room.slot = slot;
    this.attachSessionTransport(slot.session);
    this.maybeWarnLiveDocCap();
    return slot.session;
  }

  private openCopy(
    room: DocumentRoom,
    copyKey: string,
    access: DocumentSessionAccess | null,
  ): Slot {
    const live =
      room.kind === "fork"
        ? (this.openSession({ kind: "live", documentId: room.documentId }) ?? undefined)
        : undefined;
    const incarnation = this.copies.current(copyKey);
    // Named from the incarnation just read: another tab can advance the pointer in between.
    const name = incarnationName(copyKey, incarnation);
    const held = this.copies.hold(name).then(
      (hold) => ({ hold, granted: this.signedIn() }),
      (error: unknown) => {
        reportError(error);
        return { hold: { release: () => undefined }, granted: false };
      },
    );
    const copy = { key: copyKey, incarnation, hold: held.then(({ hold }) => hold) };
    let session!: DocumentSession;
    session = new DocumentSession({
      room,
      live,
      persistence: {
        kind: "indexeddb",
        key: name,
        granted: held.then(({ granted }) => granted),
      },
      access,
      persistSchemaFence: (fence) => writeSchemaFenceQuarantine(session.roomKey, fence),
      onUndeliveredTabWrites: () => this.deliverTabWrites(session),
    });
    const quarantine = readSchemaFenceQuarantine(session.roomKey);
    if (quarantine) session.raiseSchemaFence(quarantine);
    session.subscribe((snapshot) => {
      if (snapshot.holdsUndeliverableEdits)
        this.requestReplacement(session, copy, historyCutOff(snapshot.connectionState));
    });
    session.subscribe(() => this.settleDrainedRoom(session));
    return { session, copy, phase: OPEN };
  }

  private async dropOlder({ session, copy }: Slot): Promise<void> {
    const older = await this.copies.openOlder(copy.key, copy.incarnation);
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

  /** In a microtask, never inside the session's own `emit`. */
  private requestReplacement(session: DocumentSession, copy: Slot["copy"], refused: boolean): void {
    if (session.replaced) return;
    queueMicrotask(() => void this.replaceRoom(session, copy, refused).catch(reportError));
  }

  private async replaceRoom(
    old: DocumentSession,
    copy: Slot["copy"],
    refused: boolean,
  ): Promise<void> {
    if (old.replaced || !(refused || this.roomOf(old))) return;
    const words = old.undeliverableWords();
    old.makeInert();
    if (words) this.dropWords();
    if (refused) await this.dropCopy(incarnationName(copy.key, copy.incarnation));
    await this.copies.advance(copy.key, copy.incarnation);
    const room = this.roomOf(old);
    if (!room?.slot) return;
    const replaced = room.slot;
    const next = this.install(room, this.openCopy(old.room, copy.key, old.getSnapshot().access));
    // Each fork is rebuilt over the new Live session, then the old Live session retires after them.
    const forks =
      old.room.kind === "live"
        ? [...(this.documents.get(old.room.documentId)?.forks.values() ?? [])]
        : [];
    this.retireReplaced(replaced, next, Promise.all(forks.map((fork) => this.rebuildFork(fork))));
  }

  private rebuildFork(fork: Room): Promise<void> {
    const old = fork.slot;
    if (!old) return Promise.resolve();
    old.session.makeInert();
    const next = this.install(
      fork,
      this.openCopy(old.session.room, old.copy.key, old.session.getSnapshot().access),
    );
    return this.retireReplaced(old, next);
  }

  private install(room: Room, slot: Slot): Slot {
    if (room.slot) this.enter(room.slot, OPEN);
    room.slot = slot;
    this.attachSessionTransport(slot.session);
    this.notifyReplacement(slot.session.roomKey, slot.session);
    this.scheduleTeardownIfUnretained(room);
    return slot;
  }

  /**
   * A copy is never deleted on one session's say-so: the replaced session retires once its editors
   * have gone, `after` has settled and its hold is released, and only then does the next session
   * read the older incarnations, so words another tab wrote into the same copy meanwhile come back
   * too.
   */
  private retireReplaced(replaced: Slot, next: Slot, after?: Promise<unknown>): Promise<void> {
    const retired = Promise.resolve(after)
      .then(() => this.teardownOwner.retireReplaced(replaced.session))
      .catch((error: unknown) => reportError(error))
      .then(async () => (await replaced.copy.hold).release());
    void retired.then(() => this.dropOlder(next)).catch(reportError);
    return retired;
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

  private async dropCopy(name: string): Promise<void> {
    if (await this.copies.holds(name, storedWordsBeyond)) this.dropWords();
  }

  private dropWords(): void {
    for (const observer of this.droppedTypingObservers) observer();
  }

  private retainedSnapshot(): readonly RetainedLiveDocumentReference[] {
    const references = new Map<string, RetainedLiveDocumentReference>();
    for (const retained of this.retainedByOwner.values()) {
      for (const lease of retained.values()) {
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
    const wanted = new Set<Room>();
    for (const retained of this.retainedByOwner.values())
      for (const lease of retained.values()) {
        const room = this.requireLease(lease);
        if (lease.room.kind === "fork") {
          const live = this.find({ kind: "live", documentId: lease.documentId });
          if (live) wanted.add(live);
        }
        wanted.add(room);
      }
    for (const room of wanted) this.open(room);
    for (const room of this.rooms())
      if (room.slot && !wanted.has(room) && !this.isRetained(room)) this.scheduleTeardown(room);
  }

  private deliverTabWrites(session: DocumentSession): void {
    const room = this.roomOf(session);
    if (!room?.slot) return;
    if (session.getSnapshot().status !== "detached" || !this.mustKeepForUnsentEdits(session))
      return;
    this.enter(room.slot, OPEN);
    this.attachSessionTransport(session);
    if (!this.isRetained(room)) this.releaseUnheld(room, room.slot);
  }

  private detachUnwantedTransport(session: DocumentSession): void {
    if (session.getSnapshot().status === "detached" || this.mustKeepForUnsentEdits(session)) return;
    session.detachTransport();
  }

  private enter(slot: Slot, phase: Phase): void {
    if (slot.phase.kind !== "open") slot.phase.stop();
    slot.phase = phase;
  }

  private scheduleTeardown(room: Room): void {
    const slot = room.slot;
    if (slot?.phase.kind !== "open") return;
    const timer = setTimeout(() => {
      slot.phase = OPEN;
      if (!this.isRetained(room)) this.releaseUnheld(room, slot);
    }, SESSION_TEARDOWN_GRACE_MS);
    slot.phase = { kind: "grace", stop: () => clearTimeout(timer) };
  }

  private releaseUnheld(room: Room, slot: Slot): void {
    const { session } = slot;
    if (this.mustKeepForUnsentEdits(session)) this.holdUntilSaved(room, slot);
    else if (session.canDeliverUnsentEdits() && session.history.hasEntries())
      this.keepForUndo(room, slot);
    else this.retire(room);
  }

  private keepForUndo(room: Room, slot: Slot): void {
    const history = slot.session.history;
    const kept = { kind: "kept" as const, changed: ++this.undoClock, stop: () => {} };
    kept.stop = history.subscribe(() => {
      if (history.hasEntries()) kept.changed = ++this.undoClock;
      else this.retire(room);
    });
    this.enter(slot, kept);
    this.detachUnwantedTransport(slot.session);
    const keptRooms = this.rooms().flatMap((each) =>
      each.slot?.phase.kind === "kept" ? [{ room: each, changed: each.slot.phase.changed }] : [],
    );
    if (keptRooms.length <= KEPT_FOR_UNDO_CAP) return;
    const oldest = keptRooms.reduce((least, each) => (each.changed < least.changed ? each : least));
    this.retire(oldest.room);
  }

  private holdUntilSaved(room: Room, slot: Slot): void {
    let capTimer: ReturnType<typeof setTimeout> | undefined;
    const stopClock = () => {
      clearTimeout(capTimer);
      capTimer = undefined;
    };
    const unsubscribe = slot.session.subscribe((snapshot) => {
      if (snapshot.connectionState?.kind !== "connected") return stopClock();
      capTimer ??= setTimeout(() => {
        if (!this.isRetained(room)) this.retire(room);
      }, UNSENT_EDITS_HOLD_MAX_MS);
    });
    this.enter(slot, {
      kind: "holding",
      stop: () => {
        stopClock();
        unsubscribe();
      },
    });
  }

  private mustKeepForUnsentEdits(session: DocumentSession): boolean {
    return session.hasUnsavedEdits() && session.canDeliverUnsentEdits();
  }

  private retire(room: Room): void {
    const slot = room.slot;
    if (!slot) return;
    room.slot = null;
    this.enter(slot, OPEN);
    const { session } = slot;
    void this.teardownOwner
      .retire(session.roomKey, session)
      .then(async () => {
        (await slot.copy.hold).release();
        if (session.room.kind !== "fork") return;
        const live = this.find({ kind: "live", documentId: session.room.documentId });
        if (live) this.scheduleTeardownIfUnretained(live);
      })
      .catch(() => undefined);
  }

  private settleDrainedRoom(session: DocumentSession): void {
    const room = this.roomOf(session);
    if (room?.slot?.phase.kind !== "holding" || this.mustKeepForUnsentEdits(session)) return;
    this.enter(room.slot, OPEN);
    this.releaseUnheld(room, room.slot);
  }

  private scheduleTeardownIfUnretained(room: Room): void {
    if (room.slot && !this.isRetained(room)) this.scheduleTeardown(room);
  }

  private isRetained(room: Room): boolean {
    const key = sessionRoomKey(room.room);
    for (const retained of this.retainedByOwner.values()) if (retained.has(key)) return true;
    if (room.room.kind !== "live") return false;
    const forks = this.documents.get(room.room.documentId)?.forks.values() ?? [];
    return [...forks].some((fork) => fork.slot);
  }

  private maybeWarnLiveDocCap(): void {
    const liveCount = this.slots().length;
    if (this.liveDocCapWarningEmitted || liveCount <= LIVE_DOC_SOFT_CAP) return;
    this.liveDocCapWarningEmitted = true;
    console.warn(
      `[document-session-registry] live document session count (${liveCount}) exceeds soft cap (${LIVE_DOC_SOFT_CAP})`,
    );
  }
}

function roomsOf(document: DocumentEntry): Room[] {
  return [document.live, ...document.forks.values()];
}

function nextEmit(sessions: readonly DocumentSession[], deadline: number): Promise<void> {
  return new Promise((resolve) => {
    const stops: (() => void)[] = [];
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      for (const stop of stops) stop();
      resolve();
    };
    const timer = setTimeout(finish, Math.max(0, deadline - Date.now()));
    for (const session of sessions) {
      let first = true;
      stops.push(
        session.subscribe(() => {
          if (first) first = false;
          else finish();
        }),
      );
    }
  });
}
