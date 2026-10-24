/** Restorable document trash and the retention path that eventually purges its content. */
import type { DocumentId, ProjectId } from "@meridian/contracts";
import type { DocumentTrashEntry, GetDocumentTrashResponse } from "@meridian/contracts/protocol";

export type DocumentPurgeDraftDisposal = {
  /**
   * Runs one purge attempt after locking every active branch and draft that can still write
   * the document. The caller checks eligibility before invoking `disposeDrafts`.
   */
  withDisposal<T>(
    documentId: DocumentId,
    run: (disposeDrafts: () => Promise<void>) => Promise<T>,
  ): Promise<T>;
};

export type DocumentTrash = {
  /** Which requested document identities are still retained in this project's Trash. */
  retained(
    projectId: ProjectId,
    documentIds: readonly DocumentId[],
  ): Promise<ReadonlySet<DocumentId>>;
  /** Lists current restorable removals, newest first. */
  list(projectId: ProjectId): Promise<readonly DocumentTrashEntry[]>;
  /** Reads one restorable removal and its last settled text. */
  read(projectId: ProjectId, documentId: DocumentId): Promise<GetDocumentTrashResponse | null>;
  /** Whether a missing trash entry belonged here and has since been permanently purged. */
  wasPurged(projectId: ProjectId, documentId: DocumentId): Promise<boolean>;
  /** Permanently releases the content of eligible deleted documents. */
  purge(): Promise<number>;
};
