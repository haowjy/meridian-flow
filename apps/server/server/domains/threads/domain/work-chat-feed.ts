/** Cursor and bounded-page policy for chats historically associated with a Work. */
import type { WorkChatFeedPage } from "@meridian/contracts/threads";
import type { WorkChatFeedRepository } from "../ports/repositories.js";
import { decodeProjectChatCursor, encodeProjectChatCursor } from "./project-chat-cursor.js";

export const WORK_CHAT_PAGE_SIZE = 50;

export class InvalidWorkChatFeedCursorError extends Error {
  constructor() {
    super("Invalid Work chat cursor");
    this.name = "InvalidWorkChatFeedCursorError";
  }
}

export async function getWorkChatFeedPage(input: {
  repository: WorkChatFeedRepository;
  projectId: string;
  workId: string;
  userId: string;
  cursor?: string | null;
}): Promise<WorkChatFeedPage> {
  let after = null;
  try {
    after = input.cursor == null ? null : decodeProjectChatCursor(input.cursor);
  } catch {
    throw new InvalidWorkChatFeedCursorError();
  }
  const rows = await input.repository.queryPage({
    projectId: input.projectId,
    workId: input.workId,
    userId: input.userId,
    after,
    limit: WORK_CHAT_PAGE_SIZE + 1,
  });
  const pageRows = rows.slice(0, WORK_CHAT_PAGE_SIZE);
  const last = rows.length > WORK_CHAT_PAGE_SIZE ? pageRows.at(-1) : undefined;
  return {
    items: pageRows.map(({ item }) => item),
    nextCursor: last
      ? encodeProjectChatCursor({
          sortAt: last.updatedAt,
          threadId: last.item.id,
        })
      : null,
  };
}
