/** Structural, lease-qualified session-registry surfaces. */
import type { AccountId } from "@meridian/contracts/protocol";
import type { DocumentId, ProjectId } from "@meridian/contracts/runtime";
import type { DocumentSession } from "./document-session";
import type { DocumentHistory } from "./editor-history";

export type RetainedLiveDocumentReference = Readonly<{
  projectId: ProjectId;
  documentId: DocumentId;
}>;

/** The account's right to hold one document's live session; `get` and `retain` take it. */
export type LiveDocumentSessionLease = Readonly<{
  accountId: AccountId;
  projectId: ProjectId;
  documentId: DocumentId;
}>;

export interface LiveDocumentSessionRegistry {
  admit(projectId: ProjectId, documentId: DocumentId): LiveDocumentSessionLease;
  /**
   * The document's local copy can no longer come back to this account (its node was purged, or
   * its project, Work or chat was deleted for good, or the account left the project): the
   * session closes and the copy is deleted, unless another tab holds it open, which clears it
   * itself. Resolves once this tab is done.
   */
  clearLocalCopy(documentId: DocumentId): Promise<void>;
  /** True once no open session has unsent edits the server could still acknowledge; false if some remain at the deadline. */
  settleUnsentEdits(timeoutMs: number): Promise<boolean>;
  /** Calls `observer` with the documents this browser holds a copy of for the account, open or not, and again as they change. */
  observeLocalCopies(observer: (documents: ReadonlySet<DocumentId>) => void): () => void;
  get(lease: LiveDocumentSessionLease): DocumentSession;
  /**
   * The Yjs state vector of the document's live session in this tab, typing the server hasn't
   * acknowledged included; null when this tab holds no such session.
   */
  openStateVector(documentId: DocumentId): Uint8Array | null;
  /** `openStateVector` of every document with a live session in this tab. */
  openStateVectors(): Map<DocumentId, Uint8Array>;
  /**
   * Settles once the server holds the typing in this tab's live session of the document; at once
   * when the tab holds none or it is not connected.
   */
  whenLiveHeld(documentId: DocumentId): Promise<void>;
  /**
   * The writer's Undo of a document's session in this tab, shown or kept for its undo, by the
   * document's id. Null when the tab holds none.
   */
  history(roomKey: string): DocumentHistory | null;
  /** Calls `observer` each time a session opens in this tab, with a new `history`. */
  observeHistories(observer: () => void): () => void;
  restartUnavailableRoom(lease: LiveDocumentSessionLease): Promise<boolean>;
  retain(
    ownerId: string,
    leases: Iterable<LiveDocumentSessionLease>,
    options?: { detachedDocumentIds?: Iterable<DocumentId> },
  ): void;
  /**
   * Whether the owner's retained documents have a host on screen. An unhosted document closes
   * its socket unless some other owner hosts it or it has unsent edits. No-op once the owner is
   * released.
   */
  setHosted(ownerId: string, hosted: boolean): void;
  release(ownerId: string): void;
  observeRetainedLiveDocuments(
    observer: (snapshot: readonly RetainedLiveDocumentReference[]) => void,
  ): () => void;
  /**
   * Calls `observer` each time a room's unsent typing with words in it is dropped (its document
   * was removed, or its room was admitted read-only): the typing has nowhere to go and is not kept.
   */
  observeDroppedTyping(observer: () => void): () => void;
  /**
   * Calls `observer` with the session that replaces a document's room (by its id): the room's
   * holders bind it and their editors remount. Not called for a room retired the ordinary way.
   */
  observeReplacement(roomKey: string, observer: (session: DocumentSession) => void): () => void;
}
