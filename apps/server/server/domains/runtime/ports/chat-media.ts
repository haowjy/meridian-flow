/** The host's chat-owned bytes for the pictures a writer sends. */
import type { StoredMediaPart } from "@meridian/contracts/threads";

export interface ChatMediaPort {
  /**
   * Copy the writer's uploaded picture into the thread's own storage and name the copy. Null: the
   * copy could not be made; the message is stored without it and reads the upload, as before.
   */
  keep(threadId: string, documentId: string): Promise<StoredMediaPart["chatCopy"] | null>;
}
