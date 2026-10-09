/**
 * Account-scoped owner of live document sessions and generation-fenced branch rooms.
 * Live acquisition is lease-required; branch rooms remain generation-qualified.
 */
import type {
  AccountId,
  AvailabilityCommandId,
  AvailabilityGeneration,
  LiveDocumentSessionAuthority,
  LiveDocumentSessionLease,
} from "@meridian/contracts/protocol";
import type { DocumentId, ProjectId } from "@meridian/contracts/runtime";

import { createHocuspocusDocumentTransport } from "@/core/transport/hocuspocus-document-transport";
import type { DocumentSessionOptions, DocumentSessionTransportFactory } from "./document-session";
import { DocumentSession, type DocumentSessionSnapshot } from "./document-session";
import {
  compareAvailabilityGeneration,
  documentSessionPersistenceKey,
} from "./document-session-authority-store";
import {
  DocumentSessionAuthorityError,
  DocumentSessionCoordinationError,
  type DocumentSessionCrossContextCoordination,
  type LocalResourceLifetimePort,
  type LocalSessionAuthority,
} from "./document-session-coordination-contract";
import { createDocumentSessionCrossContextCoordination } from "./document-session-cross-context-coordination";

export {
  DocumentSessionAuthorityError,
  type LocalResourceLifetimePort,
} from "./document-session-coordination-contract";

import { BranchRoomPool } from "./branch-room-pool";
import type {
  LocalDocumentSessionFactory,
  RetainedLiveDocumentReference,
} from "./document-session-registry";
import { DocumentSessionTeardownOwner } from "./document-session-teardown-owner";
import { LocalDocumentSessionTransfers } from "./local-document-session-transfers";
import { readSchemaFenceQuarantine, writeSchemaFenceQuarantine } from "./schema-fence";

const LIVE_DOC_SOFT_CAP = 50;
const SESSION_TEARDOWN_GRACE_MS = 3_000;

type LiveRoomState = {
  session: DocumentSession | null;
  persistenceGeneration: AvailabilityGeneration | null;
  exactDatabaseName: string | null;
  leases: Map<ProjectId, LiveDocumentSessionLease>;
};

type RetainedLiveDocument = { lease: LiveDocumentSessionLease; detached: boolean };

