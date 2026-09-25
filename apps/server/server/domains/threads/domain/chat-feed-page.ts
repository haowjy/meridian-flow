/**
 * Shared keyset page policy for the Project and Work chat feeds: decode the
 * opaque cursor, fetch one row past the page size, slice, and re-encode the
 * next cursor. Both feeds page over the same stored `lastActivityAt` sort key
 * (see `project-chat-cursor.ts`), so they share one cursor meaning and one
 * invalid-cursor error.
 */
import type { ProjectChatFeedPage, ProjectChatItem } from "@meridian/contracts/threads";
import { decodeProjectChatCursor, encodeProjectChatCursor } from "./project-chat-cursor.js";

export class InvalidChatFeedCursorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidChatFeedCursorError";
  }
}

export async function getChatFeedPage(input: {
  cursor?: string | null;
  invalidCursorMessage: string;
  pageSize: number;
  fetchPage: (
    after: ReturnType<typeof decodeProjectChatCursor> | null,
    limit: number,
  ) => Promise<ProjectChatItem[]>;
}): Promise<ProjectChatFeedPage> {
  let after: ReturnType<typeof decodeProjectChatCursor> | null = null;
  try {
    after = input.cursor == null ? null : decodeProjectChatCursor(input.cursor);
  } catch {
    throw new InvalidChatFeedCursorError(input.invalidCursorMessage);
  }
  const rows = await input.fetchPage(after, input.pageSize + 1);
  const pageItems = rows.slice(0, input.pageSize);
  const cursorItem = rows.length > input.pageSize ? pageItems.at(-1) : undefined;
  return {
    items: pageItems,
    nextCursor: cursorItem
      ? encodeProjectChatCursor({ sortAt: cursorItem.lastActivityAt, threadId: cursorItem.id })
      : null,
  };
}
