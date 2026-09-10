/**
 * Untitled reconciler — settles materialization work from the lineage ledger.
 *
 * The lineage ledger is the only durable work source. Input appends identity
 * work; scheduled sweeps resolve homes and server state. Work settles only from
 * an exact nonownership result or the durable canonical publication receipts.
 */

import type {
  AvailabilityGeneration,
  CreateUntitledContextDocumentResponse,
  CreateUntitledContextDocumentResult,
  MoveContextEntryResult,
  MoveContextEntrySuccess,
  ProjectContextIdentityResolution,
  ProjectContextTreeScheme,
} from "@meridian/contracts/protocol";
import * as Y from "yjs";
import type { DocumentSession, DocumentSessionSnapshot } from "@/core/editor/document-session";
import type { DesiredIdentity } from "./identity-location";
import type {
  LocalMaterializationReservation,
  LocalUntitledWorkSnapshot,
} from "./local-untitled-owner";
import type { LiveDocumentBinding, ProjectDocumentLiveOpenResult } from "./open-project-document";
import type { ProjectDocumentOpenResolution } from "./project-context-availability-coordinator";

const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 30_000;
const MAX_MATERIALIZATION_RECEIPTS = 16;

export type UntitledHome = {
  scheme: "scratch";
  workId: string;
  folderPath?: string;
};

export type PendingUntitled = {
  documentId: string;
  projectId: string;
  /** Resolved by a sweep; input can be captured before the works query settles. */
  home?: UntitledHome;
};

export type QueuedIdentityReceipt = MoveContextEntrySuccess & {
  workId?: string;
  routeWorkId: string;
};

type Candidate = {
  onReminted: (documentId: string) => void;
  /** One settled receipt; queued identity is the final tab and route location. */
  onMaterialized: (receipt: MaterializationReceipt) => Promise<boolean>;
};

type MaterializationReceipt = {
  result: CreateUntitledContextDocumentResponse;
  identity?: QueuedIdentityReceipt;
  binding?: LiveDocumentBinding;
};

/**
 * Receipt for a queued desired identity that could not be applied when its
 * document materialized. Held in reconciler state (not a promise) so the
 * identity bar can surface recovery even though the writer's edit session
 * ended when the intent was queued. `conflict` carries the canonical
 * colliding locator (leading-slash path) for Open-existing.
 */
export type QueuedIdentityFailure =
  | {
      kind: "conflict";
      name: string;
      scheme: ProjectContextTreeScheme;
      path: string;
      workId?: string;
    }
  | { kind: "error"; name: string };

type ReconcilerSession = Pick<
  DocumentSession,
  "document" | "fragmentName" | "whenLocalPersistenceSynced" | "waitForDurableSync" | "getSnapshot"
>;

type SchedulerPort = {
  queue(task: () => void): void;
  setTimer(task: () => void, delayMs: number): unknown;
  clearTimer(timer: unknown): void;
  onOnline(task: () => void): () => void;
};

type ApiPort = {
  resolveHome(projectId: string): Promise<UntitledHome | null>;
  create(
    entry: PendingUntitled & { home: UntitledHome },
  ): Promise<CreateUntitledContextDocumentResult>;
  materialized(projectId: string, result: CreateUntitledContextDocumentResponse): Promise<void>;
  confirmCreate(
    entry: PendingUntitled & { home: UntitledHome },
  ): Promise<ProjectDocumentOpenResolution>;
  move(
    entry: PendingUntitled & { home: UntitledHome },
    source: CreateUntitledContextDocumentResponse,
    desired: DesiredIdentity,
  ): Promise<MoveContextEntryResult>;
  lookupGeneration(projectId: string, documentId: string): Promise<AvailabilityGeneration>;
};

