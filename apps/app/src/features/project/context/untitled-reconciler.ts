/**
 * Untitled reconciler — drains the crash-safe list of locally-authored documents.
 *
 * The persisted registry is the only work source. Input only appends an id;
 * network, IndexedDB, and home resolution happen in scheduled sweeps. A pending
 * entry is removed only after an explicit no-row check or a durable server ack.
 */

import type {
  CreateUntitledContextDocumentResponse,
  CreateUntitledContextDocumentResult,
  MoveContextEntryResult,
  MoveContextEntrySuccess,
  ProjectContextTreeScheme,
} from "@meridian/contracts/protocol";
import { isProjectContextTreeScheme } from "@meridian/contracts/protocol";
import * as Y from "yjs";
import type { DocumentSession, DocumentSessionSnapshot } from "@/core/editor/document-session";
import type { DesiredIdentity } from "./identity-location";

const STORAGE_KEY = "meridian:pending-untitled";
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 30_000;

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

type Candidate = {
  onReminted: (documentId: string) => void;
  onMaterialized: (result: CreateUntitledContextDocumentResponse) => void;
  /** Queued desired identity landed after materialization. */
  onIdentityCommitted?: (result: MoveContextEntrySuccess) => void;
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
  | "document"
  | "fragmentName"
  | "whenLocalPersistenceSynced"
  | "flushLocalPersistence"
  | "waitForDurableSync"
  | "getSnapshot"
>;

type SessionRegistryPort = {
  getDetached(documentId: string): ReconcilerSession;
  attachDetached(documentId: string): ReconcilerSession;
  restartUnavailableRoom(documentId: string): Promise<boolean>;
  retain(owner: string, ids: Iterable<string>): void;
  release(owner: string): void;
  destroyRoom(documentId: string, options?: { clearPersistence?: boolean }): Promise<void>;
};

type StoragePort = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

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
  serverDocumentExists(entry: PendingUntitled & { home: UntitledHome }): Promise<boolean>;
  move(
    entry: PendingUntitled & { home: UntitledHome },
    source: CreateUntitledContextDocumentResponse,
    desired: DesiredIdentity,
  ): Promise<MoveContextEntryResult>;
};

export type UntitledReconcilerDeps = {
  storage: StoragePort;
  scheduler: SchedulerPort;
  api: ApiPort;
  sessions: SessionRegistryPort;
  newDocumentId: () => string;
};

export function resolveUntitledHome(activeWorkId: string | null): UntitledHome | null {
  return activeWorkId ? { scheme: "scratch", workId: activeWorkId } : null;
}

export type ReconciliationRecord = {
  documentId: string;
  /** Monotonic guard for work captured across asynchronous boundaries. */
  revision: number;
  materialization: { phase: "pending"; entry: PendingUntitled } | { phase: "synced" };
  desiredIdentity?: DesiredIdentity;
  failure?: QueuedIdentityFailure;
  /** Epoch ms for device-only grace; meaningful only while pending. */
  pendingSinceMs: number | null;
};

