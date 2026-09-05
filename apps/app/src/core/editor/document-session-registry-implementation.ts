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
import { parseYjsRoomName } from "@meridian/contracts/protocol";
import type { DocumentId, ProjectId } from "@meridian/contracts/runtime";

import { createHocuspocusDocumentTransport } from "@/core/transport/hocuspocus-document-transport";
import type { DocumentSessionTransportFactory } from "./document-session";
import { DocumentSession, type DocumentSessionSnapshot } from "./document-session";
import {
  compareAvailabilityGeneration,
  documentSessionPersistenceKey,
  type LocalAdoptionPendingReceipt,
} from "./document-session-authority-store";

import {
  createDocumentSessionCrossContextCoordination,
  DocumentSessionCoordinationError,
  type DocumentSessionCrossContextCoordination,
  type LocalLineageTerminalPort,
  type LocalSessionAuthority,
} from "./document-session-cross-context-coordination";

export type { LocalLineageTerminalPort } from "./document-session-cross-context-coordination";

import type {
  LocalUntitledDocumentSessionFactory,
  RetainedLiveDocumentReference,
} from "./document-session-registry";
import { DocumentSessionTeardownOwner } from "./document-session-teardown-owner";
import type {
  LocalDocumentSessionAdoptionPort,
  LocalDocumentSessionHandoff,
  LocalDocumentSessionReservationPort,
  LocalDocumentSessionTransfer,
} from "./local-document-session-adoption";
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

type LocalTransferReservation = {
  handoff: LocalDocumentSessionHandoff;
  transfer: LocalDocumentSessionTransfer;
  settled: Promise<void>;
  settle(): void;
};

function localTransferKey(projectId: ProjectId, documentId: DocumentId): string {
  return `${encodeURIComponent(projectId)}:${encodeURIComponent(documentId)}`;
}

export class DocumentSessionAuthorityError extends Error {
  constructor(
    readonly kind:
      | "account-unconfigured"
      | "authority-unavailable"
      | "account-mismatch"
      | "generation-revoked"
      | "stale-lease"
      | "older-command"
      | "command-collision"
      | "purge-pending"
      | "adoption-pending",
    message: string,
  ) {
    super(message);
    this.name = "DocumentSessionAuthorityError";
  }
}