export type UntitledReconcilerDeps = {
  scheduler: SchedulerPort;
  api: ApiPort;
  newDocumentId: () => string;
  localOwner: {
    accountId: string;
    list(): readonly LocalUntitledWorkSnapshot[];
    read(projectId: string, documentId: string): LocalUntitledWorkSnapshot | null;
    write(record: LocalUntitledWorkSnapshot): void;
    acknowledgeReconciliation(
      projectId: string,
      documentId: string,
      expectedRevision: number,
    ): Promise<void>;
    acknowledgeFailureCleared(
      projectId: string,
      documentId: string,
      expectedRevision: number,
    ): Promise<void>;
    acknowledgeAdoptionPublication(projectId: string, documentId: string): Promise<void>;
    publishAdoption(
      obligation: NonNullable<LocalUntitledWorkSnapshot["tabPublication"]>,
      result: CreateUntitledContextDocumentResponse,
    ): Promise<"published" | "not-referenced" | "stale">;
    get(projectId: string, documentId: string): ReconcilerSession | null;
    restore(
      projectId: string,
      documentId: string,
    ): Promise<{ session: ReconcilerSession; documentId: string }>;
    retain(ownerId: string, projectId: string, documentId: string): void;
    release(ownerId: string): void;
    revision(projectId: string, documentId: string): number | null;
    prepare(
      projectId: string,
      documentId: string,
      revision: number,
    ): Promise<LocalMaterializationReservation>;
    abort(
      projectId: string,
      documentId: string,
      reservation: LocalMaterializationReservation,
    ): Promise<void>;
    open(input: {
      source: "server" | "local-untitled" | "recover-local-adoption";
      projectId: string;
      documentId: string;
      lineageHandle?: string;
      reservation?: LocalMaterializationReservation;
    }): Promise<ProjectDocumentLiveOpenResult>;
    remint(projectId: string, from: string, to: string): Promise<ReconcilerSession>;
    abandon(projectId: string, documentId: string, revision: number): Promise<void>;
    phase(projectId: string, documentId: string): "local" | "adopted" | null;
  };
};

export function resolveUntitledHome(activeWorkId: string | null): UntitledHome | null {
  return activeWorkId ? { scheme: "scratch", workId: activeWorkId } : null;
}

export type ReconciliationRecord = {
  projectId: string;
  documentId: string;
  /** Monotonic guard for work captured across asynchronous boundaries. */
  revision: number;
  materialization: { phase: "pending"; entry: PendingUntitled } | { phase: "synced" };
  desiredIdentity?: DesiredIdentity;
  createSettlement:
    | { kind: "ready" }
    | { kind: "confirmation-required" }
    | { kind: "confirmed"; result: CreateUntitledContextDocumentResponse };
  failure?: QueuedIdentityFailure;
  /** Epoch ms for device-only grace; meaningful only while pending. */
  pendingSinceMs: number | null;
};

