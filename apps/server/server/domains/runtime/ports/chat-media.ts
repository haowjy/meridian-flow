/** The host's chat-owned bytes for the pictures a writer sends. */
import type { StoredMediaPart } from "@meridian/contracts/threads";

export interface ChatMediaPort {
  /**
   * The writer's uploaded picture as the message stores it: its name, type and size, and the
   * thread's own copy of the bytes (`chatCopy`) so it outlives the upload. Null: the file is no
   * picture the server can name. A copy that could not be made is left off; the message then
   * reads the upload, as before.
   */
  admit(
    threadId: string,
    documentId: string,
  ): Promise<Pick<StoredMediaPart, "mediaType" | "sizeBytes" | "name" | "chatCopy"> | null>;
}
