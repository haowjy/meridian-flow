import type { ThreadId } from "@meridian/contracts/runtime";

export interface TopPrimaryChat {
  chatId: ThreadId;
  chatRef: string;
}

export interface TopPrimaryChatResolver {
  resolveTopPrimaryChat(threadId: ThreadId): Promise<TopPrimaryChat | null>;
}
