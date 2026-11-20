/** Structural, lease-qualified session-registry surfaces. */
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
   * The Yjs state vector of the document's live session in this tab (or of its draft room, for
   * `"draft"`), typing the server hasn't acknowledged included; null when this tab holds no
   * such session, or several draft rooms for the document.
   */
  openStateVector(documentId: DocumentId, view?: "live" | "draft"): Uint8Array | null;
  /**
   * Settles once the server holds the typing in this tab's live session of the document; at once
   * when the tab holds none or it is not connected.
   */
  whenLiveHeld(documentId: DocumentId): Promise<void>;
  /**
   * The writer's Undo of a room's session in this tab, shown or kept for its undo: a document's
   * live room by its id, a draft room by its name. Null when the tab holds none.
   */
  history(roomKey: string): DocumentHistory | null;
  /** Calls `observer` each time a session opens in this tab, live or draft, with a new `history`. */
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
   * Calls `observer` each time a room's unsent typing with words in it is dropped (its draft
   * closed, its document was removed, or its room was admitted read-only): the typing has nowhere
   * to go and is not kept.
   */
  observeDroppedTyping(observer: () => void): () => void;
  closeDraftRoom(roomKey: string, cause: DraftCloseCause): Promise<void>;
  /** Settles the draft copies no room here owns, once each, by the drafts `openOf` says the server still has; see the implementation. */
  sweepDraftCopies(openOf: (draftIds: string[]) => Promise<ReadonlySet<string>>): Promise<void>;
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
