/** The host's chat-owned bytes for every file a conversation was sent as media. */
import type { StoredMediaPart } from "@meridian/contracts/threads";

export interface ChatMediaPort {
  /**
   * A file the chat is sent as media (a picture the writer attached, or a PDF a mention's read
   * shows the model) as the message stores it: its name, type and size, and the thread's own copy
   * of the bytes (`chatCopy`), so what the chat was sent never changes when the file does or goes.
   * Null: the file is nothing a model takes as media. A copy that fails throws
   * `MediaResolutionError`: the send or turn fails, and nothing reads the file in its place.
   */
  admit(
    threadId: string,
    documentId: string,
  ): Promise<Pick<StoredMediaPart, "mediaType" | "sizeBytes" | "name" | "chatCopy"> | null>;
}
