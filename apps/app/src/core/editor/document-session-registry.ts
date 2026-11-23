/** Structural, lease-qualified session-registry surfaces. */
import type { DraftId } from "@meridian/contracts";
import type { AccountId, DocumentRoom } from "@meridian/contracts/protocol";
import type { DocumentId, ProjectId } from "@meridian/contracts/runtime";
import type { DocumentSession } from "./document-session";

export type RetainedLiveDocumentReference = Readonly<{
  projectId: ProjectId;
  documentId: DocumentId;
}>;

/**
 * The account's right to hold one document room's session (its Live room, or a draft's fork
 * room of it); `get` and `retain` take it.
 */
export type DocumentSessionLease = Readonly<{
  accountId: AccountId;
  projectId: ProjectId;
  documentId: DocumentId;
  room: DocumentRoom;
}>;

export interface LiveDocumentSessionRegistry {
  /**
   * The lease of the document's Live room, or with `draftId` of that draft's fork room. A fork
   * room's session is built over the document's Live session, which the registry keeps open as long
   * as the fork's session lives.
   */
  admit(projectId: ProjectId, documentId: DocumentId, draftId?: DraftId): DocumentSessionLease;
  /**
   * The document's local copy can no longer come back to this account (its node was purged, or
   * its project, Work or chat was deleted for good, or the account left the project): its
   * sessions (Live and every fork) close and the copies are deleted, unless another tab holds it open, which clears it
   * itself. Resolves once this tab is done.
   */
  clearLocalCopy(documentId: DocumentId): Promise<void>;
  /** True once no open session has unsent edits the server could still acknowledge; false if some remain at the deadline. */
  settleUnsentEdits(timeoutMs: number): Promise<boolean>;
  /** Calls `observer` with the documents this browser holds a copy of for the account, open or not, and again as they change. */
  observeLocalCopies(observer: (documents: ReadonlySet<DocumentId>) => void): () => void;
  get(lease: DocumentSessionLease): DocumentSession;
  /**
   * The room version (`encodeRoomVersion`) of the document's live session in this tab, typing the
   * server hasn't acknowledged included; null when this tab holds no such session.
   */
  openRoomVersion(documentId: DocumentId): Uint8Array | null;
  /**
   * Settles once every room of these documents this tab holds (forks and Live) acknowledged every
   * batch it sent; null is every room. A room not connected is not waited for.
   */
  whenSentAcknowledged(documentIds: readonly DocumentId[] | null): Promise<void>;
  restartUnavailableRoom(lease: DocumentSessionLease): Promise<boolean>;
  retain(
    ownerId: string,
    leases: Iterable<DocumentSessionLease>,
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
  /**
   * The open fork session of `draftId`'s fork of the document in this tab, if any: a command that
   * waits on the fork room's acknowledgement reads it, and opens none.
   */
  openSession(room: DocumentRoom): DocumentSession | null;
}
