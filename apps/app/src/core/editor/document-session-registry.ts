/**
 * DocumentSessionRegistry — app-level owner of `DocumentSession` instances,
 * keyed by Yjs room key.
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
 * per-room sessions on the same process-wide plane.
 */
import { draftRoomName, parseYjsRoomName } from "@meridian/contracts/protocol";

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
  /** opener id → Yjs room keys that opener currently considers open. */
  private readonly retainedByOwner = new Map<string, Set<string>>();
  /** room key → pending deferred teardown timer. */
  private readonly pendingTeardownTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private liveDocCapWarningEmitted = false;

  /**
   * Acquire the live session for a document, creating it (and its transport
   * subscription) once on first request. Callers must NOT destroy the returned
   * session — lifecycle is owned here and reconciled via {@link retain} and
   * {@link release}.
   */
  get(documentId: string): DocumentSession {
    return this.getRoom(documentId);
  }

  /**
   * Acquire a session for any Yjs room. The room key is the document identity:
   * after a branch generation reset the room name changes, so this map must
   * create exactly one Y.Doc per room name and never carry a Y.Doc across room
   * keys. The server handshake fence assumes that client identity contract.
   *
   * Live rooms are bare document ids; draft
   * rooms are `draft:<draftId>` per the shared contracts codec. Draft sessions
   * skip IndexedDB because they are short-lived review workspaces and their
   * durable source of truth is the server-persisted Hocuspocus draft room; a
   * local cache would only add stale cross-review recovery risk.
   */
  getRoom(roomKey: string): DocumentSession {
    const room = parseYjsRoomName(roomKey);
    if (!room) throw new Error(`Invalid Yjs room key: ${roomKey}`);

    this.cancelPendingTeardown(roomKey);
    const existing = this.sessions.get(roomKey);
    if (existing) return existing;
    const session = new DocumentSession({
      roomKey,
      enableIndexedDb: room.kind === "live" ? undefined : false,
      transportFactory: ({ roomKey: key, document, awareness }) =>
        createHocuspocusDocumentTransport({ roomName: key, document, awareness }),
    });
    if (room.kind === "branch") {
      session.subscribe((snapshot) => {
        if (snapshot.connectionState?.kind !== "reset") return;
        void session.destroy().finally(() => {
          if (this.sessions.get(roomKey) === session) this.sessions.delete(roomKey);
        });
      });
    }
    this.sessions.set(roomKey, session);
    if (room.kind === "live") this.maybeWarnLiveDocCap();
    return session;
  }

  getDraft(draftId: string): DocumentSession {
    return this.getRoom(draftRoomName(draftId));
  }

  /** Whether a session currently exists for a room key. */
  has(roomKey: string): boolean {
    return this.sessions.has(roomKey);
  }

  /**
   * Reconcile one opener's currently-open document set.
   *
   * Desktop tabs and the mobile single-file route are independent openers. The
   * registry destroys a session only after the document disappears from the
   * UNION of every opener's retained set, which prevents one mount path from
   * accidentally closing a session still owned by another path.
   */
  retain(ownerId: string, openRoomKeys: Iterable<string>): void {
    this.retainedByOwner.set(ownerId, new Set(openRoomKeys));
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

  private cancelPendingTeardown(roomKey: string): void {
    const timer = this.pendingTeardownTimers.get(roomKey);
    if (!timer) return;
    clearTimeout(timer);
    this.pendingTeardownTimers.delete(roomKey);
  }

  private scheduleTeardown(roomKey: string): void {
    if (this.pendingTeardownTimers.has(roomKey)) return;

    const timer = setTimeout(() => {
      this.pendingTeardownTimers.delete(roomKey);
      if (this.isRetained(roomKey)) return;

      const session = this.sessions.get(roomKey);
      if (!session) return;
      void session.destroy();
      this.sessions.delete(roomKey);
    }, SESSION_TEARDOWN_GRACE_MS);

    this.pendingTeardownTimers.set(roomKey, timer);
  }

  private isRetained(roomKey: string): boolean {
    for (const ids of this.retainedByOwner.values()) {
      if (ids.has(roomKey)) return true;
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
