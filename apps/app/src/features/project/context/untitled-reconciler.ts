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
  ProjectContextTreeNode,
  RenameContextEntryResult,
} from "@meridian/contracts/protocol";
import { useSyncExternalStore } from "react";
import * as Y from "yjs";
import {
  createUntitledContextDocument,
  getProjectContextTree,
  listProjectWorks,
  renameContextEntry,
} from "@/client/api/projects-api";
import { flushContextDesks } from "@/client/stores";
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
};

type RenameIntent = { name: string; resolve: () => void; reject: (error: unknown) => void };

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
  private readonly renameIntents = new Map<string, RenameIntent>();
  private running = false;
  private scheduled = false;
  private started = false;
  private retryMs = RETRY_BASE_MS;
  private retryTimer: unknown = null;
  private removeOnlineListener: (() => void) | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly deps: UntitledReconcilerDeps) {}

  /** Loads the crash-safe registry without starting network reconciliation. */
  rehydrate(): void {
    for (const entry of readRegistry(this.deps.storage)) {
      if (!this.entries.has(entry.documentId)) this.entries.set(entry.documentId, entry);
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
    if (this.entries.has(entry.documentId)) return;
    this.entries.set(entry.documentId, entry);
    this.persist();
    this.emit();
    this.schedule();
  }

  has(documentId: string): boolean {
    return this.entries.has(documentId);
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  queueRename(documentId: string, name: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.renameIntents.get(documentId)?.reject(new Error("Rename replaced by a newer name"));
      this.renameIntents.set(documentId, { name, resolve, reject });
      this.schedule();
    });
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
        this.rejectRename(entry.documentId, "An empty untitled document is not materialized");
        await this.drain(entry.documentId, true);
        return;
      }

      const result = await this.deps.api.create(resolvedEntry);
      if (result.status === "conflict") {
        await this.remint(resolvedEntry, session);
        return;
      }
      this.candidates.get(entry.documentId)?.onMaterialized(result);
      await this.applyQueuedRename(resolvedEntry, result);

      const attached = this.deps.sessions.attachDetached(entry.documentId);
      await attached.waitForDurableSync();
      const snapshot = attached.getSnapshot();
      if (snapshot.status !== "synced") throw syncFailure(snapshot);
      await this.drain(entry.documentId, false);
    } finally {
      this.deps.sessions.release(owner);
    }
  }

  private async applyQueuedRename(
    entry: PendingUntitled & { home: UntitledHome },
    result: CreateUntitledContextDocumentResponse,
  ): Promise<void> {
    const rename = this.renameIntents.get(entry.documentId);
    if (!rename) return;
    try {
      const renameResult = await this.deps.api.rename(entry, result.path, rename.name);
      if (renameResult.status === "conflict") {
        throw new Error("A document with that name already exists");
      }
      const path = replaceBasename(result.path, rename.name);
      this.candidates.get(entry.documentId)?.onRenamed(rename.name, path);
      this.renameIntents.delete(entry.documentId);
      rename.resolve();
    } catch (error) {
      this.renameIntents.delete(entry.documentId);
      rename.reject(error);
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
    this.entries.delete(entry.documentId);
    this.entries.set(replacementId, { ...entry, documentId: replacementId });
    this.candidates.delete(entry.documentId);
    if (candidate) this.candidates.set(replacementId, candidate);
    this.renameIntents.delete(entry.documentId);
    if (rename) this.renameIntents.set(replacementId, rename);
    this.persist();
    this.emit();
    candidate?.onReminted(replacementId);
  }

  private async drain(documentId: string, clearPersistence: boolean): Promise<void> {
    this.entries.delete(documentId);
    this.persist();
    this.emit();
    if (clearPersistence) {
      await this.deps.sessions.destroyRoom(documentId, { clearPersistence: true });
    }
  }

  private rejectRename(documentId: string, message: string): void {
    const rename = this.renameIntents.get(documentId);
    this.renameIntents.delete(documentId);
    rename?.reject(new Error(message));
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
  flushContextDesks();
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

export function queueUntitledRename(documentId: string, name: string): Promise<void> {
  return getUntitledReconciler().queueRename(documentId, name);
}
