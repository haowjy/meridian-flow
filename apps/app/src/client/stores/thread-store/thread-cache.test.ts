import type {
  HomeChatFeedPage,
  ProjectChatItem,
  Thread,
  ThreadListItem,
  WorkChatFeedPage,
} from "@meridian/contracts/protocol";
import { type InfiniteData, QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import { projectQueryKeys } from "@/client/query/project-query-keys";
import { threadQueryKeys } from "@/client/query/thread-query-keys";
import { createThreadCache } from "./thread-cache";
import { createThreadStore } from "./thread-store";

const thread: Thread = {
  id: "thread-1",
  projectId: "project-1",
  workId: "work-1",
  userId: "user-1",
  kind: "primary",
  status: "active",
  title: "Target thread",
  slug: "target-thread",
  currentAgent: null,
  activeLeafTurnId: null,
  parentThreadId: null,
  rootThreadId: "thread-1",
  spawnDepth: 0,
  spawnStatus: null,
  totalCostUsd: "0",
  turnCount: 0,
  createdAt: "2026-08-26T00:00:00.000Z",
  updatedAt: "2026-08-26T00:00:00.000Z",
  deletedAt: null,
};

const chatItem = (id = thread.id): ProjectChatItem => ({
  id,
  title: id === thread.id ? "Target thread" : "Other thread",
  work: { id: "work-1", title: "Work 1" },
  lastMessagePreview: null,
  lastActivityAt: "2026-08-26T00:00:00.000Z",
  actionRequired: false,
  isFavorite: id === thread.id,
});

const workFeed = (items: ProjectChatItem[]): InfiniteData<WorkChatFeedPage, string | null> => ({
  pages: [{ items, nextCursor: null }],
  pageParams: [null],
});

const homeFeed = (target: ProjectChatItem): InfiniteData<HomeChatFeedPage, string | null> => ({
  pages: [
    {
      featured: { continueChat: null, favoriteChats: [target] },
      recentChats: { items: [chatItem("thread-2")], nextCursor: null },
    },
  ],
  pageParams: [null],
});

function cachedActionRequired(client: QueryClient): boolean[] {
  const projectThreads = client.getQueryData<ThreadListItem[]>(
    projectQueryKeys.threads(thread.projectId),
  );
  const home = client.getQueryData<InfiniteData<HomeChatFeedPage, string | null>>(
    projectQueryKeys.homeFeed(thread.projectId),
  );
  const works = ["work-1", "work-2"].map((workId) =>
    client.getQueryData<InfiniteData<WorkChatFeedPage, string | null>>(
      projectQueryKeys.workThreads(thread.projectId, workId),
    ),
  );
  return [
    projectThreads?.find(({ id }) => id === thread.id)?.actionRequired,
    home?.pages[0]?.featured?.continueChat?.actionRequired,
    home?.pages[0]?.featured?.favoriteChats.find(({ id }) => id === thread.id)?.actionRequired,
    home?.pages[0]?.recentChats.items.find(({ id }) => id === thread.id)?.actionRequired,
    ...works.map(
      (data) =>
        data?.pages.flatMap(({ items }) => items).find(({ id }) => id === thread.id)
          ?.actionRequired,
    ),
  ].filter((value): value is boolean => value !== undefined);
}

describe("createThreadCache lifecycle projection", () => {
  it("converges waiting, streaming, and reconciled snapshots across every cached feed", () => {
    const client = new QueryClient();
    const target = chatItem();
    client.setQueryData<ThreadListItem[]>(projectQueryKeys.threads(thread.projectId), [
      { ...thread, work: target.work, actionRequired: false, runningTurnId: null },
    ]);
    client.setQueryData(projectQueryKeys.homeFeed(thread.projectId), homeFeed(target));
    client.setQueryData(
      projectQueryKeys.workThreads(thread.projectId, "work-1"),
      workFeed([target]),
    );
    client.setQueryData(projectQueryKeys.workThreads(thread.projectId, "work-2"), {
      pages: [
        { items: [chatItem("thread-2")], nextCursor: "next" },
        { items: [target], nextCursor: null },
      ],
      pageParams: [null, "next"],
    } satisfies InfiniteData<WorkChatFeedPage, string | null>);
    const unrelatedKey = projectQueryKeys.workThreads("project-2", "work-1");
    client.setQueryData(unrelatedKey, workFeed([chatItem("thread-2")]));
    const cache = createThreadCache(client);
    const store = createThreadStore({ now: 0, threadCache: cache });

    store.getState().ensureAssistantTurn(thread.id, "turn-1");
    store.getState().patchTurnStatus(thread.id, "turn-1", "waiting_interrupt");
    expect(cachedActionRequired(client)).toEqual([true, true, true, true]);

    store.getState().patchTurnStatus(thread.id, "turn-1", "streaming");
    expect(cachedActionRequired(client)).toEqual([false, false, false, false]);
    expect(
      client
        .getQueryData<ThreadListItem[]>(projectQueryKeys.threads(thread.projectId))
        ?.find(({ id }) => id === thread.id)?.runningTurnId,
    ).toBe("turn-1");

    store.getState().applyThreadSnapshot(thread, [], {
      nextSeq: "1",
      lifecycle: { actionRequired: true, runningTurnId: null },
    });
    expect(cachedActionRequired(client)).toEqual([true, true, true, true]);
    store.getState().applyThreadSnapshot(thread, [], {
      nextSeq: "2",
      lifecycle: { actionRequired: false, runningTurnId: "turn-2" },
    });
    expect(cachedActionRequired(client)).toEqual([false, false, false, false]);

    expect(client.getQueryData(unrelatedKey)).toEqual(workFeed([chatItem("thread-2")]));
    expect(
      client
        .getQueryData<InfiniteData<HomeChatFeedPage, string | null>>(
          projectQueryKeys.homeFeed(thread.projectId),
        )
        ?.pages[0]?.featured?.favoriteChats.find(({ id }) => id === thread.id)?.isFavorite,
    ).toBe(true);
    expect(
      client.getQueryData<InfiniteData<WorkChatFeedPage, string | null>>(
        projectQueryKeys.workThreads(thread.projectId, "work-1"),
      )?.pages[0]?.items[0]?.isFavorite,
    ).toBe(true);
  });
});

describe("createThreadCache terminal invalidation", () => {
  it("uses the canonical project policy once and leaves unrelated keys valid", async () => {
    const client = new QueryClient();
    const projectId = "project-1";
    const threadId = "thread-1";
    const keys = [
      threadQueryKeys.snapshot(threadId),
      projectQueryKeys.threads(projectId),
      projectQueryKeys.works(projectId),
      projectQueryKeys.homeFeed(projectId),
      projectQueryKeys.workDrafts(projectId, "work-1"),
      projectQueryKeys.contextTree(projectId, "scratch", "work-1"),
    ] as const;
    const unrelated = [
      threadQueryKeys.snapshot("thread-2"),
      projectQueryKeys.workDrafts("project-2", "work-1"),
      projectQueryKeys.contextTree("project-2", "scratch", "work-1"),
    ] as const;

    for (const key of [...keys, ...unrelated]) client.setQueryData(key, { fresh: true });
    const invalidateQueries = vi.spyOn(client, "invalidateQueries");

    createThreadCache(client).invalidateThread(threadId, projectId);
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    for (const key of keys) {
      expect(client.getQueryState(key)?.isInvalidated, JSON.stringify(key)).toBe(true);
    }
    for (const key of unrelated) {
      expect(client.getQueryState(key)?.isInvalidated, JSON.stringify(key)).toBe(false);
    }
    expect(
      invalidateQueries.mock.calls.filter(
        ([filters]) =>
          JSON.stringify(filters?.queryKey) === JSON.stringify(threadQueryKeys.thread(threadId)),
      ),
    ).toHaveLength(1);
  });

  it("invalidates only the direct thread root when project identity is unavailable", async () => {
    const client = new QueryClient();
    const direct = [
      threadQueryKeys.snapshot("thread-1"),
      threadQueryKeys.uploads("thread-1"),
    ] as const;
    const unrelated = [
      threadQueryKeys.snapshot("thread-2"),
      projectQueryKeys.threads("project-1"),
      projectQueryKeys.works("project-1"),
      projectQueryKeys.homeFeed("project-1"),
    ] as const;
    for (const key of [...direct, ...unrelated]) client.setQueryData(key, { fresh: true });
    const invalidateQueries = vi.spyOn(client, "invalidateQueries");

    createThreadCache(client).invalidateThread("thread-1", null);
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    for (const key of direct) expect(client.getQueryState(key)?.isInvalidated).toBe(true);
    for (const key of unrelated) expect(client.getQueryState(key)?.isInvalidated).toBe(false);
    expect(invalidateQueries).toHaveBeenCalledTimes(1);
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: threadQueryKeys.thread("thread-1"),
    });
  });
});
