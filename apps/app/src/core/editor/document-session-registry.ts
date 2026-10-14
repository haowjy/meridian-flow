/** Structural, lease-qualified session-registry surfaces. */
import type {
  AccountId,
  AvailabilityGeneration,
  LiveDocumentSessionAuthority,
  LiveDocumentSessionLease,
} from "@meridian/contracts/protocol";
import type { DocumentId, ProjectId } from "@meridian/contracts/runtime";

import type { DocumentSession, DocumentSessionSnapshot } from "./document-session";

export type RetainedLiveDocumentReference = Readonly<{
  projectId: ProjectId;
  documentId: DocumentId;
}>;

export interface LiveDocumentSessionRegistry extends LiveDocumentSessionAuthority {
  get(lease: LiveDocumentSessionLease): DocumentSession;
  restartUnavailableRoom(lease: LiveDocumentSessionLease): Promise<boolean>;
  /**
   * The registry drops a live room whose pending edits the server refused
   * (4409): it revokes each lease's access, which tears the session down and
   * clears its local copy, so the next open loads the server's state instead
   * of replaying them. This is that drop while it runs, so a host can unbind
   * and reopen after; `null` before a refusal and once the drop has settled,
   * whether or not it removed the session. Never rejects.
   */
  whenRefusedRoomDropped(session: DocumentSession): Promise<void> | null;
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
  /** Follows whichever session backs a branch room, across rebuilds; never creates one. */
  observeBranchRoom(
    roomKey: string,
    observer: (snapshot: DocumentSessionSnapshot) => void,
  ): () => void;
  /** A fresh session for a branch room whose last one reset, synced from the server alone. */
  rebuildBranchRoom(roomKey: string): Promise<DocumentSession>;
  retainBranchRooms(ownerId: string, roomKeys: readonly string[]): void;
  releaseBranchRooms(ownerId: string): void;
}

/**
 * Private to resource acquisition: the exact persistence incarnation behind a
 * live registry session. A lease carries only the admission, which can be newer
 * than the room the cache lives in.
 */
export interface LiveSessionIncarnationPort {
  /** `null` when `session` is not the registry's current live room. */
  incarnationOf(session: DocumentSession): AvailabilityGeneration | null;
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