export class DocumentSessionRegistry
  implements
    LiveDocumentSessionAuthority,
    LocalSessionAuthority,
    LocalUntitledDocumentSessionFactory,
    LocalDocumentSessionReservationPort,
    LocalDocumentSessionAdoptionPort
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
  private readonly branchRooms = new Map<string, DocumentSession>();
  private readonly retainedByOwner = new Map<string, Map<DocumentId, RetainedLiveDocument>>();
  private readonly retainedObservers = new Set<
    (snapshot: readonly RetainedLiveDocumentReference[]) => void
  >();
  private readonly retainedBranchRoomsByOwner = new Map<string, Set<string>>();
  private readonly admissionReservations = new Map<DocumentId, number>();
  private readonly localTransferReservations = new Map<string, LocalTransferReservation>();
  private readonly pendingTeardownTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private liveDocCapWarningEmitted = false;
  private readonly sessionObservers = new Map<
    string,
    Map<(snapshot: DocumentSessionSnapshot) => void, (() => void) | undefined>
  >();
  private localLineageTerminal: LocalLineageTerminalPort | null = null;

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
      await this.localTransferReservations.get(localTransferKey(projectId, documentId))?.settled;
      this.requireAccountRuntimeOpen();
      const coordination = await this.configuredCoordination();
      const admitted = await this.translateCoordination(() =>
        coordination.admit(projectId, documentId, generation),
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

  connectLocalLineageTerminal(port: LocalLineageTerminalPort): void {
    if (this.localLineageTerminal && this.localLineageTerminal !== port)
      throw new Error("Local lineage terminal owner is already connected");
    this.localLineageTerminal = port;
    void this.configuredCoordination()
      .then((coordination) => coordination.connectLocalLineageTerminal(port))
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

  getDetached(lease: LiveDocumentSessionLease): DocumentSession {
    const state = this.requireLease(lease);
    return this.getOrCreateLiveSession(lease, state, false);
  }

  attachDetached(lease: LiveDocumentSessionLease): DocumentSession {
    const session = this.getDetached(lease);
    if (session.getSnapshot().status === "detached") this.attachSessionTransport(session);
    return session;
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
    await session.restartTransport(({ roomKey, document, awareness }) =>
      createHocuspocusDocumentTransport({ roomName: roomKey, document, awareness }),
    );
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
    const keys = new Set(roomKeys);
    for (const roomKey of keys) {
      if (parseYjsRoomName(roomKey)?.kind !== "branch") {
        throw new Error(`Branch retention requires a branch room: ${roomKey}`);
      }
    }
    this.retainedBranchRoomsByOwner.set(ownerId, keys);
    this.reconcileBranchRooms();
  }

  releaseBranchRooms(ownerId: string): void {
    this.retainedBranchRoomsByOwner.delete(ownerId);
    this.reconcileBranchRooms();
  }

  getBranchRoom(roomKey: string): DocumentSession {
    const room = parseYjsRoomName(roomKey);
    if (room?.kind !== "branch")
      throw new Error(`Branch session requires a branch room: ${roomKey}`);
    this.cancelPendingTeardown(roomKey);
    this.teardownOwner.assertAvailable({ kind: "branch", roomKey });
    const existing = this.branchRooms.get(roomKey);
    if (existing) return existing;
    const session = this.createSession(roomKey, { kind: "none" });
    this.attachSessionTransport(session);
    session.subscribe((snapshot) => {
      if (snapshot.connectionState?.kind !== "reset") return;
      if (this.branchRooms.get(roomKey) !== session) return;
      this.branchRooms.delete(roomKey);
      void this.teardownOwner.retire({ kind: "branch", roomKey }, session).catch(() => undefined);
    });
    this.branchRooms.set(roomKey, session);
    return session;
  }

  localUntitledDocumentSessionFactory(): LocalUntitledDocumentSessionFactory {
    return this;
  }

  createDetached(input: {
    accountId: AccountId;
    projectId: ProjectId;
    documentId: DocumentId;
    persistenceKey: string;
  }): DocumentSession {
    this.requireAccountRuntimeOpen();
    if (input.accountId !== this.accountId) {
      throw new DocumentSessionAuthorityError(
        "account-mismatch",
        "Local Untitled construction belongs to a different account epoch",
      );
    }
    return this.constructSession(input.documentId, {
      kind: "indexeddb",
      key: input.persistenceKey,
    });
  }

  reserve(transfer: LocalDocumentSessionTransfer): LocalDocumentSessionHandoff {
    this.requireAccountRuntimeOpen();
    const key = localTransferKey(transfer.projectId, transfer.documentId);
    const existing = this.localTransferReservations.get(key);
    if (existing) {
      if (
        existing.transfer.session === transfer.session &&
        existing.transfer.projectId === transfer.projectId &&
        existing.transfer.ownerRevision === transfer.ownerRevision
      ) {
        return existing.handoff;
      }
      throw new Error("A different local transfer already reserves this document");
    }
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const handoff = Object.freeze({}) as LocalDocumentSessionHandoff;
    this.localTransferReservations.set(key, {
      handoff,
      transfer,
      settled,
      settle,
    });
    return handoff;
  }

  async begin(input: {
    projectId: ProjectId;
    documentId: DocumentId;
    lineageHandle: string;
    exactDatabaseName: string;
    transitionId: string;
  }): Promise<LocalAdoptionPendingReceipt> {
    this.requireAccountRuntimeOpen();
    const coordination = await this.configuredCoordination();
    return this.translateCoordination(() =>
      coordination.beginLocalAdoption({
        documentId: input.documentId,
        transitionId: input.transitionId,
        lineageHandle: input.lineageHandle,
        exactDatabaseName: input.exactDatabaseName,
        targetGeneration: null,
      }),
    );
  }

  async abort(receipt: LocalAdoptionPendingReceipt): Promise<"aborted" | "stale">;
  abort(handoff: LocalDocumentSessionHandoff): void;
  abort(
    input: LocalAdoptionPendingReceipt | LocalDocumentSessionHandoff,
  ): Promise<"aborted" | "stale"> | undefined {
    if ("documentId" in input) {
      return this.configuredCoordination().then((coordination) =>
        this.translateCoordination(() => coordination.abortLocalAdoption(input)),
      );
    }
    for (const [key, reservation] of this.localTransferReservations) {
      if (reservation.handoff !== input) continue;
      this.localTransferReservations.delete(key);
      reservation.settle();
      return;
    }
    throw new Error("Local document handoff is not reserved");
  }

  async inspect(input: {
    documentId: DocumentId;
    lineageHandle: string;
    exactDatabaseName: string;
  }): Promise<"clear" | "adopting" | "bindable" | "terminal" | "mismatch"> {
    const coordination = await this.configuredCoordination();
    return coordination.inspectLocalLineage(input);
  }

  async recover(input: {
    projectId: ProjectId;
    documentId: DocumentId;
    generation: AvailabilityGeneration;
    lineageHandle: string;
  }): Promise<{ lease: LiveDocumentSessionLease; session: DocumentSession }> {
    this.requireAccountRuntimeOpen();
    const coordination = await this.configuredCoordination();
    const lease = await this.translateCoordination(() =>
      coordination.recoverLocalAdoption(
        input.projectId,
        input.documentId,
        input.generation,
        input.lineageHandle,
      ),
    );
    let state = this.liveRooms.get(input.documentId);
    if (!state) {
      state = {
        leases: new Map([[input.projectId, lease]]),
        session: null,
        persistenceGeneration: lease.persistenceGeneration,
        exactDatabaseName: lease.exactDatabaseName,
      };
      this.liveRooms.set(input.documentId, state);
    }
    const session = this.get(lease);
    return { lease, session };
  }

  async bindAndAdopt(input: {
    projectId: ProjectId;
    documentId: DocumentId;
    generation: AvailabilityGeneration;
    handoff: LocalDocumentSessionHandoff;
    pending: LocalAdoptionPendingReceipt;
  }): Promise<{ lease: LiveDocumentSessionLease; session: DocumentSession }> {
    this.requireAccountRuntimeOpen();
    compareAvailabilityGeneration(input.generation, input.generation);
    const reservationKey = localTransferKey(input.projectId, input.documentId);
    const reservation = this.localTransferReservations.get(reservationKey);
    if (
      !reservation ||
      reservation.handoff !== input.handoff ||
      reservation.transfer.projectId !== input.projectId ||
      reservation.transfer.documentId !== input.documentId
    ) {
      throw new Error("Local document handoff does not own this reservation");
    }
    const coordination = await this.configuredCoordination();
    let admitted: Awaited<
      ReturnType<DocumentSessionCrossContextCoordination["commitLocalAdoption"]>
    >;
    try {
      admitted = await this.translateCoordination(() =>
        coordination.commitLocalAdoption(input.projectId, input.generation, input.pending, {
          prepareCommit: (lease) => {
            this.requireAccountRuntimeOpen();
            if (this.localTransferReservations.get(reservationKey) !== reservation)
              throw new Error("Local document reservation changed during admission");
            if (
              reservation.transfer.lineageHandle !== input.pending.lineageHandle ||
              reservation.transfer.exactDatabaseName !== lease.exactDatabaseName ||
              reservation.transfer.session.persistenceName !== lease.exactDatabaseName
            )
              throw new Error("Local adoption persistence authority does not match the lineage");
            reservation.transfer.prepareCommit();
          },
          completeCommit: async () => {
            const session = reservation.transfer.session;
            const state = this.liveRooms.get(input.documentId);
            if (!state || state.session) throw new Error("A different live session won adoption");
            await reservation.transfer.completeCommit();
            state.session = session;
            state.persistenceGeneration = input.generation;
            state.exactDatabaseName = input.pending.exactDatabaseName;
            this.localTransferReservations.delete(reservationKey);
            reservation.settle();
          },
        }),
      );
    } catch (error) {
      if (
        error instanceof DocumentSessionAuthorityError &&
        error.kind === "generation-revoked" &&
        this.localTransferReservations.get(reservationKey) === reservation
      ) {
        this.localTransferReservations.delete(reservationKey);
        reservation.settle();
      }
      throw error;
    }
    const session = reservation.transfer.session;
    const state = this.liveRooms.get(input.documentId);
    if (!state || state.session !== session)
      throw new Error("Local adoption did not converge on its reserved session");
    try {
      this.attachSessionTransport(session);
    } catch {
      // A later bind/open retries attachment on this same canonical session.
    }
    return { lease: admitted, session };
  }

  beginCloseAccountRuntime(): void {
    if (this.accountRuntimeState !== "open") return;
    this.accountRuntimeState = "closing";
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
      for (const reservation of this.localTransferReservations.values()) reservation.settle();
      this.localTransferReservations.clear();
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

  peekLive(lease: LiveDocumentSessionLease): DocumentSession | undefined {
    return this.requireLease(lease).session ?? undefined;
  }

  hasLive(lease: LiveDocumentSessionLease): boolean {
    return this.peekLive(lease) !== undefined;
  }

  observeLive(
    lease: LiveDocumentSessionLease,
    observer: (snapshot: DocumentSessionSnapshot) => void,
  ): () => void {
    this.requireLease(lease);
    return this.observeRoom(lease.documentId, observer);
  }

  invalidateAll(): Promise<void> {
    this.clearRetainedLiveDocuments();
    this.retainedBranchRoomsByOwner.clear();
    this.liveDocCapWarningEmitted = false;
    for (const timer of this.pendingTeardownTimers.values()) clearTimeout(timer);
    this.pendingTeardownTimers.clear();
    const liveSessions = [...this.liveRooms.entries()].flatMap(([documentId, { session }]) =>
      session ? [{ documentId, session }] : [],
    );
    const branchSessions = [...this.branchRooms.entries()].map(([roomKey, session]) => ({
      roomKey,
      session,
    }));
    this.liveRooms.clear();
    this.branchRooms.clear();
    for (const { documentId, session } of liveSessions) {
      void this.teardownOwner
        .retire({ kind: "live", roomKey: documentId }, session)
        .catch(() => undefined);
    }
    for (const { roomKey, session } of branchSessions) {
      void this.teardownOwner.retire({ kind: "branch", roomKey }, session).catch(() => undefined);
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
    persistence: { kind: "indexeddb"; key: string } | { kind: "none" },
  ): DocumentSession {
    const session = this.constructSession(roomKey, persistence);
    this.publishSession(roomKey, session);
    return session;
  }

  private constructSession(
    roomKey: string,
    persistence: { kind: "indexeddb"; key: string } | { kind: "none" },
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
      if (state?.session) {
        if (this.isRetained(roomKey)) return;
        const session = state.session;
        state.session = null;
        void this.teardownOwner.retire({ kind: "live", roomKey }, session).catch(() => undefined);
        return;
      }
      const branch = this.branchRooms.get(roomKey);
      if (!branch || this.isBranchRetained(roomKey)) return;
      this.branchRooms.delete(roomKey);
      void this.teardownOwner.retire({ kind: "branch", roomKey }, branch).catch(() => undefined);
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

  private isBranchRetained(roomKey: string): boolean {
    for (const retained of this.retainedBranchRoomsByOwner.values()) {
      if (retained.has(roomKey)) return true;
    }
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
      (this.branchRooms.get(roomKey) ?? this.liveRooms.get(roomKey)?.session)?.subscribe(observer),
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

  private reconcileBranchRooms(): void {
    const keep = new Set<string>();
    for (const retained of this.retainedBranchRoomsByOwner.values()) {
      for (const roomKey of retained) keep.add(roomKey);
    }
    for (const roomKey of keep) this.getBranchRoom(roomKey);
    for (const roomKey of this.branchRooms.keys()) {
      if (!keep.has(roomKey)) this.scheduleTeardown(roomKey);
    }
  }
}
