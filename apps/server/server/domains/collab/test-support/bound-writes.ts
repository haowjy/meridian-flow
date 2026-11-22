/**
 * Test helper for whole-document writes: bind the Markdown first (outside any
 * transaction, as production doors do), then write the bound content.
 */
import type { DocumentId, ThreadId } from "@meridian/contracts/runtime";
import type { DocumentRooms } from "@meridian/document-model/rooms";
import type { DocumentWriteOrigin, MarkdownDocumentStore } from "../contracts.js";
import type { BindMarkdownInput, BoundWrite } from "../domain/link-binding.js";
import { writeLiveMarkdown } from "./live-room-text.js";

/**
 * Given the domain's `rooms`, the text is also written into the document's Loro room, which the
 * model's Live tools read; the Markdown engine writes only the Yjs journal until it moves onto
 * `DocumentRooms`.
 */
export async function writeMarkdown(
  documents: Pick<MarkdownDocumentStore, "bindMarkdown" | "writeDocument"> & {
    rooms?: DocumentRooms<unknown>;
  },
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
  const written = await documents.writeDocument({
    documentId,
    content,
    origin: input.origin,
    ...(input.threadId ? { threadId: input.threadId as ThreadId } : {}),
  });
  if (documents.rooms) await writeLiveMarkdown(documents.rooms, documentId, input.markdown);
  return written;
}

/**
 * A fake binder's bound write, for ContextFS tests whose document sync is
 * a fake: it certifies the holder as the real one does and carries only the
 * source Markdown, which such fakes store.
 */
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
