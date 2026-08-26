/** Cursor and bounded-page policy for chats historically associated with a Work. */
import type { ThreadId } from "@meridian/contracts/runtime";
import type { WorkChatFeedPage } from "@meridian/contracts/threads";
import { isUuid } from "../../../shared/uuid.js";
import type { WorkChatFeedCursorKey, WorkChatFeedRepository } from "../ports/repositories.js";

export const WORK_CHAT_PAGE_SIZE = 50;
const EXACT_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

export class InvalidWorkChatFeedCursorError extends Error {
  constructor() {
    super("Invalid Work chat cursor");
    this.name = "InvalidWorkChatFeedCursorError";
  }
}

function isCanonicalBase64Url(value: string): boolean {
  return (
    /^[A-Za-z0-9_-]+$/.test(value) &&
    Buffer.from(value, "base64url").toString("base64url") === value
  );
}

function isExactTimestamp(value: string): boolean {
  if (!EXACT_UTC_TIMESTAMP.test(value) || value.startsWith("0000-")) return false;
  const milliseconds = Date.parse(`${value.slice(0, 23)}Z`);
  return (
    Number.isFinite(milliseconds) &&
    `${new Date(milliseconds).toISOString().slice(0, 23)}${value.slice(23)}` === value
  );
}

export function encodeWorkChatFeedCursor(key: WorkChatFeedCursorKey): string {
  return Buffer.from(JSON.stringify({ v: 1, u: key.updatedAt, i: key.threadId })).toString(
    "base64url",
  );
}

export function decodeWorkChatFeedCursor(cursor: string): WorkChatFeedCursorKey {
  try {
    if (!isCanonicalBase64Url(cursor)) throw new Error();
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    const record = value as Record<string, unknown>;
    if (
      Object.keys(record).sort().join(",") !== "i,u,v" ||
      record.v !== 1 ||
      typeof record.u !== "string" ||
      !isExactTimestamp(record.u) ||
      typeof record.i !== "string" ||
      !isUuid(record.i)
    )
      throw new Error();
    return { updatedAt: record.u, threadId: record.i.toLowerCase() as ThreadId };
  } catch {
    throw new InvalidWorkChatFeedCursorError();
  }
}

export async function getWorkChatFeedPage(input: {
  repository: WorkChatFeedRepository;
  projectId: string;
  workId: string;
  userId: string;
  cursor?: string | null;
}): Promise<WorkChatFeedPage> {
  const after = input.cursor == null ? null : decodeWorkChatFeedCursor(input.cursor);
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
      ? encodeWorkChatFeedCursor({
          updatedAt: last.updatedAt,
          threadId: last.item.id as ThreadId,
        })
      : null,
  };
}