export class UntitledReconciler {
  private readonly records = new Map<string, ReconciliationRecord>();
  private readonly candidates = new Map<string, Candidate>();
  private running = false;
  private scheduled = false;
  private started = false;
  private retryMs = RETRY_BASE_MS;
  private retryTimer: unknown = null;
  private removeOnlineListener: (() => void) | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly deps: UntitledReconcilerDeps) {}

  /** Loads durable records before the tab desk filters provisional tabs. */
  rehydrate(): void {
    for (const record of readRegistry(this.deps.storage)) {
      if (!this.records.has(record.documentId)) this.records.set(record.documentId, record);
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

  registerCandidate(documentId: string, candidate: Candidate): () => void {
    this.candidates.set(documentId, candidate);
    return () => {
      if (this.candidates.get(documentId) === candidate) this.candidates.delete(documentId);
    };
  }

  append(entry: PendingUntitled): void {
    const current = this.records.get(entry.documentId);
    if (current?.materialization.phase === "pending") return;
    this.records.set(entry.documentId, {
      documentId: entry.documentId,
      revision: (current?.revision ?? 0) + 1,
      materialization: { phase: "pending", entry },
      desiredIdentity: current?.desiredIdentity,
      failure: current?.failure,
      pendingSinceMs: current?.pendingSinceMs ?? Date.now(),
    });
    this.persistAndEmit();
    this.schedule();
  }

  has(documentId: string): boolean {
    return this.records.get(documentId)?.materialization.phase === "pending";
  }

  pendingSince(documentId: string): number | null {
    const record = this.records.get(documentId);
    return record?.materialization.phase === "pending" ? record.pendingSinceMs : null;
  }

  queuedIdentityFailure(documentId: string): QueuedIdentityFailure | null {
    return this.records.get(documentId)?.failure ?? null;
  }

  clearQueuedIdentityFailure(documentId: string): void {
    const record = this.records.get(documentId);
    if (!record?.failure) return;
    const next = { ...record, failure: undefined };
    if (next.materialization.phase === "synced" && !next.desiredIdentity) {
      this.records.delete(documentId);
    } else {
      this.records.set(documentId, { ...next, revision: record.revision + 1 });
    }
    this.persistAndEmit();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Last explicit writer identity wins and is durable before this returns. */
  queueIdentity(entry: PendingUntitled, desiredIdentity: DesiredIdentity): void {
    const current = this.records.get(entry.documentId);
    const materialization =
      current?.materialization.phase === "pending"
        ? current.materialization
        : { phase: "pending" as const, entry };
    this.records.set(entry.documentId, {
      ...current,
      documentId: entry.documentId,
      revision: (current?.revision ?? 0) + 1,
      materialization,
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
      const pendingDocumentIds = [...this.records.values()]
        .filter((record) => record.materialization.phase === "pending")
        .map((record) => record.documentId);
      for (const documentId of pendingDocumentIds) {
        if (!this.started) break;
        try {
          await this.reconcile(documentId);
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

  private async reconcile(documentId: string): Promise<void> {
    let record = this.pendingRecord(documentId);
    if (!record) return;
    const entry = record.materialization.entry;
    const home = entry.home ?? (await this.deps.api.resolveHome(entry.projectId));
    if (!home) throw new Error("Untitled home is not available yet");
    record = this.pendingRecord(documentId);
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
      this.records.set(documentId, record);
      this.persist();
    }
    const resolvedEntry = record.materialization.entry as PendingUntitled & {
      home: UntitledHome;
    };

    const owner = `untitled-reconciler:${documentId}`;
    const session = this.deps.sessions.getDetached(documentId);
    this.deps.sessions.retain(owner, [documentId]);
    try {
      await session.whenLocalPersistenceSynced();
      record = this.pendingRecord(documentId);
      if (!record) return;
      const empty = untitledDocumentIsEmpty(session.document.getXmlFragment(session.fragmentName));
      if (empty && !record.desiredIdentity) {
        const emptyCheckRevision = record.revision;
        const exists = await this.deps.api.serverDocumentExists(resolvedEntry);
        record = this.pendingRecord(documentId);
        if (!record) return;
        if (!exists && !record.desiredIdentity && record.revision === emptyCheckRevision) {
          await this.drain(documentId, emptyCheckRevision, true);
          return;
        }
      }

      const result = await this.deps.api.create(resolvedEntry);
      if (result.status === "conflict") {
        await this.remint(resolvedEntry, session);
        return;
      }
      record = this.pendingRecord(documentId);
      if (!record) return;
      this.candidates.get(documentId)?.onMaterialized(result);
      const processedRevision = await this.applyDesiredIdentity(resolvedEntry, result);

      record = this.pendingRecord(documentId);
      if (!record) return;
      await this.deps.sessions.restartUnavailableRoom(documentId);
      record = this.pendingRecord(documentId);
      if (!record) return;
      const attached = this.deps.sessions.attachDetached(documentId);
      await attached.waitForDurableSync();
      const snapshot = attached.getSnapshot();
      if (snapshot.status !== "synced") throw syncFailure(snapshot);
      await this.drain(documentId, processedRevision, false);
    } finally {
      this.deps.sessions.release(owner);
    }
  }

  private async applyDesiredIdentity(
    entry: PendingUntitled & { home: UntitledHome },
    result: CreateUntitledContextDocumentResponse,
  ): Promise<number> {
    const record = this.records.get(entry.documentId);
    const desired = record?.desiredIdentity;
    if (!record) return -1;
    if (!desired) return record.revision;
    const attemptRevision = record.revision;
    try {
      const moved = await this.deps.api.move(entry, result, desired);
      if (moved.status === "retry") throw new Error(`Context move needs retry: ${moved.reason}`);
      if (moved.status === "conflict") {
        const finished = this.finishIdentityAttempt(entry.documentId, attemptRevision, {
          kind: "conflict",
          name: desired.name,
          scheme: moved.collision.scheme,
          path: `/${moved.collision.path}`,
          ...(moved.collision.workId ? { workId: moved.collision.workId } : {}),
        });
        return finished ? attemptRevision + 1 : attemptRevision;
      }
      const finished = this.finishIdentityAttempt(entry.documentId, attemptRevision);
      if (finished) {
        this.candidates.get(entry.documentId)?.onIdentityCommitted?.({
          ...moved,
          path: `/${moved.path}`,
        });
      }
      return finished ? attemptRevision + 1 : attemptRevision;
    } catch {
      const finished = this.finishIdentityAttempt(entry.documentId, attemptRevision, {
        kind: "error",
        name: desired.name,
      });
      return finished ? attemptRevision + 1 : attemptRevision;
    }
  }

  private finishIdentityAttempt(
    documentId: string,
    attemptRevision: number,
    failure?: QueuedIdentityFailure,
  ): boolean {
    const record = this.records.get(documentId);
    if (!record || record.revision !== attemptRevision) return false;
    this.records.set(documentId, {
      ...record,
      revision: record.revision + 1,
      desiredIdentity: undefined,
      failure,
    });
    this.persistAndEmit();
    return true;
  }

  private async remint(
    entry: PendingUntitled & { home: UntitledHome },
    session: ReconcilerSession,
  ): Promise<void> {
    const replacementId = this.deps.newDocumentId();
    const replacement = this.deps.sessions.getDetached(replacementId);
    await replacement.whenLocalPersistenceSynced();
    Y.applyUpdate(replacement.document, Y.encodeStateAsUpdate(session.document));
    await replacement.flushLocalPersistence();

    const record = this.records.get(entry.documentId);
    if (!record) return;
    const candidate = this.candidates.get(entry.documentId);
    this.records.delete(entry.documentId);
    this.records.set(replacementId, {
      ...record,
      documentId: replacementId,
      revision: record.revision + 1,
      materialization: {
        phase: "pending",
        entry: { ...entry, documentId: replacementId },
      },
    });
    this.candidates.delete(entry.documentId);
    if (candidate) this.candidates.set(replacementId, candidate);
    this.persistAndEmit();
    candidate?.onReminted(replacementId);
  }

  private async drain(
    documentId: string,
    processedRevision: number,
    clearPersistence: boolean,
  ): Promise<void> {
    const record = this.records.get(documentId);
    if (!record || record.revision !== processedRevision) return;
    if (record?.failure) {
      this.records.set(documentId, {
        ...record,
        revision: record.revision + 1,
        desiredIdentity: undefined,
        materialization: { phase: "synced" },
        pendingSinceMs: null,
      });
    } else {
      this.records.delete(documentId);
    }
    this.persistAndEmit();
    if (clearPersistence) {
      await this.deps.sessions.destroyRoom(documentId, { clearPersistence: true });
    }
  }

  private pendingRecord(documentId: string):
    | (ReconciliationRecord & {
        materialization: { phase: "pending"; entry: PendingUntitled };
      })
    | null {
    const record = this.records.get(documentId);
    return record?.materialization.phase === "pending"
      ? (record as ReconciliationRecord & {
          materialization: { phase: "pending"; entry: PendingUntitled };
        })
      : null;
  }

  private persist(): void {
    this.deps.storage.setItem(STORAGE_KEY, JSON.stringify([...this.records.values()]));
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

function syncFailure(snapshot: DocumentSessionSnapshot): Error {
  if (snapshot.status === "access-lost") {
    return new Error("Untitled document access is temporarily unavailable");
  }
  return new Error("Untitled document not durably synced");
}

function readRegistry(storage: StoragePort): ReconciliationRecord[] {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(STORAGE_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isReconciliationRecord).map((record) => ({
      ...record,
      revision: record.revision ?? 0,
    }));
  } catch {
    return [];
  }
}

function isReconciliationRecord(value: unknown): value is ReconciliationRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<ReconciliationRecord>;
  if (
    typeof record.documentId !== "string" ||
    !record.materialization ||
    (record.revision !== undefined &&
      (!Number.isInteger(record.revision) || (record.revision ?? -1) < 0))
  ) {
    return false;
  }
  if (record.desiredIdentity !== undefined && !isDesiredIdentity(record.desiredIdentity)) {
    return false;
  }
  if (record.failure !== undefined && !isIdentityFailure(record.failure)) return false;
  if (record.materialization.phase === "synced") {
    return record.pendingSinceMs === null;
  }
  if (record.materialization.phase !== "pending") return false;
  const entry = record.materialization.entry;
  return (
    typeof entry?.documentId === "string" &&
    entry.documentId === record.documentId &&
    typeof entry.projectId === "string" &&
    typeof record.pendingSinceMs === "number" &&
    (entry.home === undefined ||
      (entry.home.scheme === "scratch" &&
        typeof entry.home.workId === "string" &&
        (entry.home.folderPath === undefined || typeof entry.home.folderPath === "string")))
  );
}

function isDesiredIdentity(value: unknown): value is DesiredIdentity {
  if (!value || typeof value !== "object") return false;
  const desired = value as Partial<DesiredIdentity>;
  const destination = desired.destination;
  return (
    typeof desired.name === "string" &&
    Boolean(destination) &&
    isProjectContextTreeScheme(destination?.scheme) &&
    typeof destination?.folderPath === "string" &&
    (destination.workId === undefined || typeof destination.workId === "string")
  );
}

function isIdentityFailure(value: unknown): value is QueuedIdentityFailure {
  if (!value || typeof value !== "object") return false;
  const failure = value as Partial<QueuedIdentityFailure>;
  if (failure.kind === "error") return typeof failure.name === "string";
  return (
    failure.kind === "conflict" &&
    typeof failure.name === "string" &&
    isProjectContextTreeScheme(failure.scheme) &&
    typeof failure.path === "string" &&
    (failure.workId === undefined || typeof failure.workId === "string")
  );
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
