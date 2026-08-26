/** Cursor and page policy for the server-owned Home chat feed. */

import type { HomeChatFeedPage, ProjectChatItem } from "@meridian/contracts/threads";
import type { HomeChatFeedRepository } from "../ports/repositories.js";
import { decodeProjectChatCursor, encodeProjectChatCursor } from "./project-chat-cursor.js";

const PAGE_SIZE = 24;

export class InvalidHomeFeedCursorError extends Error {
  constructor() {
    super("Invalid Home feed cursor");
    this.name = "InvalidHomeFeedCursorError";
  }
}

export async function getHomeChatFeedPage(input: {
  repository: HomeChatFeedRepository;
  projectId: string;
  userId: string;
  cursor?: string | null;
}): Promise<HomeChatFeedPage> {
  let after = null;
  try {
    after = input.cursor == null ? null : decodeProjectChatCursor(input.cursor);
  } catch {
    throw new InvalidHomeFeedCursorError();
  }
  const result = await input.repository.queryPage({
    projectId: input.projectId,
    userId: input.userId,
    after,
    recentLimit: PAGE_SIZE + 1,
    includeFeatured: !after,
  });
  const recentItems = result.recent.slice(0, PAGE_SIZE);
  const cursorItem: ProjectChatItem | undefined =
    result.recent.length > PAGE_SIZE ? recentItems.at(-1) : undefined;
  return {
    featured: after ? null : { continueChat: result.continueChat, favoriteChats: result.favorites },
    recentChats: {
      items: recentItems,
      nextCursor: cursorItem
        ? encodeProjectChatCursor({
            sortAt: cursorItem.lastActivityAt,
            threadId: cursorItem.id,
          })
        : null,
    },
  };
}
