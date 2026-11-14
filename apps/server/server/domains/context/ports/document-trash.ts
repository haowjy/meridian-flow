/** Restorable document trash and the retention path that eventually purges its content. */
import type { DocumentId, ProjectId } from "@meridian/contracts";
import type { DocumentTrashEntry } from "@meridian/contracts/protocol";

export type DocumentPurgeDraftDisposal = {
  /**
   * Inside the caller's transaction, which already holds the tree list's lock: takes the
   * documents' keys, then every active draft row that can write them, and answers `pending` when
   * a Work still has a reviewable change to one of them (the purge waits). Otherwise closes the
   * drafts that remain, so nothing writes the documents once their content is released.
   */
  settle(documentIds: readonly DocumentId[]): Promise<"pending" | "closed">;
};

export type DocumentTrash = {
  /** Which requested document identities are still retained in this project's Trash. */
  retained(
    projectId: ProjectId,
    documentIds: readonly DocumentId[],
  ): Promise<ReadonlySet<DocumentId>>;
  /** Lists current restorable removals, newest first. */
  list(projectId: ProjectId): Promise<readonly DocumentTrashEntry[]>;
  /** Reads one restorable removal and its text, serialized from its frozen Yjs. */
  read(projectId: ProjectId, documentId: DocumentId): Promise<DocumentTrashEntry | null>;
  /** Whether a missing trash entry belonged here and has since been permanently purged. */
  wasPurged(projectId: ProjectId, documentId: DocumentId): Promise<boolean>;
  /**
   * Retention: empties each Trash entry whose nodes have been in Trash for the retention window
   * (a `purge` record per entry, then the purged documents' content is released), and releases
   * a drafted create that left every view that long ago. Returns the documents released.
   */
  purge(): Promise<number>;
};
