/** Structural, lease-qualified session-registry surfaces. */
import type { AccountId } from "@meridian/contracts/protocol";
import type { DocumentId, ProjectId } from "@meridian/contracts/runtime";
import type { DocumentSession, DocumentSessionSnapshot } from "./document-session";

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
  /** The documents this browser still holds a copy of for the account, open or not. */
  localCopies(): Promise<DocumentId[]>;
  get(lease: LiveDocumentSessionLease): DocumentSession;
  restartUnavailableRoom(lease: LiveDocumentSessionLease): Promise<boolean>;
  /**
   * The registry drops a live room whose pending edits the server refused
   * (4409): it tears the session down and clears its local copy, so the next open
   * loads the server's state instead of replaying them. This is that drop while it runs, so a host can unbind
   * and reopen after; `null` before a refusal and once the drop has settled,
   * whether or not it removed the session. Never rejects.
   */
  whenRefusedRoomDropped(session: DocumentSession): Promise<void> | null;
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
  closeDraftRoom(roomKey: string): Promise<void>;
  getDraftRoom(roomKey: string): DocumentSession;
  /** Follows whichever session backs a draft room, across rebuilds; never creates one. */
  observeDraftRoom(
    roomKey: string,
    observer: (snapshot: DocumentSessionSnapshot) => void,
  ): () => void;
  /** A fresh session for a draft room whose last one reset, synced from the server alone. */
  rebuildDraftRoom(roomKey: string): Promise<DocumentSession>;
  retainDraftRooms(ownerId: string, rooms: readonly string[]): void;
  releaseDraftRooms(ownerId: string): void;
}
