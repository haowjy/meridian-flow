/** Cursor and page policy for the server-owned Project chat feed. */

import type { ProjectChatFeedPage, ProjectChatItem } from "@meridian/contracts/threads";
import type { ProjectChatFeedRepository } from "../ports/repositories.js";
import { decodeProjectChatCursor, encodeProjectChatCursor } from "./project-chat-cursor.js";

const PAGE_SIZE = 24;

export class InvalidProjectFeedCursorError extends Error {
  constructor() {
    super("Invalid Project feed cursor");
    this.name = "InvalidProjectFeedCursorError";
  }
}

export async function getProjectChatFeedPage(input: {
  repository: ProjectChatFeedRepository;
  projectId: string;
  userId: string;
  cursor?: string | null;
  favorite?: boolean;
}): Promise<ProjectChatFeedPage> {
  let after = null;
  try {
    after = input.cursor == null ? null : decodeProjectChatCursor(input.cursor);
  } catch {
    throw new InvalidProjectFeedCursorError();
  }
  const result = await input.repository.queryPage({
    projectId: input.projectId,
    userId: input.userId,
    after,
    limit: PAGE_SIZE + 1,
    favorite: input.favorite ?? false,
  });
  const recentItems = result.slice(0, PAGE_SIZE);
  const cursorItem: ProjectChatItem | undefined =
    result.length > PAGE_SIZE ? recentItems.at(-1) : undefined;
  return {
    items: recentItems,
    nextCursor: cursorItem
      ? encodeProjectChatCursor({
          sortAt: cursorItem.lastActivityAt,
          threadId: cursorItem.id,
        })
      : null,
  };
}
