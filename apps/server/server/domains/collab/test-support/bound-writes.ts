import type { DocumentId, ThreadId } from "@meridian/contracts/runtime";
import type { DocumentWriteOrigin, MarkdownDocumentStore } from "../contracts.js";
import type { BindMarkdownInput, BoundWrite } from "../domain/link-binding.js";

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

export function fakeBoundWrite({ holder, markdown }: BindMarkdownInput): BoundWrite {
  return {
    holder:
      "documentId" in holder
        ? { kind: "document", documentId: holder.documentId }
        : { kind: "new", uri: holder.uri },
    fresh: true,
    blocks: [],
    markdown,
    schemaType: "document",
  } as unknown as BoundWrite;
}
