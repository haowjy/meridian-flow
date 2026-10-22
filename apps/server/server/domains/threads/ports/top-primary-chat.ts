/**
 * Port for "whose uploads": the chat a thread belongs to. A chat is a primary thread plus its
 * subagents; a fork or handoff is a primary thread of its own, so it is its own chat.
 */

import type { ThreadId } from "@meridian/contracts/runtime";

export interface TopPrimaryChat {
  chatId: ThreadId;
  /** The chat's handle, `c12`. */
  chatRef: string;
}

export interface TopPrimaryChatResolver {
  /** Walk `parent_thread_id` to the `kind = 'primary'` thread; null when the thread is unknown. */
  resolveTopPrimaryChat(threadId: ThreadId): Promise<TopPrimaryChat | null>;
}
