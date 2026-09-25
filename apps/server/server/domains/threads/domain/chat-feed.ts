/** Cursor and page policy for the server-owned Project chat feed. */

import type { ProjectChatFeedPage } from "@meridian/contracts/threads";
import type { ProjectChatFeedRepository } from "../ports/repositories.js";
import { getChatFeedPage } from "./chat-feed-page.js";

const PAGE_SIZE = 24;
const MAX_SEARCH_LENGTH = 200;

export async function getProjectChatFeedPage(input: {
  repository: ProjectChatFeedRepository;
  projectId: string;
  userId: string;
  cursor?: string | null;
  favorite?: boolean;
  search?: string | null;
}): Promise<ProjectChatFeedPage> {
  const search = input.search?.trim().slice(0, MAX_SEARCH_LENGTH) || null;
  return getChatFeedPage({
    cursor: input.cursor,
    invalidCursorMessage: "Invalid Project chat cursor",
    pageSize: PAGE_SIZE,
    fetchPage: (after, limit) =>
      input.repository.queryPage({
        projectId: input.projectId,
        userId: input.userId,
        after,
        limit,
        favorite: input.favorite ?? false,
        search,
      }),
  });
}
