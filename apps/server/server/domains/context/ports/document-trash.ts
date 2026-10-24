/** Document trash retention and collab-owned draft disposal used by permanent purge. */
import type { DocumentId } from "@meridian/contracts/runtime";

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
  /** Permanently releases the content of eligible deleted documents. */
  purge(): Promise<number>;
};
