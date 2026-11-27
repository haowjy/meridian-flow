import type { DraftId } from "@meridian/contracts";
import type { AccountId, DocumentRoom } from "@meridian/contracts/protocol";
import type { DocumentId, ProjectId } from "@meridian/contracts/runtime";
import type { DocumentSession } from "./document-session";

export type RetainedLiveDocumentReference = Readonly<{
  projectId: ProjectId;
  documentId: DocumentId;
}>;

export type DocumentSessionLease = Readonly<{
  accountId: AccountId;
  projectId: ProjectId;
  documentId: DocumentId;
  room: DocumentRoom;
}>;

export type PressRooms = Readonly<{
  drafts: readonly DraftId[];
  documents: readonly DocumentId[] | null;
}>;

export interface LiveDocumentSessionRegistry {
  admit(projectId: ProjectId, documentId: DocumentId, draftId?: DraftId): DocumentSessionLease;
  clearLocalCopy(documentId: DocumentId): Promise<void>;
  settleUnsentEdits(timeoutMs: number): Promise<boolean>;
  observeLocalCopies(observer: (documents: ReadonlySet<DocumentId>) => void): () => void;
  get(lease: DocumentSessionLease): DocumentSession;
  openRoomVersion(documentId: DocumentId): Uint8Array | null;
  whenSentAcknowledged(projectId: ProjectId, rooms: PressRooms): Promise<void>;
  restartUnavailableRoom(lease: DocumentSessionLease): Promise<boolean>;
  retain(
    ownerId: string,
    leases: Iterable<DocumentSessionLease>,
    options?: { detachedDocumentIds?: Iterable<DocumentId> },
  ): void;
  setHosted(ownerId: string, hosted: boolean): void;
  release(ownerId: string): void;
  observeRetainedLiveDocuments(
    observer: (snapshot: readonly RetainedLiveDocumentReference[]) => void,
  ): () => void;
  observeDroppedTyping(observer: () => void): () => void;
  observeReplacement(roomKey: string, observer: (session: DocumentSession) => void): () => void;
  openSession(room: DocumentRoom): DocumentSession | null;
}
