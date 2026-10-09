/**
 * Test helper for whole-document writes: bind the Markdown first (outside any
 * transaction, as production doors do), then write the bound content.
 */
import type { DocumentId, ThreadId } from "@meridian/contracts/runtime";
import type { DocumentWriteOrigin, MarkdownDocumentStore } from "../contracts.js";

export async function writeMarkdown(
  documents: Pick<MarkdownDocumentStore, "bindMarkdown" | "writeDocument">,
  input: {
    documentId: DocumentId | string;
    markdown: string;
    origin: DocumentWriteOrigin;
    threadId?: ThreadId | string;
  },
) {
  const documentId = input.documentId as DocumentId;
  const content = await documents.bindMarkdown({
    holder: { documentId },
    markdown: input.markdown,
    against: "current",
  });
  return documents.writeDocument({
    documentId,
    content,
    origin: input.origin,
    ...(input.threadId ? { threadId: input.threadId as ThreadId } : {}),
  });
}
