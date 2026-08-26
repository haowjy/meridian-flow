import type { ProjectChatItem, WorkChatFeedPage } from "@meridian/contracts/protocol";
import { type InfiniteData, QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { createWorkChatFeedCacheCommand } from "./work-chat-feed-cache";

const item: ProjectChatItem = {
  id: "thread-1",
  title: "Chat",
  work: { id: "work-current", title: "Current Work" },
  lastMessagePreview: "Preview",
  lastActivityAt: "2026-08-01T00:00:00.000000Z",
  attention: "unread",
  isFavorite: false,
};
const data = (): InfiniteData<WorkChatFeedPage, string | null> => ({
  pages: [{ items: [item], nextCursor: null }],
  pageParams: [null],
});

describe("Work chat user-state cache", () => {
  it("updates every Work leaf in the project and leaves other projects isolated", () => {
    const client = new QueryClient();
    const first = ["projects", "project-1", "work-threads", "work-a"] as const;
    const second = ["projects", "project-1", "work-threads", "work-b"] as const;
    const other = ["projects", "project-2", "work-threads", "work-a"] as const;
    for (const key of [first, second, other]) client.setQueryData(key, data());
    const command = createWorkChatFeedCacheCommand(
      client,
      "project-1",
      "thread-1",
      "isFavorite",
      true,
    );
    expect(
      client.getQueryData<InfiniteData<WorkChatFeedPage>>(first)?.pages[0]?.items[0]?.isFavorite,
    ).toBe(true);
    expect(
      client.getQueryData<InfiniteData<WorkChatFeedPage>>(second)?.pages[0]?.items[0]?.isFavorite,
    ).toBe(true);
    expect(
      client.getQueryData<InfiniteData<WorkChatFeedPage>>(other)?.pages[0]?.items[0]?.isFavorite,
    ).toBe(false);
    command.succeed({
      threadId: "thread-1",
      isFavorite: true,
      manuallyUnread: false,
      lastOpenedAt: null,
      attention: "none",
    });
    expect(
      client.getQueryData<InfiniteData<WorkChatFeedPage>>(first)?.pages[0]?.items[0],
    ).toMatchObject({
      isFavorite: true,
      attention: "none",
    });
  });

  it("rolls every affected page back on transport failure", () => {
    const client = new QueryClient();
    const key = ["projects", "project-1", "work-threads", "work-a"] as const;
    client.setQueryData(key, data());
    const command = createWorkChatFeedCacheCommand(
      client,
      "project-1",
      "thread-1",
      "isUnread",
      false,
    );
    expect(
      client.getQueryData<InfiniteData<WorkChatFeedPage>>(key)?.pages[0]?.items[0]?.attention,
    ).toBe("none");
    command.fail();
    expect(
      client.getQueryData<InfiniteData<WorkChatFeedPage>>(key)?.pages[0]?.items[0]?.attention,
    ).toBe("unread");
  });
});
