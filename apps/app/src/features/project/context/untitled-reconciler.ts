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
  ProjectContextTreeNode,
  ProjectContextTreeScheme,
  RenameContextEntryResult,
} from "@meridian/contracts/protocol";
import { useSyncExternalStore } from "react";
import * as Y from "yjs";
import {
  createUntitledContextDocument,
  getProjectContextTree,
  listProjectWorks,
  moveContextEntry,
  renameContextEntry,
} from "@/client/api/projects-api";
import type { DocumentSession, DocumentSessionSnapshot } from "@/core/editor/document-session";
import { getDocumentSessionRegistry } from "@/core/editor/document-session-registry";

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
  onRenamed: (name: string, path: string) => void;
  /** Queued placement landed: the document moved (path has a leading slash)
   *  and graduated out of provisional naming (explicit writer placement). */
  onMoved?: (result: MoveContextEntrySuccess) => void;
};

export type PlacementDestination = {
  scheme: ProjectContextTreeScheme;
  /** Scheme-relative parent folder WITHOUT a leading slash; "" = root. */
  folderPath: string;
  workId?: string;
};

/** Queued name (+ optional home) to apply when the document materializes. */
type PlacementIntent = { name: string; destination?: PlacementDestination };

/**
 * Receipt for a queued rename/placement that could not be applied when its
 * document materialized. Held in reconciler state (not a promise) so the
 * identity bar can surface recovery even though the writer's edit session
 * ended when the intent was queued. `conflict` carries the canonical
 * colliding locator (leading-slash path) for Open-existing.
 */
