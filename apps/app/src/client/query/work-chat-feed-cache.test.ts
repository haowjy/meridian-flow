import type { ProjectChatItem, WorkChatFeedPage } from "@meridian/contracts/protocol";
import { type InfiniteData, QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { createProjectChatFeedCacheController } from "./home-chat-feed-cache";
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

  it("keeps an acknowledged field over a late Work page begun before the command", () => {
    const client = new QueryClient();
    const controller = createProjectChatFeedCacheController(client, "project-1");
    const request = controller.beginRequest();
    controller.command("thread-1", "isFavorite", true).succeed({
      threadId: "thread-1",
      isFavorite: true,
      manuallyUnread: true,
      lastOpenedAt: null,
      attention: "unread",
    });
    expect(
      controller.mergeWork(data().pages[0] ?? { items: [], nextCursor: null }, request).items[0],
    ).toMatchObject({
      isFavorite: true,
      attention: "unread",
    });
    controller.settleRequest(request);
  });

  it("settles overlapping fields independently in both failure orderings", () => {
    const key = ["projects", "project-1", "work-threads", "work-a"] as const;

    const favoriteFails = new QueryClient();
    favoriteFails.setQueryData(key, data());
    const first = createProjectChatFeedCacheController(favoriteFails, "project-1");
    const favorite = first.command("thread-1", "isFavorite", true);
    first.command("thread-1", "isUnread", false).succeed({
      threadId: "thread-1",
      isFavorite: false,
      manuallyUnread: false,
      lastOpenedAt: null,
      attention: "none",
    });
    favorite.fail();
    expect(
      favoriteFails.getQueryData<InfiniteData<WorkChatFeedPage>>(key)?.pages[0]?.items[0],
    ).toMatchObject({ isFavorite: false, attention: "none" });

    const unreadFails = new QueryClient();
    unreadFails.setQueryData(key, data());
    const second = createProjectChatFeedCacheController(unreadFails, "project-1");
    const unread = second.command("thread-1", "isUnread", false);
    second.command("thread-1", "isFavorite", true).succeed({
      threadId: "thread-1",
      isFavorite: true,
      manuallyUnread: true,
      lastOpenedAt: null,
      attention: "unread",
    });
    unread.fail();
    expect(
      unreadFails.getQueryData<InfiniteData<WorkChatFeedPage>>(key)?.pages[0]?.items[0],
    ).toMatchObject({ isFavorite: true, attention: "unread" });
  });
});
