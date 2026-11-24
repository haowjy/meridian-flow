import type { StoredMediaPart } from "@meridian/contracts/threads";

export interface ChatMediaPort {
  admit(
    threadId: string,
    documentId: string,
  ): Promise<Pick<StoredMediaPart, "mediaType" | "sizeBytes" | "name" | "chatCopy"> | null>;
}
