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
    path: string,
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

export function untitledHomeUri(
  _projectId: string,
  activeWorkId: string | null,
): UntitledHome | null {
  return activeWorkId ? { scheme: "scratch", workId: activeWorkId } : null;
}

export type ReconciliationRecord = {
  documentId: string;
  materialization:
    | { phase: "idle" }
    | { phase: "pending"; entry: PendingUntitled }
    | { phase: "synced" };
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
      this.records.set(documentId, next);
    }
    this.persistAndEmit();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Last explicit writer identity wins and is durable before this returns. */
  queueIdentity(documentId: string, desiredIdentity: DesiredIdentity): void {
    const current = this.records.get(documentId) ?? {
      documentId,
      materialization: { phase: "idle" as const },
      pendingSinceMs: null,
    };
    this.records.set(documentId, {
      ...current,
      desiredIdentity,
      failure: undefined,
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
      const pending = [...this.records.values()].filter(
        (
          record,
        ): record is ReconciliationRecord & {
          materialization: { phase: "pending"; entry: PendingUntitled };
        } => record.materialization.phase === "pending",
      );
      for (const record of pending) {
        if (!this.started) break;
        try {
          await this.reconcile(record);
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

  private async reconcile(
    record: ReconciliationRecord & {
      materialization: { phase: "pending"; entry: PendingUntitled };
    },
  ): Promise<void> {
    const entry = record.materialization.entry;
    const home = entry.home ?? (await this.deps.api.resolveHome(entry.projectId));
    if (!home) throw new Error("Untitled home is not available yet");
    const resolvedEntry = entry.home
      ? (entry as PendingUntitled & { home: UntitledHome })
      : { ...entry, home };
    if (!entry.home) {
      record = { ...record, materialization: { phase: "pending", entry: resolvedEntry } };
      this.records.set(entry.documentId, record);
      this.persist();
    }

    const owner = `untitled-reconciler:${entry.documentId}`;
    const session = this.deps.sessions.getDetached(entry.documentId);
    this.deps.sessions.retain(owner, [entry.documentId]);
    try {
      await session.whenLocalPersistenceSynced();
      const empty = untitledDocumentIsEmpty(session.document.getXmlFragment(session.fragmentName));
      if (empty && !(await this.deps.api.serverDocumentExists(resolvedEntry))) {
        await this.drain(entry.documentId, true);
        return;
      }

      const result = await this.deps.api.create(resolvedEntry);
      if (result.status === "conflict") {
        await this.remint(resolvedEntry, session);
        return;
      }
      this.candidates.get(entry.documentId)?.onMaterialized(result);
      await this.applyDesiredIdentity(resolvedEntry, result);

      const attached = this.deps.sessions.attachDetached(entry.documentId);
      await attached.waitForDurableSync();
      const snapshot = attached.getSnapshot();
      if (snapshot.status !== "synced") throw syncFailure(snapshot);
      await this.drain(entry.documentId, false);
    } finally {
      this.deps.sessions.release(owner);
    }
  }

  private async applyDesiredIdentity(
    entry: PendingUntitled & { home: UntitledHome },
    result: CreateUntitledContextDocumentResponse,
  ): Promise<void> {
    const desired = this.records.get(entry.documentId)?.desiredIdentity;
    if (!desired) return;
    try {
      const moved = await this.deps.api.move(entry, result.path, desired);
      if (moved.status === "conflict") {
        this.finishIdentityAttempt(entry.documentId, {
          kind: "conflict",
          name: desired.name,
          scheme: moved.collision.scheme,
          path: `/${moved.collision.path}`,
          ...(moved.collision.workId ? { workId: moved.collision.workId } : {}),
        });
        return;
      }
      this.finishIdentityAttempt(entry.documentId);
      this.candidates.get(entry.documentId)?.onIdentityCommitted?.({
        ...moved,
        path: `/${moved.path}`,
      });
    } catch {
      this.finishIdentityAttempt(entry.documentId, { kind: "error", name: desired.name });
    }
  }

  private finishIdentityAttempt(documentId: string, failure?: QueuedIdentityFailure): void {
    const record = this.records.get(documentId);
    if (!record) return;
    this.records.set(documentId, { ...record, desiredIdentity: undefined, failure });
    this.persistAndEmit();
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

  private async drain(documentId: string, clearPersistence: boolean): Promise<void> {
    const record = this.records.get(documentId);
    if (record?.desiredIdentity || record?.failure) {
      this.records.set(documentId, {
        ...record,
        materialization: clearPersistence ? { phase: "idle" } : { phase: "synced" },
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
    return parsed.filter(isReconciliationRecord);
  } catch {
    return [];
  }
}

function isReconciliationRecord(value: unknown): value is ReconciliationRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<ReconciliationRecord>;
  if (typeof record.documentId !== "string" || !record.materialization) return false;
  if (record.desiredIdentity !== undefined && !isDesiredIdentity(record.desiredIdentity)) {
    return false;
  }
  if (record.failure !== undefined && !isIdentityFailure(record.failure)) return false;
  if (record.materialization.phase === "idle" || record.materialization.phase === "synced") {
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
  if (!value || typeof value !== "object") return typeof value === "string" && value.length > 0;
  const node = value as { type?: string; text?: string; content?: unknown[] };
  if (node.text?.length) return true;
  if (node.type && !["doc", "paragraph", "heading"].includes(node.type)) return true;
  return (node.content ?? []).some(nodeHasContent);
}