export type QueuedRenameFailure =
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
  rename(
    entry: PendingUntitled & { home: UntitledHome },
    path: string,
    name: string,
  ): Promise<RenameContextEntryResult>;
  move(
    entry: PendingUntitled & { home: UntitledHome },
    path: string,
    name: string,
    destination: PlacementDestination,
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

export class UntitledReconciler {
  private readonly entries = new Map<string, PendingUntitled>();
  private readonly candidates = new Map<string, Candidate>();
  private readonly renameIntents = new Map<string, PlacementIntent>();
  private readonly renameFailures = new Map<string, QueuedRenameFailure>();
  /** documentId → epoch ms when the entry first became pending (in-memory). */
  private readonly pendingSinceMs = new Map<string, number>();
  private running = false;
  private scheduled = false;
  private started = false;
  private retryMs = RETRY_BASE_MS;
  private retryTimer: unknown = null;
  private removeOnlineListener: (() => void) | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly deps: UntitledReconcilerDeps) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    for (const entry of readRegistry(this.deps.storage)) {
      if (this.entries.has(entry.documentId)) continue;
      this.entries.set(entry.documentId, entry);
      // An entry that survived a reload has been device-only across sessions —
      // no fresh grace window; the warning may claim its slot immediately.
      this.pendingSinceMs.set(entry.documentId, 0);
    }
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
    if (this.entries.has(entry.documentId)) return;
    this.entries.set(entry.documentId, entry);
    if (!this.pendingSinceMs.has(entry.documentId)) {
      this.pendingSinceMs.set(entry.documentId, Date.now());
    }
    this.persist();
    this.emit();
    this.schedule();
  }

  has(documentId: string): boolean {
    return this.entries.has(documentId);
  }

  /**
   * Epoch ms since the document became device-only, or null when synced.
   * Owned here (not in a view) so remounting chrome cannot restart the
   * device-only grace window.
   */
  pendingSince(documentId: string): number | null {
    return this.entries.has(documentId) ? (this.pendingSinceMs.get(documentId) ?? null) : null;
  }

  queuedRenameFailure(documentId: string): QueuedRenameFailure | null {
    return this.renameFailures.get(documentId) ?? null;
  }

  clearQueuedRenameFailure(documentId: string): void {
    if (this.renameFailures.delete(documentId)) this.emit();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Queue a rename (and optional home) to apply when the document
   *  materializes. Replaces any earlier intent; the outcome lands as a
   *  receipt (`queuedRenameFailure`), never a promise — the writer's edit
   *  session is over when this is called. */
  queuePlacement(documentId: string, intent: PlacementIntent): void {
    this.renameIntents.set(documentId, intent);
    this.clearQueuedRenameFailure(documentId);
    this.schedule();
  }

  readonly schedule = (): void => {
    if (!this.started || this.entries.size === 0 || this.scheduled) return;
    this.scheduled = true;
    this.deps.scheduler.queue(() => {
      this.scheduled = false;
      void this.sweep();
    });
  };

  private async sweep(): Promise<void> {
    if (!this.started || this.running || this.entries.size === 0) return;
    this.running = true;
    let failed = false;
    try {
      for (const entry of [...this.entries.values()]) {
        if (!this.started) break;
        try {
          await this.reconcile(entry);
        } catch {
          failed = true;
        }
      }
    } finally {
      this.running = false;
    }
    if (!this.started) return;
    if (failed && this.entries.size > 0) this.armRetry();
    else {
      this.retryMs = RETRY_BASE_MS;
      if (this.entries.size > 0) this.schedule();
    }
  }

  private async reconcile(entry: PendingUntitled): Promise<void> {
    const home = entry.home ?? (await this.deps.api.resolveHome(entry.projectId));
    if (!home) throw new Error("Untitled home is not available yet");
    const resolvedEntry = entry.home
      ? (entry as PendingUntitled & { home: UntitledHome })
      : { ...entry, home };
    if (!entry.home) {
      this.entries.set(entry.documentId, resolvedEntry);
      this.persist();
    }

    const owner = `untitled-reconciler:${entry.documentId}`;
    const session = this.deps.sessions.getDetached(entry.documentId);
    this.deps.sessions.retain(owner, [entry.documentId]);
    try {
      await session.whenLocalPersistenceSynced();
      const empty = untitledDocumentIsEmpty(session.document.getXmlFragment(session.fragmentName));
      if (empty && !(await this.deps.api.serverDocumentExists(resolvedEntry))) {
        // The document ceased to exist before materializing; a queued rename
        // stays intent-only and re-applies if the writer types again.
        await this.drain(entry.documentId, true);
        return;
      }

      const result = await this.deps.api.create(resolvedEntry);
      if (result.status === "conflict") {
        await this.remint(resolvedEntry, session);
        return;
      }
      this.candidates.get(entry.documentId)?.onMaterialized(result);
      await this.applyQueuedPlacement(resolvedEntry, result);

      const attached = this.deps.sessions.attachDetached(entry.documentId);
      await attached.waitForDurableSync();
      const snapshot = attached.getSnapshot();
      if (snapshot.status !== "synced") throw syncFailure(snapshot);
      await this.drain(entry.documentId, false);
    } finally {
      this.deps.sessions.release(owner);
    }
  }

  private async applyQueuedPlacement(
    entry: PendingUntitled & { home: UntitledHome },
    result: CreateUntitledContextDocumentResponse,
  ): Promise<void> {
    const intent = this.renameIntents.get(entry.documentId);
    if (!intent) return;
    this.renameIntents.delete(entry.documentId);
    try {
      if (intent.destination) {
        const moved = await this.deps.api.move(entry, result.path, intent.name, intent.destination);
        if (moved.status === "conflict") {
          this.renameFailures.set(entry.documentId, {
            kind: "conflict",
            name: intent.name,
            scheme: moved.collision.scheme,
            path: `/${moved.collision.path}`,
            ...(moved.collision.workId ? { workId: moved.collision.workId } : {}),
          });
          this.emit();
          return;
        }
        this.candidates.get(entry.documentId)?.onMoved?.({ ...moved, path: `/${moved.path}` });
        return;
      }
      const renameResult = await this.deps.api.rename(entry, result.path, intent.name);
      if (renameResult.status === "conflict") {
        this.renameFailures.set(entry.documentId, {
          kind: "conflict",
          name: intent.name,
          scheme: entry.home.scheme,
          path: replaceBasename(result.path, intent.name),
          workId: entry.home.workId,
        });
        this.emit();
        return;
      }
      this.candidates
        .get(entry.documentId)
        ?.onRenamed(intent.name, replaceBasename(result.path, intent.name));
    } catch {
      this.renameFailures.set(entry.documentId, { kind: "error", name: intent.name });
      this.emit();
    }
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

    const candidate = this.candidates.get(entry.documentId);
    const rename = this.renameIntents.get(entry.documentId);
    const failure = this.renameFailures.get(entry.documentId);
    const since = this.pendingSinceMs.get(entry.documentId);
    this.entries.delete(entry.documentId);
    this.entries.set(replacementId, { ...entry, documentId: replacementId });
    this.candidates.delete(entry.documentId);
    if (candidate) this.candidates.set(replacementId, candidate);
    this.renameIntents.delete(entry.documentId);
    if (rename) this.renameIntents.set(replacementId, rename);
    this.renameFailures.delete(entry.documentId);
    if (failure) this.renameFailures.set(replacementId, failure);
    this.pendingSinceMs.delete(entry.documentId);
    if (since !== undefined) this.pendingSinceMs.set(replacementId, since);
    this.persist();
    this.emit();
    candidate?.onReminted(replacementId);
  }

  private async drain(documentId: string, clearPersistence: boolean): Promise<void> {
    this.entries.delete(documentId);
    this.pendingSinceMs.delete(documentId);
    this.persist();
    this.emit();
    if (clearPersistence) {
      await this.deps.sessions.destroyRoom(documentId, { clearPersistence: true });
    }
  }

  private persist(): void {
    this.deps.storage.setItem(STORAGE_KEY, JSON.stringify([...this.entries.values()]));
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

function readRegistry(storage: StoragePort): PendingUntitled[] {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(STORAGE_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isPendingUntitled);
  } catch {
    return [];
  }
}

function isPendingUntitled(value: unknown): value is PendingUntitled {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<PendingUntitled>;
  return (
    typeof entry.documentId === "string" &&
    typeof entry.projectId === "string" &&
    (entry.home === undefined ||
      (entry.home.scheme === "scratch" &&
        typeof entry.home.workId === "string" &&
        (entry.home.folderPath === undefined || typeof entry.home.folderPath === "string")))
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

function replaceBasename(path: string, name: string): string {
  return `${path.slice(0, path.lastIndexOf("/") + 1)}${name}`;
}

function treeContainsDocument(
  nodes: readonly ProjectContextTreeNode[],
  documentId: string,
): boolean {
  return nodes.some((node) =>
    node.kind === "dir"
      ? treeContainsDocument(node.children, documentId)
      : node.documentId === documentId,
  );
}

function browserDeps(): UntitledReconcilerDeps {
  const registry = getDocumentSessionRegistry();
  return {
    storage: localStorage,
    scheduler: {
      queue: (task) => queueMicrotask(task),
      setTimer: (task, delayMs) => setTimeout(task, delayMs),
      clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
      onOnline: (task) => {
        window.addEventListener("online", task);
        return () => window.removeEventListener("online", task);
      },
    },
    sessions: registry,
    newDocumentId: () => crypto.randomUUID(),
    api: {
      async resolveHome(projectId) {
        const works = await listProjectWorks(projectId);
        return untitledHomeUri(projectId, works.defaultWorkId);
      },
      create(entry) {
        return createUntitledContextDocument(
          entry.projectId,
          entry.home.scheme,
          {
            documentId: entry.documentId,
            ...(entry.home.folderPath ? { folderPath: entry.home.folderPath } : {}),
          },
          { workId: entry.home.workId },
        );
      },
      async serverDocumentExists(entry) {
        const response = await getProjectContextTree(entry.projectId, entry.home.scheme, {
          workId: entry.home.workId,
        });
        return treeContainsDocument(response.tree.children, entry.documentId);
      },
      rename(entry, path, name) {
        return renameContextEntry(
          entry.projectId,
          entry.home.scheme,
          { path, newName: name },
          { workId: entry.home.workId },
        );
      },
      move(entry, path, name, destination) {
        const currentName = path.slice(path.lastIndexOf("/") + 1);
        return moveContextEntry(entry.projectId, entry.home.scheme, {
          path: path.replace(/^\/+/, ""),
          sourceWorkId: entry.home.workId,
          destinationScheme: destination.scheme,
          destinationFolderPath: destination.folderPath,
          ...(destination.workId ? { destinationWorkId: destination.workId } : {}),
          ...(name !== currentName ? { newName: name } : {}),
        });
      },
    },
  };
}

let shared: UntitledReconciler | null = null;

export function getUntitledReconciler(): UntitledReconciler {
  if (!shared && typeof window !== "undefined") shared = new UntitledReconciler(browserDeps());
  if (!shared) throw new Error("Untitled reconciler is browser-only");
  return shared;
}

export function registerUntitledCandidate(documentId: string, candidate: Candidate): () => void {
  return getUntitledReconciler().registerCandidate(documentId, candidate);
}

export function appendPendingUntitled(entry: PendingUntitled): void {
  getUntitledReconciler().append(entry);
}

export function isUntitledPending(documentId: string): boolean {
  return getUntitledReconciler().has(documentId);
}

export function useUntitledPending(documentId: string): boolean {
  const reconciler = getUntitledReconciler();
  return useSyncExternalStore(
    reconciler.subscribe,
    () => reconciler.has(documentId),
    () => false,
  );
}

/** Epoch ms since the document became device-only, or null when synced. */
export function useUntitledPendingSince(documentId: string): number | null {
  const reconciler = getUntitledReconciler();
  return useSyncExternalStore(
    reconciler.subscribe,
    () => reconciler.pendingSince(documentId),
    () => null,
  );
}

export function useQueuedRenameFailure(documentId: string): QueuedRenameFailure | null {
  const reconciler = getUntitledReconciler();
  return useSyncExternalStore(
    reconciler.subscribe,
    () => reconciler.queuedRenameFailure(documentId),
    () => null,
  );
}

export function clearQueuedRenameFailure(documentId: string): void {
  getUntitledReconciler().clearQueuedRenameFailure(documentId);
}

export function queueUntitledRename(documentId: string, name: string): void {
  getUntitledReconciler().queuePlacement(documentId, { name });
}

/** Queue a rename + move to apply when the document materializes. */
export function queueUntitledPlacement(
  documentId: string,
  name: string,
  destination: PlacementDestination,
): void {
  getUntitledReconciler().queuePlacement(documentId, { name, destination });
}
