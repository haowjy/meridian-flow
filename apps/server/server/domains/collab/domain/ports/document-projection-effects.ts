/** Activity effects of durable writes; document derivation owns projection writes. */
import type { DocumentId, ThreadId } from "@meridian/contracts/runtime";

export type DocumentProjectionEffects = {
  touchDocumentActivity(input: {
    documentId: DocumentId;
    threadId?: ThreadId;
    at: Date;
  }): Promise<void>;
};
