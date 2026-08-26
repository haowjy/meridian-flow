import type { ProjectChatItem } from "@meridian/contracts/threads";
import { describe, expect, it } from "vitest";
import type { WorkChatFeedRepository, WorkChatFeedRow } from "../ports/repositories.js";
import { decodeProjectChatCursor } from "./project-chat-cursor.js";
import {
  getWorkChatFeedPage,
  InvalidWorkChatFeedCursorError,
  WORK_CHAT_PAGE_SIZE,
} from "./work-chat-feed.js";

const stamp = "2026-08-20T12:00:00.123456Z";
const id = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
const row = (index: number): WorkChatFeedRow => ({
  updatedAt: stamp,
  item: {
    id: id(index),
    title: `Chat ${index}`,
    work: { id: "work-current", title: "Current Work" },
    lastMessagePreview: `Preview ${index}`,
    lastActivityAt: stamp,
    attention: index === 55 ? "actionRequired" : index === 54 ? "unread" : "none",
    isFavorite: index === 53,
  } satisfies ProjectChatItem,
});

describe("Work chat feed page policy", () => {
  it("bounds pages and uses updatedAt plus descending id as an exclusive cursor", async () => {
    const rows = Array.from({ length: 55 }, (_, index) => row(55 - index));
    const repository: WorkChatFeedRepository = {
      queryPage: async ({ after, limit }) =>
        rows
          .filter(
            ({ updatedAt, item }) =>
              !after ||
              updatedAt < after.sortAt ||
              (updatedAt === after.sortAt && item.id < after.threadId),
          )
          .slice(0, limit),
    };
    const first = await getWorkChatFeedPage({
      repository,
      projectId: "project",
      workId: "historical-work",
      userId: "user",
    });
    expect(first.items).toHaveLength(WORK_CHAT_PAGE_SIZE);
    expect(first.items[0]).toMatchObject({
      id: id(55),
      work: { id: "work-current", title: "Current Work" },
      lastMessagePreview: "Preview 55",
      attention: "actionRequired",
    });
    expect(first.items[2]?.isFavorite).toBe(true);
    const cursor = first.nextCursor;
    if (!cursor) throw new Error("missing cursor");
    expect(decodeProjectChatCursor(cursor)).toEqual({ sortAt: stamp, threadId: id(6) });
    const second = await getWorkChatFeedPage({
      repository,
      projectId: "project",
      workId: "historical-work",
      userId: "user",
      cursor,
    });
    expect(second.items.map(({ id: threadId }) => threadId)).toEqual([
      id(5),
      id(4),
      id(3),
      id(2),
      id(1),
    ]);
    expect(new Set([...first.items, ...second.items].map(({ id }) => id)).size).toBe(55);
  });

  it("maps malformed cursors to the Work-specific page error", async () => {
    const repository: WorkChatFeedRepository = { queryPage: async () => [] };
    for (const cursor of ["not-json", "e30"]) {
      await expect(
        getWorkChatFeedPage({
          repository,
          projectId: "project",
          workId: "work",
          userId: "user",
          cursor,
        }),
      ).rejects.toBeInstanceOf(InvalidWorkChatFeedCursorError);
    }
  });
});
