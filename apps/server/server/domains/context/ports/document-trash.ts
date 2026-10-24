/** Restorable document tombstones exposed through the project trash. */
import type { DocumentId, ProjectId } from "@meridian/contracts";
import type { DocumentTrashEntry, GetDocumentTrashResponse } from "@meridian/contracts/protocol";

export type DocumentTrash = {
  /** Lists current restorable removals, newest first. */
  list(projectId: ProjectId): Promise<readonly DocumentTrashEntry[]>;
  /** Reads one restorable removal and its last settled text. */
  read(projectId: ProjectId, documentId: DocumentId): Promise<GetDocumentTrashResponse | null>;
};
