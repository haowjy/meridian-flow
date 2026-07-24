/** Read-model effects applied after a durable collab document write. */
import type { DocumentId, ThreadId, WorkId } from "@meridian/contracts/runtime";

export type ThreadDocumentActivitySelection =
  | { kind: "thread"; threadId: ThreadId }
  | { kind: "all" }
  | { kind: "none" };

export type WorkActivitySelection =
  | { kind: "document_scope" }
  | { kind: "work"; workId: WorkId }
  | { kind: "none" };

export type ProjectActivitySelection =
  | {
      kind: "document_scope";
      includeWorkProject: boolean;
      activeDocumentsOnly: boolean;
    }
  | { kind: "none" };

export type DocumentProjectionEffects = {
  apply(input: {
    documentId: DocumentId;
    markdown: string;
    at: Date;
    threadDocuments: ThreadDocumentActivitySelection;
    work: WorkActivitySelection;
    project: ProjectActivitySelection;
  }): Promise<void>;
};