export class DocumentSessionRegistry
  implements LiveDocumentSessionAuthority, LocalSessionAuthority, LocalDocumentSessionFactory
{
  private accountId: AccountId | null = null;
  private coordination: DocumentSessionCrossContextCoordination | null = null;
  private authorityFailure: unknown = null;
  private accountRuntimeState: "open" | "closing" | "closed" = "open";
  private accountCloseAttempt: Promise<void> | null = null;
  private readonly teardownOwner = new DocumentSessionTeardownOwner(
    (key) =>
      new DocumentSessionAuthorityError(
        "authority-unavailable",
        `${key.kind === "live" ? "Live" : "Branch"} session teardown is unfinished`,
      ),
  );
  private readonly liveRooms = new Map<DocumentId, LiveRoomState>();
  private readonly branchRooms: BranchRoomPool;
  private readonly retainedByOwner = new Map<string, Map<DocumentId, RetainedLiveDocument>>();
  private readonly retainedObservers = new Set<
    (snapshot: readonly RetainedLiveDocumentReference[]) => void
  >();
  private readonly admissionReservations = new Map<DocumentId, number>();
  /** The private local-transfer facet: the account runtime's reservation and adoption ports. */
  readonly localTransfers = new LocalDocumentSessionTransfers({
    requireOpen: () => this.requireAccountRuntimeOpen(),
    coordination: () => this.configuredCoordination(),
    translate: (operation) => this.translateCoordination(operation),
    isAdmitting: (documentId) => (this.admissionReservations.get(documentId) ?? 0) > 0,
    liveRoom: (documentId) => this.liveRooms.get(documentId),
    retain: (ownerId, leases, options) => this.retain(ownerId, leases, options),
    release: (ownerId) => this.release(ownerId),
    attachTransport: (session) => this.attachSessionTransport(session),
  });
  private readonly pendingTeardownTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private liveDocCapWarningEmitted = false;
  private readonly sessionObservers = new Map<
    string,
    Map<(snapshot: DocumentSessionSnapshot) => void, (() => void) | undefined>
  >();
  private localResources: LocalResourceLifetimePort | null = null;
  /** Each refused live session's drop: running, or settled whether or not it removed the room. */
  private readonly refusedRoomDrops = new WeakMap<DocumentSession, Promise<void> | "settled">();

  constructor(
    private readonly createCoordination: (
      accountId: AccountId,
      local: LocalSessionAuthority,
    ) => DocumentSessionCrossContextCoordination = (accountId, local) =>
      createDocumentSessionCrossContextCoordination({ accountId, local }),
    private readonly teardownGraceMs = SESSION_TEARDOWN_GRACE_MS,
    accountId?: AccountId,
    private readonly transportFactory: DocumentSessionTransportFactory = ({
      roomKey,
      document,
      awareness,
    }) => createHocuspocusDocumentTransport({ roomName: roomKey, document, awareness }),
  ) {
    this.branchRooms = new BranchRoomPool({
      openSession: (roomKey) => {
        const session = this.createSession(roomKey, { kind: "none" });
        this.attachSessionTransport(session);
        return session;
      },
      teardownOwner: this.teardownOwner,
      teardownGraceMs,
    });
    if (!accountId) return;
    this.accountId = accountId;
    try {
      this.coordination = this.createCoordination(accountId, this);
    } catch (error) {
      this.authorityFailure = error;
    }
  }

  async admit(
    projectId: ProjectId,
    documentId: DocumentId,
    generation: AvailabilityGeneration,
  ): Promise<LiveDocumentSessionLease> {
    this.requireAccountRuntimeOpen();
    compareAvailabilityGeneration(generation, generation);
    this.reserveAdmission(documentId);
    try {
      await this.localTransfers.settled(documentId);
      this.requireAccountRuntimeOpen();
      const coordination = await this.configuredCoordination();
      const originLineageHandle =
        (await this.localResources?.lineageHandleFor(projectId, documentId)) ?? undefined;
      const admitted = await this.translateCoordination(() =>
        coordination.admit(projectId, documentId, generation, originLineageHandle),
      );
      return {
        accountId: admitted.accountId,
        projectId: admitted.projectId,
        documentId: admitted.documentId,
        generation: admitted.generation,
      };
    } finally {
      this.releaseAdmissionReservation(documentId);
    }
  }

  async revokeDocument(
    _projectId: ProjectId,
    documentId: DocumentId,
    generation: AvailabilityGeneration,
    commandId: AvailabilityCommandId,
  ): Promise<{ revokedThrough: AvailabilityGeneration; persistence: "cleared" }> {
    compareAvailabilityGeneration(generation, generation);
    const coordination = await this.configuredCoordination();
    return this.translateCoordination(() =>
      coordination.revokeDocument(_projectId, documentId, generation, commandId),
    );
  }

  connectLocalResources(port: LocalResourceLifetimePort): void {
    this.requireAccountRuntimeOpen();
    if (this.localResources && this.localResources !== port)
      throw new Error("Local resource owner is already connected");
    this.localResources = port;
    void this.configuredCoordination()
      .then((coordination) => coordination.connectLocalLineageTerminal(port.terminal))
      .catch((error) => {
        this.authorityFailure = error;
      });
  }

  async revokeAccess(
    projectId: ProjectId,
    documentId: DocumentId,
    generation: AvailabilityGeneration,
    commandId: AvailabilityCommandId,
  ): Promise<{
    revokedThrough: AvailabilityGeneration;
    persistence: "cleared" | "retained-by-other-lease";
  }> {
    compareAvailabilityGeneration(generation, generation);
    const coordination = await this.configuredCoordination();
    return this.translateCoordination(() =>
      coordination.revokeAccess(projectId, documentId, generation, commandId),
    );
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
    await session.restartTransport(this.transportFactory);
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

  retainBranchRooms(ownerId: string, roomKeys: Iterable<string>): void {
    this.branchRooms.retain(ownerId, roomKeys);
  }

  releaseBranchRooms(ownerId: string): void {
    this.branchRooms.release(ownerId);
  }

  rebuildBranchRoom(roomKey: string): Promise<DocumentSession> {
    return this.branchRooms.rebuild(roomKey);
  }

  getBranchRoom(roomKey: string): DocumentSession {
    return this.branchRooms.get(roomKey);
  }

  async whenAuthorityReady(): Promise<void> {
    this.requireAccountRuntimeOpen();
    const coordination = await this.configuredCoordination();
    await this.translateCoordination(() => coordination.requireReady());
    this.requireAccountRuntimeOpen();
  }

  createDetached(input: {
    accountId: AccountId;
    projectId: ProjectId;
    documentId: DocumentId;
    persistenceKey: string;
    fresh?: boolean;
  }): DocumentSession {
    this.requireAccountRuntimeOpen();
    if (input.accountId !== this.accountId) {
      throw new DocumentSessionAuthorityError(
        "account-mismatch",
        "Local document construction belongs to a different account epoch",
      );
    }
    return this.constructSession(input.documentId, {
      kind: "indexeddb",
      key: input.persistenceKey,
      fresh: input.fresh,
    });
  }

  beginCloseAccountRuntime(): void {
    if (this.accountRuntimeState !== "open") return;
    this.accountRuntimeState = "closing";
    this.localResources?.beginClose();
    this.coordination?.beginClose();
  }

  closeAccountRuntime(): Promise<void> {
    this.beginCloseAccountRuntime();
    if (this.accountRuntimeState === "closed") return Promise.resolve();
    if (this.accountCloseAttempt) return this.accountCloseAttempt;
    const attempt = Promise.resolve().then(async () => {
      const coordination = this.coordination;
      await (coordination?.close() ?? this.invalidateAll());
      if (this.coordination === coordination) this.coordination = null;
      this.localTransfers.settleAll();
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

  observeBranchRoom(
    roomKey: string,
    observer: (snapshot: DocumentSessionSnapshot) => void,
  ): () => void {
    return this.observeRoom(roomKey, observer);
  }

  invalidateAll(): Promise<void> {
    this.beginCloseAccountRuntime();
    this.clearRetainedLiveDocuments();
    this.branchRooms.invalidate();
    this.liveDocCapWarningEmitted = false;
    for (const timer of this.pendingTeardownTimers.values()) clearTimeout(timer);
    this.pendingTeardownTimers.clear();
    const liveSessions = [...this.liveRooms.entries()].flatMap(([documentId, { session }]) =>
      session ? [{ documentId, session }] : [],
    );
    this.liveRooms.clear();
    for (const { documentId, session } of liveSessions) {
      void this.teardownOwner
        .retire({ kind: "live", roomKey: documentId }, session)
        .catch(() => undefined);
    }
    return Promise.all([this.teardownOwner.drain(), this.localResources?.finishClose()]).then(
      () => undefined,
    );
  }

  private clearRetainedLiveDocuments(): void {
    const hadRetainedReferences = [...this.retainedByOwner.values()].some(
      (retained) => retained.size > 0,
    );
    this.retainedByOwner.clear();
    if (hadRetainedReferences) this.publishRetainedLiveDocuments();
  }

  private async configuredCoordination(): Promise<DocumentSessionCrossContextCoordination> {
    if (!this.accountId) {
      throw new DocumentSessionAuthorityError(
        "account-unconfigured",
        "Session account is not configured",
      );
    }
    if (!this.coordination) {
      const error = this.authorityFailure;
      if (error instanceof DocumentSessionCoordinationError) {
        throw new DocumentSessionAuthorityError(error.kind, error.message);
      }
      throw new DocumentSessionAuthorityError(
        "authority-unavailable",
        "Live document authority is unavailable",
      );
    }
    return this.coordination;
  }

  private async translateCoordination<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof DocumentSessionCoordinationError) {
        throw new DocumentSessionAuthorityError(error.kind, error.message);
      }
      throw error;
    }
  }

  validateAdmission(input: {
    documentId: DocumentId;
    projectId: ProjectId;
    generation: AvailabilityGeneration;
  }): void {
    this.teardownOwner.assertAvailable({ kind: "live", roomKey: input.documentId });
    const existing = this.liveRooms.get(input.documentId)?.leases.get(input.projectId);
    if (existing && compareAvailabilityGeneration(input.generation, existing.generation) < 0) {
      throw new DocumentSessionAuthorityError(
        "stale-lease",
        `A newer lease already exists for ${input.documentId}`,
      );
    }
  }

  installSynchronously(input: {
    documentId: DocumentId;
    projectId: ProjectId;
    generation: AvailabilityGeneration;
    persistenceGeneration: AvailabilityGeneration;
    exactDatabaseName: string;
  }): void {
    this.requireAccountRuntimeOpen();
    this.teardownOwner.assertAvailable({ kind: "live", roomKey: input.documentId });
    if (!this.accountId) return;
    const lease = {
      accountId: this.accountId,
      projectId: input.projectId,
      documentId: input.documentId,
      generation: input.generation,
    };
    const state = this.liveRooms.get(input.documentId) ?? {
      session: null,
      persistenceGeneration: input.persistenceGeneration,
      exactDatabaseName: input.exactDatabaseName,
      leases: new Map(),
    };
    state.persistenceGeneration = input.persistenceGeneration;
    state.exactDatabaseName = input.exactDatabaseName;
    state.leases.set(input.projectId, lease);
    this.liveRooms.set(input.documentId, state);
  }

  async drainDocument(input: {
    documentId: DocumentId;
    generation: AvailabilityGeneration;
    incarnation: AvailabilityGeneration | null;
    exactDatabaseName?: string | null;
  }): Promise<void> {
    const state = this.liveRooms.get(input.documentId);
    if (!state) {
      await this.teardownOwner.drainRoom({ kind: "live", roomKey: input.documentId });
      return;
    }
    if (
      state.persistenceGeneration !== input.incarnation ||
      (input.exactDatabaseName !== undefined && state.exactDatabaseName !== input.exactDatabaseName)
    )
      return;
    this.cancelPendingTeardown(input.documentId);
    let retainedChanged = false;
    for (const retained of this.retainedByOwner.values()) {
      retainedChanged = retained.delete(input.documentId) || retainedChanged;
    }
    if (retainedChanged) this.publishRetainedLiveDocuments();
    this.liveRooms.delete(input.documentId);
    if (state.session) {
      await this.teardownOwner.retire({ kind: "live", roomKey: input.documentId }, state.session);
    }
    await this.teardownOwner.drainRoom({ kind: "live", roomKey: input.documentId });
  }

  async drainAccess(input: {
    documentId: DocumentId;
    projectId: ProjectId;
    generation: AvailabilityGeneration;
    incarnation: AvailabilityGeneration | null;
    exactDatabaseName?: string | null;
  }): Promise<"other-local-project-remains" | "locally-empty"> {
    const state = this.liveRooms.get(input.documentId);
    if (!state) {
      await this.teardownOwner.drainRoom({ kind: "live", roomKey: input.documentId });
      return "locally-empty";
    }
    if (
      state.persistenceGeneration !== input.incarnation ||
      (input.exactDatabaseName !== undefined && state.exactDatabaseName !== input.exactDatabaseName)
    )
      return "locally-empty";
    state.leases.delete(input.projectId);
    if (this.removeRetainedProjectLease(input.projectId, input.documentId)) {
      this.publishRetainedLiveDocuments();
    }
    if (state.leases.size > 0) return "other-local-project-remains";
    this.cancelPendingTeardown(input.documentId);
    this.liveRooms.delete(input.documentId);
    if (state.session) {
      await this.teardownOwner.retire({ kind: "live", roomKey: input.documentId }, state.session);
    }
    await this.teardownOwner.drainRoom({ kind: "live", roomKey: input.documentId });
    return "locally-empty";
  }

  private reserveAdmission(documentId: DocumentId): void {
    this.admissionReservations.set(
      documentId,
      (this.admissionReservations.get(documentId) ?? 0) + 1,
    );
  }

  private releaseAdmissionReservation(documentId: DocumentId): void {
    const count = this.admissionReservations.get(documentId) ?? 0;
    if (count <= 1) this.admissionReservations.delete(documentId);
    else this.admissionReservations.set(documentId, count - 1);
  }

  private requireLease(lease: LiveDocumentSessionLease): LiveRoomState {
    if (lease.accountId !== this.accountId) {
      throw new DocumentSessionAuthorityError(
        "account-mismatch",
        "Lease belongs to another account",
      );
    }
    const state = this.liveRooms.get(lease.documentId);
    const current = state?.leases.get(lease.projectId);
    if (!state || !current || current.generation !== lease.generation) {
      throw new DocumentSessionAuthorityError(
        "stale-lease",
        `Lease is stale for ${lease.documentId}`,
      );
    }
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
    state.persistenceGeneration ??= lease.generation;
    state.exactDatabaseName ??= documentSessionPersistenceKey(
      lease.accountId,
      lease.documentId,
      state.persistenceGeneration,
    );
    const session = this.createSession(lease.documentId, {
      kind: "indexeddb",
      key: state.exactDatabaseName,
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
    if (session.room.kind === "live") session.subscribe(() => this.dropRefusedRoom(session));
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
   * Drop a live room whose pending edits the server refused, even when no
   * editor host holds it: revoking each lease's access tears the session down
   * and clears its local copy. Branch rooms hold no lease; their editor
   * rebuilds them in place (`rebuildBranchRoom`).
   */
  private dropRefusedRoom(session: DocumentSession): void {
    if (this.refusedRoomDrops.has(session) || session.resetDisposition !== "refused") return;
    const state = this.liveRooms.get(session.documentId as DocumentId);
    if (state?.session !== session) return;
    const settle = () => {
      this.refusedRoomDrops.set(session, "settled");
    };
    this.refusedRoomDrops.set(
      session,
      Promise.all(
        [...state.leases.values()].map((lease) =>
          this.revokeAccess(
            lease.projectId,
            lease.documentId,
            lease.generation,
            `access-refused/v1/${lease.projectId}/${lease.documentId}/${lease.generation}`,
          ),
        ),
      ).then(settle, settle),
    );
  }

  private removeRetainedProjectLease(projectId: ProjectId, documentId: DocumentId): boolean {
    let changed = false;
    for (const retained of this.retainedByOwner.values()) {
      if (retained.get(documentId)?.lease.projectId === projectId) {
        retained.delete(documentId);
        changed = true;
      }
    }
    return changed;
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
      for (const [documentId, owner] of retained) keep.set(documentId, owner);
    }
    for (const owner of keep.values()) {
      const state = this.requireLease(owner.lease);
      this.getOrCreateLiveSession(owner.lease, state, !owner.detached);
    }
    for (const [documentId, state] of this.liveRooms) {
      if (state.session && !keep.has(documentId)) {
        this.scheduleTeardown(documentId);
      }
    }
  }

  private scheduleTeardown(roomKey: string): void {
    if (this.pendingTeardownTimers.has(roomKey)) return;
    const timer = setTimeout(() => {
      this.pendingTeardownTimers.delete(roomKey);
      const state = this.liveRooms.get(roomKey);
      if (!state?.session || this.isRetained(roomKey)) return;
      const session = state.session;
      state.session = null;
      void this.teardownOwner.retire({ kind: "live", roomKey }, session).catch(() => undefined);
    }, this.teardownGraceMs);
    this.pendingTeardownTimers.set(roomKey, timer);
  }

  private cancelPendingTeardown(roomKey: string): void {
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
      (this.branchRooms.peek(roomKey) ?? this.liveRooms.get(roomKey)?.session)?.subscribe(observer),
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
