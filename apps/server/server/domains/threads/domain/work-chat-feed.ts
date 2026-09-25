/** Cursor and bounded-page policy for chats historically associated with a Work. */
import type { ProjectChatFeedPage } from "@meridian/contracts/threads";
import type { WorkChatFeedRepository } from "../ports/repositories.js";
import { getChatFeedPage } from "./chat-feed-page.js";

export const WORK_CHAT_PAGE_SIZE = 50;

export async function getWorkChatFeedPage(input: {
  repository: WorkChatFeedRepository;
  projectId: string;
  workId: string;
  userId: string;
  cursor?: string | null;
}): Promise<ProjectChatFeedPage> {
  return getChatFeedPage({
    cursor: input.cursor,
    invalidCursorMessage: "Invalid Work chat cursor",
    pageSize: WORK_CHAT_PAGE_SIZE,
    fetchPage: (after, limit) =>
      input.repository.queryPage({
        projectId: input.projectId,
        workId: input.workId,
        userId: input.userId,
        after,
        limit,
      }),
  });
}
