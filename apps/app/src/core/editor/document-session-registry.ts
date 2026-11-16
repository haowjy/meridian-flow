/** Structural, lease-qualified session-registry surfaces. */
import type { ClosedDraftCause } from "@meridian/contracts/branches";
import type { AccountId } from "@meridian/contracts/protocol";
import type { DocumentId, ProjectId } from "@meridian/contracts/runtime";
import type { DocumentSession, DocumentSessionSnapshot } from "./document-session";
import type { DraftCloseCause, DraftRoomRef } from "./draft-room-pool";
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

/**
 * Why a room's unsent typing could not be delivered: its draft closed, its document was removed,
 * or the room's owner closed and the server admitted it read-only (`owner-closed`).
 */
export type UnsentTypingCause = "closed" | "removed" | "owner-closed";

/**
 * Typing a room ended with before the server acknowledged it, handed back once. `text` is null for
 * an `owner-closed` change that has no words (a deletion, a format change). `done` says the writer
 * is done with it (copied it, or dismissed it): until it resolves a reload offers its words again.
 * It rejects when that can't be stored, and the next call tries again.
 */
export type UnsentTyping = Readonly<{
  id: string;
  cause: UnsentTypingCause;
  text: string | null;
  done: () => Promise<void>;
}>;

/**
 * What a tab shows of the account's hand-back notices. `show` once per notice; `withdraw` when
 * another tab's Copy or Dismiss settled one this tab still shows.
 */
export type UnsentTypingObserver = Readonly<{
  show: (typing: UnsentTyping) => void;
  withdraw: (id: string) => void;
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
  /** The words this browser holds of the document in its local copies, open or not; null with none. */
  localText(documentId: DocumentId): Promise<string | null>;
  /** Calls `observer` with the documents this browser holds a copy of for the account, open or not, and again as they change. */
  observeLocalCopies(observer: (documents: ReadonlySet<DocumentId>) => void): () => void;
  get(lease: LiveDocumentSessionLease): DocumentSession;
  /**
   * The writer's Undo of the document's live session in this tab, shown or kept for its undo;
   * null when the tab holds none.
   */
  liveHistory(documentId: DocumentId): DocumentHistory | null;
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
   * The account's hand-back notices: words a room, live or draft, could not deliver (closed,
   * removed, read-only), from any tab, until the writer copies or dismisses them in one. The first
   * observer starts the account's read of the notices stored before.
   */
  observeUnsentTyping(observer: UnsentTypingObserver): () => void;
  closeDraftRoom(roomKey: string, cause: DraftCloseCause): Promise<void>;
  /** Hands back the copies of the draft ids `closedOf` says the server closed, once each; see the implementation. */
  handBackClosedDraftCopies(
    closedOf: (draftIds: string[]) => Promise<ReadonlyMap<string, ClosedDraftCause>>,
  ): Promise<void>;
  /** A restore reopened the draft: its room may open again under the same id. */
  reopenDraftRoom(roomKey: string): void;
  /**
   * The room ends for good and its typing is not handed back: its document was never made, and
   * the tab and the tree row offer those words from the local copy, which stays.
   */
  abandonDraftRoom(roomKey: string): Promise<void>;
  getDraftRoom(roomKey: string): DocumentSession;
  /**
   * Calls `observer` with the session that replaces a room's (a live document's by its id, or a
   * draft room's): the room's holders bind it and their editors remount. Not called for a room
   * retired the ordinary way.
   */
  observeReplacement(roomKey: string, observer: (session: DocumentSession) => void): () => void;
  /** Follows whichever session backs a draft room, across rebuilds; never creates one. */
  observeDraftRoom(
    roomKey: string,
    observer: (snapshot: DocumentSessionSnapshot) => void,
  ): () => void;
  /** A fresh session for a draft room whose last one reset, synced from the server alone. */
  rebuildDraftRoom(roomKey: string): Promise<DocumentSession>;
  retainDraftRooms(ownerId: string, rooms: readonly DraftRoomRef[]): void;
  releaseDraftRooms(ownerId: string): void;
}
