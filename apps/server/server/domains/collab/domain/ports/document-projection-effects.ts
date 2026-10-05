/** Activity effects of durable writes; document derivation owns projection publication. */
import type { DocumentId, ThreadId, WorkId } from "@meridian/contracts/runtime";

export type DocumentProjectionEffects = {
  touchDocumentActivity(input: {
    documentId: DocumentId;
    threadId?: ThreadId;
    at: Date;
  }): Promise<void>;
  applyPushCompletion(input: { documentId: DocumentId; workId?: WorkId; at: Date }): Promise<void>;
};
