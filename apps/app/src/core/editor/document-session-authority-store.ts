/** Durable account-scoped live-room ordering, drains, fences, and proven purge work. */
import type {
  AccessFenceKey,
  AccountId,
  AvailabilityCommandId,
  AvailabilityGeneration,
  DocumentFenceKey,
  RevocationFence,
} from "@meridian/contracts/protocol";
import { assertAvailabilityGeneration } from "@meridian/contracts/protocol";
import type { DocumentId, ProjectId } from "@meridian/contracts/runtime";
import { collabSchemaKeyTag } from "@meridian/prosemirror-schema";

const AUTHORITY_STORE_VERSION = 3;
const FENCES = "fences";
const PURGES = "purges";
const ROOMS = "room-order";
const ACCESS_HEADS = "access-heads";
const ACCESS_OUTCOMES = "access-outcomes";
const LIVE_PERSISTENCE_PREFIX = `meridian:document:${collabSchemaKeyTag()}:live/`;

type FenceRecord = RevocationFence & { key: DocumentFenceKey | AccessFenceKey };
export type PendingDrain =
  | {
      kind: "document";
      generation: AvailabilityGeneration;
      commandId: AvailabilityCommandId;
      incarnation: DrainPersistenceAuthority | null;
    }
  | {
      kind: "access";
      projectId: ProjectId;
      generation: AvailabilityGeneration;
      commandId: AvailabilityCommandId;
      incarnation: DrainPersistenceAuthority | null;
    };
export type BindablePersistenceAuthority = {
  phase: "bindable";
  generation: AvailabilityGeneration;
  exactDatabaseName: string;
  originLineageHandle?: string;
};
export type DrainPersistenceAuthority = Omit<BindablePersistenceAuthority, "generation"> & {
  generation: AvailabilityGeneration | null;
};
export type PersistenceAuthority =
  | BindablePersistenceAuthority
  | {
      phase: "adopting-local";
      transitionId: string;
      lineageHandle: string;
      exactDatabaseName: string;
    }
  | {
      phase: "terminal-local";
      transitionId: string;
      lineageHandle: string;
      exactDatabaseName: string;
      terminalGeneration: AvailabilityGeneration;
      commandId: AvailabilityCommandId;
      /** Namespace version of the exact-ID deletion; absent on records that never carried one. */
      deletionVersion?: string;
    }
  | null;
export type RoomOrderRecord = {
  documentId: DocumentId;
  persistence: PersistenceAuthority;
  documentAdmittedThrough: AvailabilityGeneration | null;
  pendingDrain: PendingDrain | null;
};
type AccessHeadRecord = {
  key: string;
  documentId: DocumentId;
  projectId: ProjectId;
  admittedThrough: AvailabilityGeneration;
};
type AccessOutcomeRecord = {
  key: string;
  documentId: DocumentId;
  projectId: ProjectId;
  generation: AvailabilityGeneration;
  commandId: AvailabilityCommandId;
  persistence: "cleared" | "retained-by-other-lease";
};
export type PendingDocumentPurge = {
  key: string;
  accountId: AccountId;
  documentId: DocumentId;
  revokedThrough: AvailabilityGeneration;
  exactDatabaseName: string;
  transitionId?: string;
};

/** A committed historical observation, never admission or permission to purge/upload. */
export type ResourceAuthoritySnapshot = {
  room: RoomOrderRecord;
  pendingPurge: PendingDocumentPurge | null;
};

export type TerminalLineageReceipt = Readonly<{
  kind: "lineage-transition-required";
  documentId: DocumentId;
  generation: AvailabilityGeneration;
  commandId: AvailabilityCommandId;
  transitionId: string;
  lineageHandle: string;
  exactDatabaseName: string;
  persistenceGeneration: AvailabilityGeneration | null;
  /** Namespace version that proved the deletion; null leaves the resource terminal versionless. */
  deletionVersion: string | null;
}>;

/** The terminal lineage a room's stored `terminal-local` authority still owes. */
export function storedTerminalLineage(room: RoomOrderRecord): TerminalLineageReceipt | null {
  const authority = room.persistence;
  if (authority?.phase !== "terminal-local") return null;
  return {
    kind: "lineage-transition-required",
    documentId: room.documentId,
    generation: authority.terminalGeneration,
    commandId: authority.commandId,
    transitionId: authority.transitionId,
    lineageHandle: authority.lineageHandle,
    exactDatabaseName: authority.exactDatabaseName,
    persistenceGeneration: room.pendingDrain?.incarnation?.generation ?? null,
    deletionVersion: authority.deletionVersion ?? null,
  };
}

