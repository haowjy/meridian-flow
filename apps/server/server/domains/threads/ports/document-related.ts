/** Port: which chats worked on a document and which pages it links to. */

import type { DocumentRelated } from "@meridian/contracts/protocol";

export interface DocumentRelatedReader {
  /**
   * Top-level chats of `projectId` that `userId` owns and that read or edited the document,
   * newest first. Access to the document itself is the caller's to check.
   */
  listChats(input: {
    documentId: string;
    projectId: string;
    userId: string;
    limit: number;
  }): Promise<DocumentRelated["chats"]>;
  /** Documents this document's Live text links to, most linked first. */
  listMentions(documentId: string): Promise<DocumentRelated["mentions"]>;
}
