import type { DocumentId, ProjectId } from "@meridian/contracts";
import type { DocumentTrashEntry, TrashEntryFacts } from "@meridian/contracts/protocol";

export type DocumentPurgeDisposal = {
  /**
   * Inside the caller's transaction, which already holds the tree list's lock: takes the
   * documents' keys and answers `pending` when a Work still has a reviewable change to one of
   * them (the purge waits). Otherwise their rooms close once the caller commits, so nothing
   * writes the documents once their content is released.
   */
  settle(documentIds: readonly DocumentId[]): Promise<"pending" | "closed">;
};

export type DocumentTrash = {
  retained(
    projectId: ProjectId,
    documentIds: readonly DocumentId[],
  ): Promise<ReadonlySet<DocumentId>>;
  list(projectId: ProjectId): Promise<readonly TrashEntryFacts[]>;
  read(projectId: ProjectId, documentId: DocumentId): Promise<DocumentTrashEntry | null>;
  wasPurged(projectId: ProjectId, documentId: DocumentId): Promise<boolean>;
  purge(): Promise<number>;
};
