/** Structural, lease-qualified session-registry surfaces. */
import type {
  AccountId,
  LiveDocumentSessionAuthority,
  LiveDocumentSessionLease,
} from "@meridian/contracts/protocol";
import type { DocumentId, ProjectId } from "@meridian/contracts/runtime";

import type { DocumentSession } from "./document-session";

export type RetainedLiveDocumentReference = Readonly<{
  projectId: ProjectId;
  documentId: DocumentId;
}>;

export interface LiveDocumentSessionRegistry extends LiveDocumentSessionAuthority {
  get(lease: LiveDocumentSessionLease): DocumentSession;
  restartUnavailableRoom(lease: LiveDocumentSessionLease): Promise<boolean>;
  retain(
    ownerId: string,
    leases: Iterable<LiveDocumentSessionLease>,
    options?: { detachedDocumentIds?: Iterable<DocumentId> },
  ): void;
  release(ownerId: string): void;
  observeRetainedLiveDocuments(
    observer: (snapshot: readonly RetainedLiveDocumentReference[]) => void,
  ): () => void;
  getBranchRoom(roomKey: string): DocumentSession;
  retainBranchRooms(ownerId: string, roomKeys: Iterable<string>): void;
  releaseBranchRooms(ownerId: string): void;
}

export interface LocalDocumentSessionFactory {
  whenAuthorityReady(): Promise<void>;
  createDetached(input: {
    accountId: AccountId;
    projectId: ProjectId;
    documentId: DocumentId;
    persistenceKey: string;
    fresh?: boolean;
  }): DocumentSession;
}
