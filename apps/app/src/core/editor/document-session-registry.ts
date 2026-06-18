/**
 * DocumentSessionRegistry — app-level owner of `DocumentSession` instances,
 * keyed by `documentId`.
 *
 * Key decision: a session's lifecycle is driven by the union of retained
 * **open-document sets** (desktop context tabs, mobile single-file viewer),
 * NOT by any view's mount. Previously `EditorView` created
 * a `DocumentSession` on mount and `destroy()`d it on unmount, so leaving the
 * Context destination tore down every Yjs session + its transport subscription
 * (re-syncing + reconnecting on return). With the registry, views are pure
 * consumers (`get`); the session survives view unmount and is destroyed only
 * when every opener has released that document from its open set.
 *
 * This mirrors the singleton `getDocumentSessionTransport()` model: one process,
 * one registry. The transport (the multiplexed Yjs WS) is already a singleton;
 * this lifts the per-document *session* to the same plane.
 */
import { createHocuspocusDocumentTransport } from "@/core/transport/hocuspocus-document-transport";

import { DocumentSession } from "./document-session";

class DocumentSessionRegistry {
  private readonly sessions = new Map<string, DocumentSession>();
  /** opener id → document ids that opener currently considers open. */
  private readonly retainedByOwner = new Map<string, Set<string>>();

  /**
   * Acquire the live session for a document, creating it (and its transport
   * subscription) once on first request. Callers must NOT destroy the returned
   * session — lifecycle is owned here and reconciled via {@link retain} and
   * {@link release}.
   */
  get(documentId: string): DocumentSession {
    const existing = this.sessions.get(documentId);
    if (existing) return existing;
    const session = new DocumentSession({
      documentId,
      transportFactory: ({ documentId: id, document, awareness }) =>
        createHocuspocusDocumentTransport({ documentId: id, document, awareness }),
    });
    this.sessions.set(documentId, session);
    return session;
  }

  /** Whether a live session currently exists for a document. */
  has(documentId: string): boolean {
    return this.sessions.has(documentId);
  }

  /**
   * Reconcile one opener's currently-open document set.
   *
   * Desktop tabs and the mobile single-file route are independent openers. The
   * registry destroys a session only after the document disappears from the
   * UNION of every opener's retained set, which prevents one mount path from
   * accidentally closing a session still owned by another path.
   */
  retain(ownerId: string, openDocumentIds: Iterable<string>): void {
    this.retainedByOwner.set(ownerId, new Set(openDocumentIds));
    this.reconcileRetainedSessions();
  }

  /** Release all documents retained by one opener (typically on host unmount). */
  release(ownerId: string): void {
    this.retainedByOwner.delete(ownerId);
    this.reconcileRetainedSessions();
  }

  /** Destroy every live session (e.g. on full teardown / tests). */
  destroyAll(): void {
    this.retainedByOwner.clear();
    for (const [id, session] of this.sessions) {
      void session.destroy();
      this.sessions.delete(id);
    }
  }

  private reconcileRetainedSessions(): void {
    const keep = new Set<string>();
    for (const ids of this.retainedByOwner.values()) {
      for (const id of ids) keep.add(id);
    }

    for (const id of keep) {
      this.get(id);
    }

    for (const [id, session] of this.sessions) {
      if (!keep.has(id)) {
        void session.destroy();
        this.sessions.delete(id);
      }
    }
  }
}

let sharedRegistry: DocumentSessionRegistry | null = null;

/** The process-wide document-session registry (lazy singleton). */
export function getDocumentSessionRegistry(): DocumentSessionRegistry {
  if (!sharedRegistry) {
    sharedRegistry = new DocumentSessionRegistry();
  }
  return sharedRegistry;
}

export type { DocumentSessionRegistry };