export type TerminalLineageProgress = "pending" | "complete" | "superseded";

export type AdmissionDecision =
  | {
      kind: "admitted";
      persistenceGeneration: AvailabilityGeneration;
      exactDatabaseName: string;
    }
  | { kind: "generation-revoked" }
  | { kind: "purge-barrier"; purgeThrough: AvailabilityGeneration }
  | { kind: "pending-local-adoption"; phase: "adopting-local" | "terminal-local" }
  | { kind: "pending"; pending: PendingDrain };

export type DrainStart =
  | { kind: "started"; pending: PendingDrain }
  | { kind: "pending"; pending: PendingDrain }
  | { kind: "older"; revokedThrough: AvailabilityGeneration }
  | { kind: "collision"; revokedThrough: AvailabilityGeneration }
  | {
      kind: "replay";
      revokedThrough: AvailabilityGeneration;
      persistence?: "cleared" | "retained-by-other-lease";
    }
  | TerminalLineageReceipt;

export type LocalAdoptionPendingReceipt = Readonly<{
  documentId: DocumentId;
  transitionId: string;
  lineageHandle: string;
  exactDatabaseName: string;
}>;

/** The durable state `beginLocalAdoption` found, the next pass's only input. */
export type LocalAdoptionState =
  | { kind: "reserved"; receipt: LocalAdoptionPendingReceipt }
  | { kind: "committed" }
  | { kind: "terminal" | "mismatch" };

/** The fenced commit: the reservation it consumes, and the synchronous hook that runs inside it. */
export type LocalAdoptionCommit = LocalAdoptionPendingReceipt & {
  /** Runs inside the commit's IndexedDB transaction, so it must not await. */
  beforeWrite(persistenceGeneration: AvailabilityGeneration): undefined;
};

function encodeKeyPart(value: string): string {
  return encodeURIComponent(value);
}

function accessRecordKey(documentId: DocumentId, projectId: ProjectId): string {
  return `${encodeKeyPart(documentId)}/${encodeKeyPart(projectId)}`;
}

function purgeRecordKey(accountId: AccountId, documentId: DocumentId): string {
  return `${accountId}/${documentId}`;
}

function emptyRoom(documentId: DocumentId): RoomOrderRecord {
  return {
    documentId,
    persistence: null,
    documentAdmittedThrough: null,
    pendingDrain: null,
  };
}

function sameAdoption(
  authority: PersistenceAuthority,
  receipt: LocalAdoptionPendingReceipt,
): authority is Extract<PersistenceAuthority, { phase: "adopting-local" }> {
  return (
    authority?.phase === "adopting-local" &&
    authority.transitionId === receipt.transitionId &&
    authority.lineageHandle === receipt.lineageHandle &&
    authority.exactDatabaseName === receipt.exactDatabaseName
  );
}

/** A bindable incarnation is the lineage's own when it names its database and no other origin. */
function sameLineage(
  authority: Extract<PersistenceAuthority, { phase: "bindable" }>,
  receipt: LocalAdoptionPendingReceipt,
): boolean {
  return (
    authority.exactDatabaseName === receipt.exactDatabaseName &&
    (authority.originLineageHandle === undefined ||
      authority.originLineageHandle === receipt.lineageHandle)
  );
}

export function compareAvailabilityGeneration(
  left: AvailabilityGeneration,
  right: AvailabilityGeneration,
): -1 | 0 | 1 {
  assertAvailabilityGeneration(left);
  assertAvailabilityGeneration(right);
  const comparison = BigInt(left) - BigInt(right);
  return comparison < 0n ? -1 : comparison > 0n ? 1 : 0;
}

function maximumGeneration(
  current: AvailabilityGeneration | null,
  candidate: AvailabilityGeneration,
): AvailabilityGeneration {
  return current && compareAvailabilityGeneration(current, candidate) > 0 ? current : candidate;
}

export function documentFenceKey(accountId: AccountId, documentId: DocumentId): DocumentFenceKey {
  return `document/${accountId}/${documentId}`;
}

export function accessFenceKey(
  accountId: AccountId,
  projectId: ProjectId,
  documentId: DocumentId,
): AccessFenceKey {
  return `access/${accountId}/${projectId}/${documentId}`;
}

