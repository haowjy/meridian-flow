/** Cursor and page policy for the server-owned Home chat feed. */

import type { ThreadId } from "@meridian/contracts/runtime";
import type { HomeChatFeedPage, HomeChatItem } from "@meridian/contracts/threads";
import { isUuid } from "../../../shared/uuid.js";
import type { HomeChatFeedRepository, HomeFeedCursorKey } from "../ports/repositories.js";

const PAGE_SIZE = 24;
const EXACT_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

export class InvalidHomeFeedCursorError extends Error {
  constructor() {
    super("Invalid Home feed cursor");
    this.name = "InvalidHomeFeedCursorError";
  }
}

export function encodeHomeFeedCursor(key: HomeFeedCursorKey): string {
  return Buffer.from(JSON.stringify({ v: 1, a: key.lastActivityAt, i: key.threadId })).toString(
    "base64url",
  );
}

export function decodeHomeFeedCursor(cursor: string): HomeFeedCursorKey {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    const record = value as Record<string, unknown>;
    if (
      Object.keys(record).sort().join(",") !== "a,i,v" ||
      record.v !== 1 ||
      typeof record.a !== "string" ||
      !EXACT_UTC_TIMESTAMP.test(record.a) ||
      typeof record.i !== "string" ||
      !isUuid(record.i)
    ) {
      throw new Error();
    }
    return { lastActivityAt: record.a, threadId: record.i.toLowerCase() as ThreadId };
  } catch {
    throw new InvalidHomeFeedCursorError();
  }
}

export async function getHomeChatFeedPage(input: {
  repository: HomeChatFeedRepository;
  projectId: string;
  userId: string;
  cursor?: string | null;
}): Promise<HomeChatFeedPage> {
  const after = input.cursor == null ? null : decodeHomeFeedCursor(input.cursor);
  const result = await input.repository.queryPage({
    projectId: input.projectId,
    userId: input.userId,
    after,
    recentLimit: PAGE_SIZE + 1,
    includeFeatured: !after,
  });
  const recentItems = result.recent.slice(0, PAGE_SIZE);
  const cursorItem: HomeChatItem | undefined =
    result.recent.length > PAGE_SIZE ? recentItems.at(-1) : undefined;
  return {
    featured: after ? null : { continueChat: result.continueChat, favoriteChats: result.favorites },
    recentChats: {
      items: recentItems,
      nextCursor: cursorItem
        ? encodeHomeFeedCursor({
            lastActivityAt: cursorItem.lastActivityAt,
            threadId: cursorItem.id as ThreadId,
          })
        : null,
    },
  };
}
