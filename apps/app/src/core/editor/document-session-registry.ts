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
 * when every opener has released that document from its open set, after a
 * short grace window so rapid release→retain (e.g. React strict mode) does
 * not detach the Hocuspocus provider on the shared socket.
 *
 * The Hocuspocus adapter owns the shared socket; this registry owns the
 * per-document sessions on the same process-wide plane.
 */
import { createHocuspocusDocumentTransport } from "@/core/transport/hocuspocus-document-transport";

import { DocumentSession } from "./document-session";

/** Soft cap — log once when exceeded; no hard eviction (R14). */
const LIVE_DOC_SOFT_CAP = 50;

/**
 * Grace window before tearing down an unretained session. Rapid
 * release→retain (React strict mode, fast navigation) cancels the timer so
 * the live provider stays attached on the shared socket — avoiding a stale
 * CloseMessage racing a new SyncStep1.
 */
const SESSION_TEARDOWN_GRACE_MS = 3_000;

// R14: hard max-live-docs eviction + reconnect load-concurrency cap deferred
// (before-prod); watch server liveDocumentCount metric

class DocumentSessionRegistry {
  private readonly sessions = new Map<string, DocumentSession>();
  /** opener id → document ids that opener currently considers open. */
  private readonly retainedByOwner = new Map<string, Set<string>>();
  /** document id → pending deferred teardown timer. */
  private readonly pendingTeardownTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private liveDocCapWarningEmitted = false;

  /**
   * Acquire the live session for a document, creating it (and its transport
   * subscription) once on first request. Callers must NOT destroy the returned
   * session — lifecycle is owned here and reconciled via {@link retain} and
   * {@link release}.
   */
  get(documentId: string): DocumentSession {
    this.cancelPendingTeardown(documentId);
    const existing = this.sessions.get(documentId);
    if (existing) return existing;
    const session = new DocumentSession({
      documentId,
      transportFactory: ({ documentId: id, document, awareness }) =>
        createHocuspocusDocumentTransport({ documentId: id, document, awareness }),
    });
    this.sessions.set(documentId, session);
    this.maybeWarnLiveDocCap();
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
    this.liveDocCapWarningEmitted = false;
    for (const timer of this.pendingTeardownTimers.values()) {
      clearTimeout(timer);
    }
    this.pendingTeardownTimers.clear();
    for (const [id, session] of this.sessions) {
      void session.destroy();
      this.sessions.delete(id);
    }
  }

  private maybeWarnLiveDocCap(): void {
    if (this.liveDocCapWarningEmitted || this.sessions.size <= LIVE_DOC_SOFT_CAP) return;
    this.liveDocCapWarningEmitted = true;
    console.warn(
      `[document-session-registry] live document session count (${this.sessions.size}) exceeds soft cap (${LIVE_DOC_SOFT_CAP})`,
    );
  }

  private reconcileRetainedSessions(): void {
    const keep = new Set<string>();
    for (const ids of this.retainedByOwner.values()) {
      for (const id of ids) keep.add(id);
    }

    for (const id of keep) {
      this.get(id);
    }

    for (const id of this.sessions.keys()) {
      if (!keep.has(id)) {
        this.scheduleTeardown(id);
      }
    }
  }

  private cancelPendingTeardown(documentId: string): void {
    const timer = this.pendingTeardownTimers.get(documentId);
    if (!timer) return;
    clearTimeout(timer);
    this.pendingTeardownTimers.delete(documentId);
  }

  private scheduleTeardown(documentId: string): void {
    if (this.pendingTeardownTimers.has(documentId)) return;

    const timer = setTimeout(() => {
      this.pendingTeardownTimers.delete(documentId);
      if (this.isRetained(documentId)) return;

      const session = this.sessions.get(documentId);
      if (!session) return;
      void session.destroy();
      this.sessions.delete(documentId);
    }, SESSION_TEARDOWN_GRACE_MS);

    this.pendingTeardownTimers.set(documentId, timer);
  }

  private isRetained(documentId: string): boolean {
    for (const ids of this.retainedByOwner.values()) {
      if (ids.has(documentId)) return true;
    }
    return false;
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