export function documentSessionPersistenceKey(
  accountId: AccountId,
  documentId: DocumentId,
  generation: AvailabilityGeneration,
): string {
  assertAvailabilityGeneration(generation);
  return `${LIVE_PERSISTENCE_PREFIX}${encodeKeyPart(accountId)}/${encodeKeyPart(documentId)}/${generation}`;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction failed"));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
  });
}

/** One durable authority database per authenticated account. */
export class DocumentSessionAuthorityStore {
  private readonly databasePromise: Promise<IDBDatabase>;
  private readonly blockedDeleteRequests = new Set<string>();
  private closed = false;

  constructor(
    readonly accountId: AccountId,
    private readonly idb: IDBFactory = indexedDB,
    private readonly onVersionChange: () => void = () => undefined,
    private readonly onPurgeWake: () => void = () => undefined,
  ) {
    this.databasePromise = new Promise((resolve, reject) => {
      let settled = false;
      let request: IDBOpenDBRequest;
      try {
        request = idb.open(
          `meridian:document-session-authority:${encodeKeyPart(accountId)}`,
          AUTHORITY_STORE_VERSION,
        );
      } catch (error) {
        reject(error);
        return;
      }
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(FENCES))
          database.createObjectStore(FENCES, { keyPath: "key" });
        if (!database.objectStoreNames.contains(PURGES))
          database.createObjectStore(PURGES, { keyPath: "key" });
        const rooms = database.objectStoreNames.contains(ROOMS)
          ? request.transaction?.objectStore(ROOMS)
          : database.createObjectStore(ROOMS, { keyPath: "documentId" });
        if (rooms && !rooms.indexNames.contains("exact-persistence"))
          rooms.createIndex("exact-persistence", "persistence.exactDatabaseName", { unique: true });
        if (!database.objectStoreNames.contains(ACCESS_HEADS))
          database.createObjectStore(ACCESS_HEADS, { keyPath: "key" });
        if (!database.objectStoreNames.contains(ACCESS_OUTCOMES))
          database.createObjectStore(ACCESS_OUTCOMES, { keyPath: "key" });
      };
      request.onblocked = () => {
        if (!settled) {
          settled = true;
          reject(new Error("Document session authority upgrade is blocked"));
        }
      };
      request.onerror = () => {
        if (!settled) {
          settled = true;
          reject(request.error ?? new Error("IndexedDB authority open failed"));
        }
      };
      request.onsuccess = () => {
        if (settled) {
          request.result.close();
          return;
        }
        settled = true;
        // Coordination owns the ordered close barrier. Keeping this connection open
        // keeps the upgrader blocked until local sessions and lifecycle holds are gone.
        request.result.onversionchange = this.onVersionChange;
        resolve(request.result);
      };
    });
  }

  async ensureAvailable(): Promise<void> {
    const database = await this.databasePromise;
    const transaction = database.transaction(ROOMS, "readwrite");
    await transactionDone(transaction);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      (await this.databasePromise).close();
    } catch {
      // A store that never became available has no connection to close.
    }
  }

  async readFence(key: DocumentFenceKey | AccessFenceKey): Promise<RevocationFence | null> {
    const database = await this.databasePromise;
    const transaction = database.transaction(FENCES, "readonly");
    const record = (await requestResult(transaction.objectStore(FENCES).get(key))) as
      | FenceRecord
      | undefined;
    await transactionDone(transaction);
    return record ? { revokedThrough: record.revokedThrough, commandId: record.commandId } : null;
  }

  async readAdmissionFences(
    documentKey: DocumentFenceKey,
    accessKey: AccessFenceKey,
  ): Promise<readonly [RevocationFence | null, RevocationFence | null]> {
    const database = await this.databasePromise;
    const transaction = database.transaction(FENCES, "readonly");
    const fences = transaction.objectStore(FENCES);
    const records = await Promise.all([
      requestResult(fences.get(documentKey)) as Promise<FenceRecord | undefined>,
      requestResult(fences.get(accessKey)) as Promise<FenceRecord | undefined>,
    ]);
    await transactionDone(transaction);
    const toFence = (record: FenceRecord | undefined): RevocationFence | null =>
      record ? { revokedThrough: record.revokedThrough, commandId: record.commandId } : null;
    return [toFence(records[0]), toFence(records[1])];
  }

  async readRoom(documentId: DocumentId): Promise<RoomOrderRecord> {
    const database = await this.databasePromise;
    const transaction = database.transaction(ROOMS, "readonly");
    const room = (await requestResult(transaction.objectStore(ROOMS).get(documentId))) as
      | RoomOrderRecord
      | undefined;
    await transactionDone(transaction);
    return room ?? emptyRoom(documentId);
  }

  async readResourceSnapshot(documentId: DocumentId): Promise<ResourceAuthoritySnapshot> {
    const database = await this.databasePromise;
    const transaction = database.transaction([ROOMS, PURGES], "readonly");
    const [room, purge] = await Promise.all([
      requestResult(transaction.objectStore(ROOMS).get(documentId)) as Promise<
        RoomOrderRecord | undefined
      >,
      requestResult(
        transaction.objectStore(PURGES).get(purgeRecordKey(this.accountId, documentId)),
      ) as Promise<PendingDocumentPurge | undefined>,
    ]);
    await transactionDone(transaction);
    return { room: room ?? emptyRoom(documentId), pendingPurge: purge ?? null };
  }

  async readAccessHead(
    documentId: DocumentId,
    projectId: ProjectId,
  ): Promise<AvailabilityGeneration | null> {
    const database = await this.databasePromise;
    const transaction = database.transaction(ACCESS_HEADS, "readonly");
    const record = (await requestResult(
      transaction.objectStore(ACCESS_HEADS).get(accessRecordKey(documentId, projectId)),
    )) as AccessHeadRecord | undefined;
    await transactionDone(transaction);
    return record?.admittedThrough ?? null;
  }

  async listPendingDrains(): Promise<readonly RoomOrderRecord[]> {
    const database = await this.databasePromise;
    const transaction = database.transaction(ROOMS, "readonly");
    const rooms = (await requestResult(
      transaction.objectStore(ROOMS).getAll(),
    )) as RoomOrderRecord[];
    await transactionDone(transaction);
    return rooms.filter((room) => room.pendingDrain !== null);
  }

  async listTerminalLineages(): Promise<readonly TerminalLineageReceipt[]> {
    const database = await this.databasePromise;
    const transaction = database.transaction(ROOMS, "readonly");
    const rooms = (await requestResult(
      transaction.objectStore(ROOMS).getAll(),
    )) as RoomOrderRecord[];
    await transactionDone(transaction);
    return rooms.flatMap((room) => {
      const receipt = storedTerminalLineage(room);
      return receipt ? [receipt] : [];
    });
  }

  /** Compares one exact terminal receipt without advancing durable authority. */
  async inspectTerminalLineage(receipt: TerminalLineageReceipt): Promise<TerminalLineageProgress> {
    const { room, pendingPurge: purge } = await this.readResourceSnapshot(receipt.documentId);
    const authority = room?.persistence;
    if (
      authority?.phase === "terminal-local" &&
      authority.transitionId === receipt.transitionId &&
      authority.lineageHandle === receipt.lineageHandle &&
      authority.exactDatabaseName === receipt.exactDatabaseName &&
      authority.terminalGeneration === receipt.generation &&
      authority.commandId === receipt.commandId
    )
      return "pending";
    if (
      room?.pendingDrain?.commandId === receipt.commandId &&
      room.pendingDrain.generation === receipt.generation
    )
      return "pending";
    if (purge?.transitionId === receipt.transitionId) return "pending";
    return authority || room?.pendingDrain ? "superseded" : "complete";
  }

  async admit(input: {
    documentId: DocumentId;
    projectId: ProjectId;
    generation: AvailabilityGeneration;
    originLineageHandle?: string;
    /** Commits this reservation's local copy at `generation`; without it a reservation refuses opens. */
    adoption?: LocalAdoptionCommit;
  }): Promise<AdmissionDecision> {
    assertAvailabilityGeneration(input.generation);
    const database = await this.databasePromise;
    const transaction = database.transaction([FENCES, PURGES, ROOMS, ACCESS_HEADS], "readwrite");
    const fences = transaction.objectStore(FENCES);
    const [documentFence, accessFence, storedRoom, purge] = await Promise.all([
      requestResult(fences.get(documentFenceKey(this.accountId, input.documentId))) as Promise<
        FenceRecord | undefined
      >,
      requestResult(
        fences.get(accessFenceKey(this.accountId, input.projectId, input.documentId)),
      ) as Promise<FenceRecord | undefined>,
      requestResult(transaction.objectStore(ROOMS).get(input.documentId)) as Promise<
        RoomOrderRecord | undefined
      >,
      requestResult(
        transaction.objectStore(PURGES).get(purgeRecordKey(this.accountId, input.documentId)),
      ) as Promise<PendingDocumentPurge | undefined>,
    ]);
    if (
      [documentFence, accessFence].some(
        (fence) =>
          fence && compareAvailabilityGeneration(input.generation, fence.revokedThrough) <= 0,
      )
    ) {
      transaction.abort();
      return { kind: "generation-revoked" };
    }
    const room = storedRoom ?? emptyRoom(input.documentId);
    if (room.pendingDrain) {
      transaction.abort();
      return { kind: "pending", pending: room.pendingDrain };
    }
    const adoption = input.adoption;
    const reserved =
      adoption && sameAdoption(room.persistence, adoption) ? room.persistence : undefined;
    if (adoption && !room.persistence) {
      transaction.abort();
      return { kind: "generation-revoked" };
    }
    if (
      (room.persistence?.phase === "adopting-local" && !reserved) ||
      room.persistence?.phase === "terminal-local"
    ) {
      transaction.abort();
      return { kind: "pending-local-adoption", phase: room.persistence.phase };
    }
    if (
      adoption &&
      room.persistence?.phase === "bindable" &&
      !sameLineage(room.persistence, adoption)
    ) {
      transaction.abort();
      throw new Error("Local adoption authority changed before session transfer");
    }
    const reusable =
      room.persistence?.phase === "bindable" &&
      (!purge ||
        compareAvailabilityGeneration(room.persistence.generation, purge.revokedThrough) > 0)
        ? room.persistence
        : null;
    if (
      !reusable &&
      purge &&
      compareAvailabilityGeneration(input.generation, purge.revokedThrough) <= 0
    ) {
      transaction.abort();
      return { kind: "purge-barrier", purgeThrough: purge.revokedThrough };
    }
    const persistenceGeneration = reusable?.generation ?? input.generation;
    const exactDatabaseName =
      reusable?.exactDatabaseName ??
      reserved?.exactDatabaseName ??
      documentSessionPersistenceKey(this.accountId, input.documentId, input.generation);
    try {
      if (adoption && exactDatabaseName !== adoption.exactDatabaseName)
        throw new Error("Local adoption authority changed before session transfer");
      adoption?.beforeWrite(persistenceGeneration);
    } catch (error) {
      transaction.abort();
      throw error;
    }
    // The originating resource lineage is the authority's identity for local
    // adoption; a server-phase admission that knows it must record it or a later
    // cached open reads this record as a foreign lineage and refuses to adopt.
    const origin = input.originLineageHandle ?? adoption?.lineageHandle;
    if (reusable) {
      room.persistence =
        origin && !reusable.originLineageHandle
          ? { ...reusable, originLineageHandle: origin }
          : reusable;
    } else {
      room.persistence = {
        phase: "bindable",
        generation: persistenceGeneration,
        exactDatabaseName,
        ...(origin ? { originLineageHandle: origin } : {}),
      };
    }
    room.documentAdmittedThrough = maximumGeneration(
      room.documentAdmittedThrough,
      input.generation,
    );
    transaction.objectStore(ROOMS).put(room);
    const heads = transaction.objectStore(ACCESS_HEADS);
    const key = accessRecordKey(input.documentId, input.projectId);
    const currentHead = (await requestResult(heads.get(key))) as AccessHeadRecord | undefined;
    heads.put({
      key,
      documentId: input.documentId,
      projectId: input.projectId,
      admittedThrough: maximumGeneration(currentHead?.admittedThrough ?? null, input.generation),
    } satisfies AccessHeadRecord);
    await transactionDone(transaction);
    return { kind: "admitted", persistenceGeneration, exactDatabaseName };
  }

  /** Reserves the document's local copy, or reports the durable state that already owns it. */
  async beginLocalAdoption(input: LocalAdoptionPendingReceipt): Promise<LocalAdoptionState> {
    const database = await this.databasePromise;
    const transaction = database.transaction(ROOMS, "readwrite");
    const rooms = transaction.objectStore(ROOMS);
    const room =
      ((await requestResult(rooms.get(input.documentId))) as RoomOrderRecord | undefined) ??
      emptyRoom(input.documentId);
    const current = room.persistence;
    if (current) {
      transaction.abort();
      if (current.exactDatabaseName !== input.exactDatabaseName) return { kind: "mismatch" };
      if (current.phase === "bindable")
        return sameLineage(current, input) ? { kind: "committed" } : { kind: "mismatch" };
      if (current.lineageHandle !== input.lineageHandle) return { kind: "mismatch" };
      return current.phase === "terminal-local"
        ? { kind: "terminal" }
        : { kind: "reserved", receipt: { ...input, transitionId: current.transitionId } };
    }
    if (room.pendingDrain) {
      transaction.abort();
      throw new Error("Document persistence authority is unavailable for local adoption");
    }
    room.persistence = {
      phase: "adopting-local",
      transitionId: input.transitionId,
      lineageHandle: input.lineageHandle,
      exactDatabaseName: input.exactDatabaseName,
    };
    rooms.put(room);
    await transactionDone(transaction);
    return { kind: "reserved", receipt: input };
  }

  async abortLocalAdoption(input: LocalAdoptionPendingReceipt): Promise<"aborted" | "stale"> {
    const database = await this.databasePromise;
    const transaction = database.transaction(ROOMS, "readwrite");
    const rooms = transaction.objectStore(ROOMS);
    const room = (await requestResult(rooms.get(input.documentId))) as RoomOrderRecord | undefined;
    if (!room || !sameAdoption(room.persistence, input)) {
      transaction.abort();
      return "stale";
    }
    room.persistence = null;
    rooms.put(room);
    await transactionDone(transaction);
    return "aborted";
  }

  async startDocumentDrain(input: {
    documentId: DocumentId;
    generation: AvailabilityGeneration;
    commandId: AvailabilityCommandId;
    deletionVersion: string | null;
  }): Promise<DrainStart> {
    return this.startDrain({ kind: "document", ...input });
  }

  async finishTerminalLineage(input: {
    documentId: DocumentId;
    transitionId: string;
    exactDatabaseName: string;
  }): Promise<boolean> {
    const database = await this.databasePromise;
    const transaction = database.transaction([ROOMS, PURGES], "readwrite");
    const rooms = transaction.objectStore(ROOMS);
    const room = (await requestResult(rooms.get(input.documentId))) as RoomOrderRecord | undefined;
    if (
      room?.persistence?.phase !== "terminal-local" ||
      room.persistence.transitionId !== input.transitionId ||
      room.persistence.exactDatabaseName !== input.exactDatabaseName ||
      room.pendingDrain
    ) {
      transaction.abort();
      return false;
    }
    const purges = transaction.objectStore(PURGES);
    const purge = (await requestResult(
      purges.get(purgeRecordKey(this.accountId, input.documentId)),
    )) as PendingDocumentPurge | undefined;
    if (purge?.transitionId !== input.transitionId) {
      transaction.abort();
      return false;
    }
    room.persistence = null;
    rooms.put(room);
    purges.delete(purge.key);
    await transactionDone(transaction);
    return true;
  }

  async startAccessDrain(input: {
    documentId: DocumentId;
    projectId: ProjectId;
    generation: AvailabilityGeneration;
    commandId: AvailabilityCommandId;
  }): Promise<DrainStart> {
    return this.startDrain({ kind: "access", ...input });
  }

  private async startDrain(
    input:
      | {
          kind: "document";
          documentId: DocumentId;
          generation: AvailabilityGeneration;
          commandId: AvailabilityCommandId;
          deletionVersion: string | null;
        }
      | {
          kind: "access";
          documentId: DocumentId;
          projectId: ProjectId;
          generation: AvailabilityGeneration;
          commandId: AvailabilityCommandId;
        },
  ): Promise<DrainStart> {
    assertAvailabilityGeneration(input.generation);
    const database = await this.databasePromise;
    const transaction = database.transaction(
      [FENCES, ROOMS, ACCESS_HEADS, ACCESS_OUTCOMES],
      "readwrite",
    );
    const rooms = transaction.objectStore(ROOMS);
    const room =
      ((await requestResult(rooms.get(input.documentId))) as RoomOrderRecord | undefined) ??
      emptyRoom(input.documentId);
    if (room.pendingDrain) {
      transaction.abort();
      return { kind: "pending", pending: room.pendingDrain };
    }
    const key =
      input.kind === "document"
        ? documentFenceKey(this.accountId, input.documentId)
        : accessFenceKey(this.accountId, input.projectId, input.documentId);
    const fences = transaction.objectStore(FENCES);
    const current = (await requestResult(fences.get(key))) as FenceRecord | undefined;
    if (current) {
      const comparison = compareAvailabilityGeneration(input.generation, current.revokedThrough);
      if (comparison < 0) {
        transaction.abort();
        return { kind: "older", revokedThrough: current.revokedThrough };
      }
      if (comparison === 0) {
        if (current.commandId !== input.commandId) {
          transaction.abort();
          return { kind: "collision", revokedThrough: current.revokedThrough };
        }
        if (input.kind === "document") {
          transaction.abort();
          return { kind: "replay", revokedThrough: current.revokedThrough, persistence: "cleared" };
        }
        const outcome = (await requestResult(
          transaction
            .objectStore(ACCESS_OUTCOMES)
            .get(accessRecordKey(input.documentId, input.projectId)),
        )) as AccessOutcomeRecord | undefined;
        transaction.abort();
        if (
          !outcome ||
          outcome.generation !== input.generation ||
          outcome.commandId !== input.commandId
        ) {
          throw new Error("Completed access fence is missing its exact outcome");
        }
        return {
          kind: "replay",
          revokedThrough: current.revokedThrough,
          persistence: outcome.persistence,
        };
      }
    }
    const admittedThrough =
      input.kind === "document"
        ? room.documentAdmittedThrough
        : ((
            (await requestResult(
              transaction
                .objectStore(ACCESS_HEADS)
                .get(accessRecordKey(input.documentId, input.projectId)),
            )) as AccessHeadRecord | undefined
          )?.admittedThrough ?? null);
    if (admittedThrough && compareAvailabilityGeneration(input.generation, admittedThrough) < 0) {
      transaction.abort();
      return { kind: "older", revokedThrough: admittedThrough };
    }
    const fence: FenceRecord = {
      key,
      revokedThrough: input.generation,
      commandId: input.commandId,
    };
    fences.put(fence);
    if (input.kind === "access") {
      transaction
        .objectStore(ACCESS_OUTCOMES)
        .delete(accessRecordKey(input.documentId, input.projectId));
    }
    const lineageAuthority =
      input.kind === "document" &&
      ((room.persistence?.phase === "bindable" && room.persistence.originLineageHandle) ||
        room.persistence?.phase === "adopting-local")
        ? room.persistence
        : null;
    const incarnation: DrainPersistenceAuthority | null = lineageAuthority
      ? {
          phase: "bindable",
          generation: lineageAuthority.phase === "bindable" ? lineageAuthority.generation : null,
          exactDatabaseName: lineageAuthority.exactDatabaseName,
          originLineageHandle:
            lineageAuthority.phase === "bindable"
              ? lineageAuthority.originLineageHandle
              : lineageAuthority.lineageHandle,
        }
      : room.persistence?.phase === "bindable"
        ? room.persistence
        : null;
    const { deletionVersion, ...drain } =
      input.kind === "document" ? input : { ...input, deletionVersion: null };
    const pending: PendingDrain = { ...drain, incarnation };
    room.pendingDrain = pending;
    let lineageReceipt: TerminalLineageReceipt | null = null;
    if (lineageAuthority) {
      const lineageHandle =
        lineageAuthority.phase === "bindable"
          ? (lineageAuthority.originLineageHandle as string)
          : lineageAuthority.lineageHandle;
      lineageReceipt = {
        kind: "lineage-transition-required",
        documentId: input.documentId,
        generation: input.generation,
        commandId: input.commandId,
        transitionId: `${input.commandId}:${input.generation}`,
        lineageHandle,
        exactDatabaseName: lineageAuthority.exactDatabaseName,
        persistenceGeneration: incarnation?.generation ?? null,
        deletionVersion,
      };
      room.persistence = {
        phase: "terminal-local",
        transitionId: `${input.commandId}:${input.generation}`,
        lineageHandle,
        exactDatabaseName: lineageAuthority.exactDatabaseName,
        terminalGeneration: input.generation,
        commandId: input.commandId,
        ...(deletionVersion === null ? {} : { deletionVersion }),
      };
    } else if (
      input.kind === "document" &&
      room.persistence?.phase === "bindable" &&
      compareAvailabilityGeneration(room.persistence.generation, input.generation) <= 0
    ) {
      room.persistence = null;
    }
    rooms.put(room);
    await transactionDone(transaction);
    return lineageReceipt ?? { kind: "started", pending };
  }

  async finishDocumentDrain(input: {
    documentId: DocumentId;
    generation: AvailabilityGeneration;
    commandId: AvailabilityCommandId;
  }): Promise<boolean> {
    return this.finishDrain({ kind: "document", ...input, persistence: "cleared" });
  }

  async finishAccessDrain(input: {
    documentId: DocumentId;
    projectId: ProjectId;
    generation: AvailabilityGeneration;
    commandId: AvailabilityCommandId;
    persistence: "cleared" | "retained-by-other-lease";
  }): Promise<boolean> {
    return this.finishDrain({ kind: "access", ...input });
  }

  private async finishDrain(
    input:
      | {
          kind: "document";
          documentId: DocumentId;
          generation: AvailabilityGeneration;
          commandId: AvailabilityCommandId;
          persistence: "cleared";
        }
      | {
          kind: "access";
          documentId: DocumentId;
          projectId: ProjectId;
          generation: AvailabilityGeneration;
          commandId: AvailabilityCommandId;
          persistence: "cleared" | "retained-by-other-lease";
        },
  ): Promise<boolean> {
    const database = await this.databasePromise;
    const transaction = database.transaction([ROOMS, PURGES, ACCESS_OUTCOMES], "readwrite");
    const rooms = transaction.objectStore(ROOMS);
    const room = (await requestResult(rooms.get(input.documentId))) as RoomOrderRecord | undefined;
    const pending = room?.pendingDrain;
    if (
      !room ||
      !pending ||
      pending.kind !== input.kind ||
      pending.generation !== input.generation ||
      pending.commandId !== input.commandId ||
      (pending.kind === "access" &&
        input.kind === "access" &&
        pending.projectId !== input.projectId)
    ) {
      transaction.abort();
      return false;
    }
    room.pendingDrain = null;
    if (input.kind === "access") {
      const key = accessRecordKey(input.documentId, input.projectId);
      transaction.objectStore(ACCESS_OUTCOMES).put({
        key,
        documentId: input.documentId,
        projectId: input.projectId,
        generation: input.generation,
        commandId: input.commandId,
        persistence: input.persistence,
      } satisfies AccessOutcomeRecord);
      if (
        input.persistence === "cleared" &&
        room.persistence?.phase === "bindable" &&
        compareAvailabilityGeneration(room.persistence.generation, input.generation) <= 0
      ) {
        room.persistence = null;
      }
    }
    rooms.put(room);
    if (input.persistence === "cleared" && pending.incarnation) {
      const purges = transaction.objectStore(PURGES);
      const key = purgeRecordKey(this.accountId, input.documentId);
      const current = (await requestResult(purges.get(key))) as PendingDocumentPurge | undefined;
      purges.put({
        key,
        accountId: this.accountId,
        documentId: input.documentId,
        revokedThrough: maximumGeneration(current?.revokedThrough ?? null, input.generation),
        exactDatabaseName: pending.incarnation.exactDatabaseName,
        transitionId:
          room.persistence?.phase === "terminal-local" ? room.persistence.transitionId : undefined,
      } satisfies PendingDocumentPurge);
    }
    await transactionDone(transaction);
    return true;
  }

  async pendingPurges(): Promise<readonly PendingDocumentPurge[]> {
    const database = await this.databasePromise;
    const transaction = database.transaction(PURGES, "readonly");
    const records = (await requestResult(
      transaction.objectStore(PURGES).getAll(),
    )) as PendingDocumentPurge[];
    await transactionDone(transaction);
    return records;
  }

  async snapshotPurge(documentId: DocumentId): Promise<PendingDocumentPurge | null> {
    const { room, pendingPurge } = await this.readResourceSnapshot(documentId);
    return room.pendingDrain ? null : pendingPurge;
  }

  async compareClearPurge(purge: PendingDocumentPurge): Promise<boolean> {
    const database = await this.databasePromise;
    const transaction = database.transaction(PURGES, "readwrite");
    const store = transaction.objectStore(PURGES);
    const current = (await requestResult(store.get(purge.key))) as PendingDocumentPurge | undefined;
    if (!current || current.revokedThrough !== purge.revokedThrough) {
      transaction.abort();
      return false;
    }
    store.delete(purge.key);
    await transactionDone(transaction);
    return true;
  }

  async deletePersistence(pending: PendingDocumentPurge): Promise<boolean> {
    return this.deleteDatabase(pending.exactDatabaseName);
  }

  private deleteDatabase(name: string): Promise<boolean> {
    if (this.blockedDeleteRequests.has(name)) return Promise.resolve(false);
    return new Promise((resolve, reject) => {
      const request = this.idb.deleteDatabase(name);
      let settled = false;
      request.onblocked = () => {
        settled = true;
        this.blockedDeleteRequests.add(name);
        resolve(false);
      };
      request.onerror = () => {
        this.blockedDeleteRequests.delete(name);
        reject(request.error ?? new Error(`Failed to delete IndexedDB ${name}`));
      };
      request.onsuccess = () => {
        this.blockedDeleteRequests.delete(name);
        if (!settled) {
          resolve(true);
          return;
        }
        if (!this.closed) queueMicrotask(this.onPurgeWake);
      };
    });
  }
}
