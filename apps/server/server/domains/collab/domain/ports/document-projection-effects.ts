/** Read-model effects applied after a durable collab document write. */
import type { DocumentId, ThreadId, WorkId } from "@meridian/contracts/runtime";

export type DocumentProjectionEffects = {
  updateProjection(input: { documentId: DocumentId; markdown: string; at: Date }): Promise<void>;
  touchDocumentActivity(input: {
    documentId: DocumentId;
    threadId?: ThreadId;
    at: Date;
  }): Promise<void>;
  applyPushCompletion(input: {
    documentId: DocumentId;
    markdown: string;
    workId?: WorkId;
    at: Date;
  }): Promise<void>;
};
