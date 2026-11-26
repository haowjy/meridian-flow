import type { DocumentId, ProjectId } from "@meridian/contracts";
import type { DocumentTrashEntry, TrashEntryFacts } from "@meridian/contracts/protocol";

export type DocumentPurgeDisposal = {
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
