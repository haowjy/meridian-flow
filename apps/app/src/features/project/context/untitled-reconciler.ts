/**
 * Untitled reconciler — drains the crash-safe list of locally-authored documents.
 *
 * The registry is the only work source. Events merely schedule the same
 * idempotent sweep; document input never performs network or IndexedDB work.
 */
import { useSyncExternalStore } from "react";
import * as Y from "yjs";

import {
  type CreateUntitledContextDocumentResponse,
  createUntitledContextDocument,
  renameContextEntry,
} from "@/client/api/projects-api";
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
  home: UntitledHome;
};

type Candidate = {
  onMaterialized: (result: CreateUntitledContextDocumentResponse) => void;
  onRenamed: (name: string, path: string) => void;
};

type RenameIntent = { name: string; resolve: () => void; reject: (error: unknown) => void };

export function untitledHomeUri(
  _projectId: string,
  activeWorkId: string | null,
): UntitledHome | null {
  return activeWorkId ? { scheme: "scratch", workId: activeWorkId } : null;
}

class UntitledReconciler {
  private readonly entries = new Map<string, PendingUntitled>();
  private readonly candidates = new Map<string, Candidate>();
  private readonly renameIntents = new Map<string, RenameIntent>();
  private running = false;
  private scheduled = false;
  private retryMs = RETRY_BASE_MS;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly listeners = new Set<() => void>();

  constructor() {
    if (typeof window === "undefined") return;
    for (const entry of readRegistry()) this.entries.set(entry.documentId, entry);
    window.addEventListener("online", this.schedule);
    this.schedule();
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
    if (this.entries.size === 0 || this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      void this.sweep();
    });
  };

  private async sweep(): Promise<void> {
    if (this.running || this.entries.size === 0) return;
    this.running = true;
    let failed = false;
    try {
      for (const entry of [...this.entries.values()]) {
        try {
          await this.reconcile(entry);
        } catch {
          failed = true;
        }
      }
    } finally {
      this.running = false;
    }
    if (failed && this.entries.size > 0) this.armRetry();
    else this.retryMs = RETRY_BASE_MS;
  }

  private async reconcile(entry: PendingUntitled): Promise<void> {
    const registry = getDocumentSessionRegistry();
    const owner = `untitled-reconciler:${entry.documentId}`;
    const session = registry.getDetached(entry.documentId);
    registry.retain(owner, [entry.documentId]);
    try {
      await session.whenLocalPersistenceSynced();

      if (untitledDocumentIsEmpty(session.document.getXmlFragment(session.fragmentName))) {
        const rename = this.renameIntents.get(entry.documentId);
        this.renameIntents.delete(entry.documentId);
        rename?.reject(new Error("An empty untitled document is not materialized"));
        this.entries.delete(entry.documentId);
        this.persist();
        this.emit();
        await registry.destroyRoom(entry.documentId, { clearPersistence: true });
        return;
      }

      const result = await createUntitledContextDocument(
        entry.projectId,
        entry.home.scheme,
        {
          documentId: entry.documentId,
          ...(entry.home.folderPath ? { folderPath: entry.home.folderPath } : {}),
        },
        { workId: entry.home.workId },
      );
      this.candidates.get(entry.documentId)?.onMaterialized(result);

      const rename = this.renameIntents.get(entry.documentId);
      if (rename) {
        try {
          await renameContextEntry(
            entry.projectId,
            entry.home.scheme,
            { path: result.path, newName: rename.name },
            { workId: entry.home.workId },
          );
          const path = replaceBasename(result.path, rename.name);
          this.candidates.get(entry.documentId)?.onRenamed(rename.name, path);
          this.renameIntents.delete(entry.documentId);
          rename.resolve();
        } catch (error) {
          this.renameIntents.delete(entry.documentId);
          rename.reject(error);
        }
      }

      const attached = registry.attachDetached(entry.documentId);
      await attached.whenSynced();
      if (attached.getSnapshot().status === "access-lost") {
        this.entries.delete(entry.documentId);
        this.persist();
        this.emit();
        await registry.destroyRoom(entry.documentId, { clearPersistence: true });
        return;
      }
      if (attached.getSnapshot().status !== "synced")
        throw new Error("Untitled document not synced");
      this.entries.delete(entry.documentId);
      this.persist();
      this.emit();
    } finally {
      registry.release(owner);
    }
  }

  private persist(): void {
    if (typeof window === "undefined") return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...this.entries.values()]));
  }

  private armRetry(): void {
    if (this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.schedule();
    }, this.retryMs);
    this.retryMs = Math.min(this.retryMs * 2, RETRY_MAX_MS);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

function readRegistry(): PendingUntitled[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
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
    entry.home?.scheme === "scratch" &&
    typeof entry.home.workId === "string" &&
    (entry.home.folderPath === undefined || typeof entry.home.folderPath === "string")
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
  const node = value as {
    type?: string;
    text?: string;
    attrs?: Record<string, unknown>;
    content?: unknown[];
  };
  if (node.text?.length) return true;
  if (node.type && !["doc", "paragraph", "heading"].includes(node.type)) return true;
  return (node.content ?? []).some(nodeHasContent);
}

function replaceBasename(path: string, name: string): string {
  return `${path.slice(0, path.lastIndexOf("/") + 1)}${name}`;
}

let shared: UntitledReconciler | null = null;

export function getUntitledReconciler(): UntitledReconciler {
  shared ??= new UntitledReconciler();
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

export function queueUntitledRename(documentId: string, name: string): Promise<void> {
  return getUntitledReconciler().queueRename(documentId, name);
}