export class UntitledReconciler {
  private readonly records = new Map<string, ReconciliationRecord>();
  private readonly candidates = new Map<string, Candidate>();
  private readonly materializationReceipts = new Map<string, MaterializationReceipt>();
  private materializationReceiptOwners = new Set<string>();
  private running = false;
  private scheduled = false;
  private started = false;
  private retryMs = RETRY_BASE_MS;
  private retryTimer: unknown = null;
  private removeOnlineListener: (() => void) | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly deps: UntitledReconcilerDeps) {}

  private key(projectId: string, documentId: string): string {
    return [this.deps.localOwner.accountId, projectId, documentId]
      .map((part) => encodeURIComponent(part))
      .join(":");
  }

  /** Loads durable records before the tab desk filters provisional tabs. */
  rehydrate(): void {
    for (const durable of this.deps.localOwner.list()) {
      if (durable.phase === "adopted" && !durable.canonicalSync && !durable.tabPublication)
        continue;
      const record = fromDurableRecord(durable);
      this.records.set(this.key(record.projectId, record.documentId), record);
    }
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.rehydrate();
    this.removeOnlineListener = this.deps.scheduler.onOnline(this.schedule);
    this.emit();
    this.schedule();
  }

  dispose(): void {
    if (!this.started) return;
    this.started = false;
    this.removeOnlineListener?.();
    this.removeOnlineListener = null;
    if (this.retryTimer !== null) this.deps.scheduler.clearTimer(this.retryTimer);
    this.retryTimer = null;
    this.scheduled = false;
  }

  registerCandidate(projectId: string, documentId: string, candidate: Candidate): () => void {
    const key = this.key(projectId, documentId);
    this.candidates.set(key, candidate);
    const receipt = this.materializationReceipts.get(key);
    if (receipt) {
      this.materializationReceipts.delete(key);
      void this.publishMaterialization(candidate, receipt);
    }
    return () => {
      if (this.candidates.get(key) === candidate) this.candidates.delete(key);
    };
  }

  setMaterializationReceiptOwners(entries: Iterable<PendingUntitled>): void {
    this.materializationReceiptOwners = new Set(
      [...entries].map((entry) => this.key(entry.projectId, entry.documentId)),
    );
    this.evictUnreferencedMaterializationReceipts();
  }

  append(entry: PendingUntitled): void {
    if (!this.deps.localOwner.read(entry.projectId, entry.documentId)) {
      throw new Error("Local Untitled must be owned before materialization work is appended");
    }
    const key = this.key(entry.projectId, entry.documentId);
    const current = this.records.get(key);
    if (current?.materialization.phase === "pending") {
      if (current.materialization.entry.home || !entry.home) return;
      this.records.set(key, {
        ...current,
        revision: current.revision + 1,
        materialization: { phase: "pending", entry },
        pendingSinceMs: current.pendingSinceMs ?? Date.now(),
      });
      this.persistAndEmit();
      this.schedule();
      return;
    }
    this.records.set(key, {
      projectId: entry.projectId,
      documentId: entry.documentId,
      revision: (current?.revision ?? 0) + 1,
      materialization: { phase: "pending", entry },
      createSettlement: current?.createSettlement ?? { kind: "ready" },
      desiredIdentity: current?.desiredIdentity,
      failure: current?.failure,
      pendingSinceMs: current?.pendingSinceMs ?? Date.now(),
    });
    this.persistAndEmit();
    this.schedule();
  }

  has(projectId: string, documentId: string): boolean {
    return this.records.get(this.key(projectId, documentId))?.materialization.phase === "pending";
  }

  pendingSince(projectId: string, documentId: string): number | null {
    const record = this.records.get(this.key(projectId, documentId));
    return record?.materialization.phase === "pending" ? record.pendingSinceMs : null;
  }

  queuedIdentityFailure(projectId: string, documentId: string): QueuedIdentityFailure | null {
    return this.records.get(this.key(projectId, documentId))?.failure ?? null;
  }

  clearQueuedIdentityFailure(projectId: string, documentId: string): void {
    const key = this.key(projectId, documentId);
    const record = this.records.get(key);
    if (!record?.failure) return;
    const next = { ...record, failure: undefined };
    if (next.materialization.phase === "synced" && !next.desiredIdentity) {
      this.records.delete(key);
      const durable = this.deps.localOwner.read(projectId, documentId);
      if (durable)
        this.deps.localOwner.acknowledgeFailureCleared(projectId, documentId, durable.revision);
    } else {
      this.records.set(key, { ...next, revision: record.revision + 1 });
    }
    this.persistAndEmit();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Last explicit writer identity wins and is durable before this returns. */
  queueIdentity(entry: PendingUntitled, desiredIdentity: DesiredIdentity): void {
    const key = this.key(entry.projectId, entry.documentId);
    const current = this.records.get(key);
    const materialization =
      current?.materialization.phase === "pending"
        ? current.materialization
        : { phase: "pending" as const, entry };
    this.records.set(key, {
      ...current,
      projectId: entry.projectId,
      documentId: entry.documentId,
      revision: (current?.revision ?? 0) + 1,
      materialization,
      createSettlement: current?.createSettlement ?? { kind: "ready" },
      desiredIdentity,
      failure: undefined,
      pendingSinceMs: current?.pendingSinceMs ?? Date.now(),
    });
    this.persistAndEmit();
    this.schedule();
  }

  readonly schedule = (): void => {
    if (!this.started || !this.hasPendingWork() || this.scheduled) return;
    this.scheduled = true;
    this.deps.scheduler.queue(() => {
      this.scheduled = false;
      void this.sweep();
    });
  };

  private hasPendingWork(): boolean {
    return [...this.records.values()].some((record) => record.materialization.phase === "pending");
  }

  private async sweep(): Promise<void> {
    if (!this.started || this.running || !this.hasPendingWork()) return;
    this.running = true;
    let failed = false;
    try {
      const pendingKeys = [...this.records.entries()]
        .filter(([, record]) => record.materialization.phase === "pending")
        .map(([key]) => key);
      for (const key of pendingKeys) {
        if (!this.started) break;
        try {
          await this.reconcile(key);
        } catch {
          failed = true;
        }
      }
    } finally {
      this.running = false;
    }
    if (!this.started) return;
    if (failed && this.hasPendingWork()) this.armRetry();
    else {
      this.retryMs = RETRY_BASE_MS;
      if (this.hasPendingWork()) this.schedule();
    }
  }

  private async reconcile(key: string): Promise<void> {
    let record = this.pendingRecord(key);
    if (!record) return;
    const entry = record.materialization.entry;
    const home = entry.home ?? (await this.deps.api.resolveHome(entry.projectId));
    if (!home) throw new Error("Untitled home is not available yet");
    record = this.pendingRecord(key);
    if (!record) return;
    if (!record.materialization.entry.home) {
      record = {
        ...record,
        revision: record.revision + 1,
        materialization: {
          phase: "pending",
          entry: { ...record.materialization.entry, home },
        },
      };
      this.records.set(key, record);
      this.persist();
    }
    const resolvedEntry = record.materialization.entry as PendingUntitled & {
      home: UntitledHome;
    };

    await this.reconcileOwned(resolvedEntry);
  }

  private async reconcileOwned(entry: PendingUntitled & { home: UntitledHome }): Promise<void> {
    const local = this.deps.localOwner;
    const { documentId, projectId } = entry;
    const key = this.key(projectId, documentId);
    const ownerId = `untitled-reconciler:${key}`;
    const phase = local.phase(projectId, documentId);
    if (phase === "adopted") {
      const current = this.pendingRecord(key);
      let publicationResult =
        current?.createSettlement.kind === "confirmed"
          ? current.createSettlement.result
          : undefined;
      if (current?.desiredIdentity && publicationResult) {
        const identity = await this.applyDesiredIdentity(key, entry, publicationResult);
        publicationResult = identity.result;
        const receipt = { result: identity.result, identity: identity.identity };
        const candidate = this.candidates.get(key);
        if (!(candidate && (await this.publishMaterialization(candidate, receipt))))
          this.rememberMaterializationReceipt(key, receipt);
      }
      const lineage = local.read(projectId, documentId);
      if (!lineage) return;
      if (lineage.tabPublication) {
        if (!publicationResult)
          throw new Error("Adoption publication is missing its confirmed canonical identity");
        const publication = await local.publishAdoption(lineage.tabPublication, publicationResult);
        if (publication === "stale") throw new Error("Adoption publication is stale");
        await local.acknowledgeAdoptionPublication(projectId, documentId);
      }
      const opened = await local.open({
        source: "recover-local-adoption",
        lineageHandle: lineage.ref.lineageHandle,
        ...entry,
      });
      if (opened.kind !== "opened") throw new Error("Adopted Untitled could not reopen live");
      const binding = await opened.admission.bind(ownerId);
      try {
        await binding.session.waitForDurableSync();
        if (binding.session.getSnapshot().status !== "synced")
          throw syncFailure(binding.session.getSnapshot());
        const record = this.pendingRecord(key);
        if (record) this.drain(key, record.revision);
      } finally {
        binding.release();
      }
      return;
    }
    let session = local.get(projectId, documentId);
    if (!session) {
      const restored = await local.restore(projectId, documentId);
      if (restored.documentId !== documentId) {
        this.redirectOwnedRecord(key, entry, restored.documentId);
        return;
      }
      session = restored.session;
    }
    local.retain(ownerId, projectId, documentId);
    try {
      await session.whenLocalPersistenceSynced();
      let record = this.pendingRecord(key);
      if (!record) return;
      const empty = untitledDocumentIsEmpty(session.document.getXmlFragment(session.fragmentName));
      let confirmedResult: CreateUntitledContextDocumentResponse | undefined;
      if (
        record.createSettlement.kind === "ready" &&
        empty &&
        !record.desiredIdentity &&
        !this.candidates.has(key)
      ) {
        const checkedRevision = record.revision;
        const confirmation = await this.deps.api.confirmCreate(entry);
        if (confirmation.kind === "not-visible") {
          local.release(ownerId);
          await local.abandon(projectId, documentId, local.revision(projectId, documentId) ?? -1);
          this.drain(key, checkedRevision);
          return;
        }
        if (confirmation.kind !== "available") {
          throw new Error(`Untitled create confirmation is ${confirmation.kind}`);
        }
        confirmedResult = createResultFromAvailability(confirmation);
      }

      const ownerRevision = local.revision(projectId, documentId);
      if (ownerRevision === null) throw new Error("Local Untitled owner record disappeared");
      const reservation = await local.prepare(projectId, documentId, ownerRevision);
      let result: CreateUntitledContextDocumentResult;
      if (record.createSettlement.kind === "confirmed") {
        result = record.createSettlement.result;
      } else if (confirmedResult) {
        result = confirmedResult;
      } else if (record.createSettlement.kind === "confirmation-required") {
        const confirmation = await this.deps.api.confirmCreate(entry);
        if (confirmation.kind === "not-visible") {
          await local.abort(projectId, documentId, reservation);
          this.records.set(key, { ...record, createSettlement: { kind: "ready" } });
          this.persistExact(key);
          throw new Error("Untitled create definitely did not commit");
        }
        if (confirmation.kind !== "available") {
          throw new Error(`Untitled create confirmation is ${confirmation.kind}`);
        }
        result = createResultFromAvailability(confirmation);
      } else {
        record = { ...record, createSettlement: { kind: "confirmation-required" } };
        this.records.set(key, record);
        this.persistExact(key);
        result = await this.deps.api.create(entry);
      }
      if (result.status === "conflict") {
        await local.abort(projectId, documentId, reservation);
        await this.remintOwned(key, entry);
        return;
      }
      record = this.pendingRecord(key);
      if (!record) return;
      record = { ...record, createSettlement: { kind: "confirmed", result } };
      this.records.set(key, record);
      this.persistExact(key);
      await this.deps.api.materialized(projectId, result);
      const identity = await this.applyDesiredIdentity(key, entry, result);
      const latestAfterIdentity = this.records.get(key);
      if (latestAfterIdentity) {
        this.records.set(key, {
          ...latestAfterIdentity,
          createSettlement: { kind: "confirmed", result: identity.result },
        });
        this.persistExact(key);
      }
      const opened = await local.open({
        source: "local-untitled",
        projectId,
        documentId,
        reservation,
      });
      if (opened.kind !== "opened") throw new Error("Materialized Untitled was not admitted");
      const binding = await opened.admission.bind(ownerId);
      const receipt = { result: identity.result, identity: identity.identity, binding };
      const candidate = this.candidates.get(key);
      if (!(candidate && (await this.publishMaterialization(candidate, receipt))))
        this.rememberMaterializationReceipt(key, receipt);
      const adopted = local.read(projectId, documentId);
      if (adopted?.tabPublication) {
        const publication = await local.publishAdoption(adopted.tabPublication, identity.result);
        if (publication === "stale") throw new Error("Adoption publication is stale");
        await local.acknowledgeAdoptionPublication(projectId, documentId);
      }
      try {
        await binding.session.waitForDurableSync();
        const snapshot = binding.session.getSnapshot();
        if (snapshot.status !== "synced") throw syncFailure(snapshot);
        this.drain(key, identity.revision);
      } finally {
        if (!candidate) binding.release();
      }
    } finally {
      local.release(ownerId);
    }
  }

  private async remintOwned(
    key: string,
    entry: PendingUntitled & { home: UntitledHome },
  ): Promise<void> {
    const local = this.deps.localOwner;
    let replacementId = this.deps.newDocumentId();
    for (;;) {
      try {
        await local.remint(entry.projectId, entry.documentId, replacementId);
        break;
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes("owned elsewhere")) throw error;
        replacementId = this.deps.newDocumentId();
      }
    }
    this.redirectOwnedRecord(key, entry, replacementId);
  }

  private redirectOwnedRecord(
    key: string,
    entry: PendingUntitled & { home: UntitledHome },
    replacementId: string,
  ): void {
    const replacementKey = this.key(entry.projectId, replacementId);
    const record = this.records.get(key);
    if (!record) return;
    const candidate = this.candidates.get(key);
    this.records.delete(key);
    this.records.set(replacementKey, {
      ...record,
      documentId: replacementId,
      revision: record.revision + 1,
      materialization: { phase: "pending", entry: { ...entry, documentId: replacementId } },
      createSettlement: { kind: "ready" },
    });
    this.candidates.delete(key);
    if (candidate) this.candidates.set(replacementKey, candidate);
    const receipt = this.materializationReceipts.get(key);
    this.materializationReceipts.delete(key);
    if (receipt) this.materializationReceipts.set(replacementKey, receipt);
    if (this.materializationReceiptOwners.delete(key))
      this.materializationReceiptOwners.add(replacementKey);
    this.persistAndEmit();
    candidate?.onReminted(replacementId);
  }

  private async applyDesiredIdentity(
    key: string,
    entry: PendingUntitled & { home: UntitledHome },
    result: CreateUntitledContextDocumentResponse,
  ): Promise<{
    revision: number;
    result: CreateUntitledContextDocumentResponse;
    identity?: QueuedIdentityReceipt;
  }> {
    const record = this.records.get(key);
    const desired = record?.desiredIdentity;
    if (!record) return { revision: -1, result };
    if (!desired) return { revision: record.revision, result };
    const attemptRevision = record.revision;
    try {
      const moved = await this.deps.api.move(entry, result, desired);
      if (moved.status === "retry") throw new Error(`Context move needs retry: ${moved.reason}`);
      if (moved.status === "conflict") {
        const finished = this.finishIdentityAttempt(key, attemptRevision, {
          kind: "conflict",
          name: desired.name,
          scheme: moved.collision.scheme,
          path: `/${moved.collision.path}`,
          ...(moved.collision.authority.kind === "work"
            ? { workId: moved.collision.authority.workId }
            : {}),
        });
        return { revision: finished ? attemptRevision + 1 : attemptRevision, result };
      }
      const finished = this.finishIdentityAttempt(key, attemptRevision);
      const identity: QueuedIdentityReceipt = {
        ...moved,
        path: `/${moved.path}`,
        ...(desired.destination.workId ? { workId: desired.destination.workId } : {}),
        routeWorkId: desired.destination.workId ?? entry.home.workId,
      };
      return {
        revision: finished ? attemptRevision + 1 : attemptRevision,
        result: {
          status: "already-materialized",
          documentId: entry.documentId,
          scheme: moved.scheme,
          path: `/${moved.path}`,
          name: moved.name,
          ...(desired.destination.workId ? { workId: desired.destination.workId } : {}),
        },
        ...(finished ? { identity } : {}),
      };
    } catch (error) {
      if (!isTerminalIdentityError(error)) throw error;
      const finished = this.finishIdentityAttempt(key, attemptRevision, {
        kind: "error",
        name: desired.name,
      });
      return { revision: finished ? attemptRevision + 1 : attemptRevision, result };
    }
  }

  private finishIdentityAttempt(
    key: string,
    attemptRevision: number,
    failure?: QueuedIdentityFailure,
  ): boolean {
    const record = this.records.get(key);
    if (!record || record.revision !== attemptRevision) return false;
    this.records.set(key, {
      ...record,
      revision: record.revision + 1,
      desiredIdentity: undefined,
      failure,
    });
    this.persistAndEmit();
    return true;
  }

  private publishMaterialization(
    candidate: Candidate,
    receipt: MaterializationReceipt,
  ): Promise<boolean> {
    return candidate.onMaterialized(receipt);
  }

  private rememberMaterializationReceipt(key: string, receipt: MaterializationReceipt): void {
    this.materializationReceipts.delete(key);
    this.materializationReceipts.set(key, receipt);
    this.evictUnreferencedMaterializationReceipts();
  }

  private evictUnreferencedMaterializationReceipts(): void {
    let unreferencedCount = 0;
    for (const key of this.materializationReceipts.keys()) {
      if (!this.materializationReceiptOwners.has(key)) unreferencedCount += 1;
    }
    if (unreferencedCount <= MAX_MATERIALIZATION_RECEIPTS) return;

    for (const key of this.materializationReceipts.keys()) {
      if (this.materializationReceiptOwners.has(key)) continue;
      this.materializationReceipts.delete(key);
      unreferencedCount -= 1;
      if (unreferencedCount === MAX_MATERIALIZATION_RECEIPTS) return;
    }
  }

  private drain(key: string, processedRevision: number): void {
    const record = this.records.get(key);
    if (!record || record.revision !== processedRevision) return;
    const durable = this.deps.localOwner.read(record.projectId, record.documentId);
    if (durable)
      void this.deps.localOwner.acknowledgeReconciliation(
        record.projectId,
        record.documentId,
        durable.revision,
      );
    if (record.failure) {
      this.records.set(key, {
        ...record,
        revision: record.revision + 1,
        desiredIdentity: undefined,
        materialization: { phase: "synced" },
        pendingSinceMs: null,
      });
    } else {
      this.records.delete(key);
    }
    this.persistAndEmit();
  }

  private pendingRecord(key: string):
    | (ReconciliationRecord & {
        materialization: { phase: "pending"; entry: PendingUntitled };
      })
    | null {
    const record = this.records.get(key);
    return record?.materialization.phase === "pending"
      ? (record as ReconciliationRecord & {
          materialization: { phase: "pending"; entry: PendingUntitled };
        })
      : null;
  }

  private persist(): void {
    for (const record of this.records.values()) {
      const entry =
        record.materialization.phase === "pending" ? record.materialization.entry : null;
      const base = this.deps.localOwner.read(record.projectId, record.documentId);
      if (!base) continue;
      this.deps.localOwner.write({
        ...base,
        work: {
          ...base.work,
          workRevision: record.revision,
          home: entry?.home ?? base.work.home,
          desiredIdentity: record.desiredIdentity,
          createSettlement: record.createSettlement,
          failure: record.failure,
          pendingSinceMs: record.pendingSinceMs,
        },
      });
    }
  }

  private persistExact(key: string): void {
    const record = this.records.get(key);
    if (!record) return;
    const entry = record.materialization.phase === "pending" ? record.materialization.entry : null;
    const base = this.deps.localOwner.read(record.projectId, record.documentId);
    if (!base) return;
    this.deps.localOwner.write({
      ...base,
      work: {
        ...base.work,
        workRevision: record.revision,
        home: entry?.home ?? base.work.home,
        desiredIdentity: record.desiredIdentity,
        createSettlement: record.createSettlement,
        failure: record.failure,
        pendingSinceMs: record.pendingSinceMs,
      },
    });
  }

  private persistAndEmit(): void {
    this.persist();
    this.emit();
  }

  private armRetry(): void {
    if (this.retryTimer !== null) return;
    this.retryTimer = this.deps.scheduler.setTimer(() => {
      this.retryTimer = null;
      this.schedule();
    }, this.retryMs);
    this.retryMs = Math.min(this.retryMs * 2, RETRY_MAX_MS);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

function isTerminalIdentityError(error: unknown): error is { retryable: false } {
  if (typeof error !== "object" || error === null) return false;
  if ("status" in error && typeof error.status === "number") {
    return error.status >= 400 && error.status < 500;
  }
  return "retryable" in error && error.retryable === false;
}

function syncFailure(snapshot: DocumentSessionSnapshot): Error {
  if (snapshot.status === "access-lost") {
    return new Error("Untitled document access is temporarily unavailable");
  }
  return new Error("Untitled document not durably synced");
}

function fromDurableRecord(record: LocalUntitledWorkSnapshot): ReconciliationRecord {
  const pending =
    (record.phase === "adopted" && (!!record.canonicalSync || !!record.tabPublication)) ||
    record.work.home !== null ||
    record.work.pendingSinceMs !== null ||
    record.work.desiredIdentity !== undefined;
  return {
    projectId: record.key.projectId,
    documentId: record.key.documentId,
    revision: record.work.workRevision,
    materialization: pending
      ? {
          phase: "pending",
          entry: {
            documentId: record.key.documentId,
            projectId: record.key.projectId,
            ...(record.work.home ? { home: record.work.home } : {}),
          },
        }
      : { phase: "synced" },
    desiredIdentity: record.work.desiredIdentity,
    createSettlement: record.work.createSettlement,
    failure: record.work.failure,
    pendingSinceMs: record.work.pendingSinceMs,
  };
}

function createResultFromAvailability(
  resolution: Extract<ProjectContextIdentityResolution, { kind: "available" }>,
): CreateUntitledContextDocumentResponse {
  const scheme = resolution.entry.uri.slice(
    0,
    resolution.entry.uri.indexOf(":"),
  ) as CreateUntitledContextDocumentResponse["scheme"];
  return {
    status: "already-materialized",
    documentId: resolution.documentId,
    scheme,
    path: `/${resolution.entry.path.join("/")}`,
    name: resolution.entry.name,
    ...(resolution.entry.scope.kind === "work" ? { workId: resolution.entry.scope.workId } : {}),
  };
}

export function untitledDocumentIsEmpty(fragment: Y.XmlFragment): boolean {
  return !fragment.toArray().some(nodeHasContent);
}

function nodeHasContent(value: unknown): boolean {
  if (value instanceof Y.XmlText) return value.toString().length > 0;
  if (value instanceof Y.XmlElement) {
    if (!["doc", "paragraph", "heading"].includes(value.nodeName)) return true;
    return value.toArray().some(nodeHasContent);
  }
  return typeof value === "string" && value.length > 0;
}
