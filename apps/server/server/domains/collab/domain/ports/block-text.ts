import type { DraftId } from "@meridian/contracts";
import type { DocumentId } from "@meridian/contracts/runtime";

export type BlockText = {
  grepTexts(ids: DocumentId[], reader: { draft: DraftId | null }): Promise<Map<DocumentId, string>>;
  wordCounts(ids: DocumentId[]): Promise<Map<DocumentId, number>>;
};
