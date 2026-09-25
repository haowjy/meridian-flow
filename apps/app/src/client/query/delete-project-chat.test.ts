/**
 * Contract tests for optimistic chat delete: the row and its user-state record
 * leave the cache before the server confirms, and a failure restores both from
 * an exact pre-delete snapshot.
 */
import type { ProjectChatItem, ThreadListItem } from "@meridian/contracts/protocol";
import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { flattenChatFeed } from "./chat-projections";
import { deleteProjectChat } from "./delete-project-chat";
import { projectQueryKeys } from "./project-query-keys";

const api = vi.hoisted(() => ({ deleteThread: vi.fn() }));
vi.mock("@/client/api/threads-api", () => ({ deleteThread: api.deleteThread }));

const PROJECT_ID = "project-1";
const THREAD_ID = "thread-1";

function threadListItem(): ThreadListItem {
  return {
    id: THREAD_ID,
    projectId: PROJECT_ID,
    title: "River",
    work: null,
    actionRequired: false,
    runningTurnId: null,
  } as unknown as ThreadListItem;
}

function chatItem(): ProjectChatItem {
  return {
    id: THREAD_ID,
    title: "River",
    work: null,
    agentName: null,
    lastMessagePreview: null,
    lastActivityAt: "2026-09-24T12:00:00.000Z",
    actionRequired: false,
    isFavorite: true,
  };
}

const feedKey = projectQueryKeys.chatFeedFilter(PROJECT_ID, { favorite: false, search: null });

function seededClient(): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(projectQueryKeys.threads(PROJECT_ID), [threadListItem()]);
  client.setQueryData(feedKey, {
    pages: [{ items: [chatItem()], nextCursor: null }],
    pageParams: [null],
  });
  client.setQueryData(projectQueryKeys.threadUserState(PROJECT_ID, THREAD_ID), {
    isFavorite: true,
  });
  return client;
}

beforeEach(() => {
  api.deleteThread.mockReset();
});

describe("deleteProjectChat", () => {
  it("removes the row and its user-state record before the server confirms", async () => {
    let resolveDelete!: () => void;
    api.deleteThread.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveDelete = resolve;
      }),
    );
    const client = seededClient();

    const pending = deleteProjectChat(client, PROJECT_ID, THREAD_ID);

    // Optimistic: gone from every cache immediately, before the server call settles.
    expect(client.getQueryData<ThreadListItem[]>(projectQueryKeys.threads(PROJECT_ID))).toEqual([]);
    expect(flattenChatFeed(client.getQueryData(feedKey))).toEqual([]);
    expect(
      client.getQueryData(projectQueryKeys.threadUserState(PROJECT_ID, THREAD_ID)),
    ).toBeUndefined();

    resolveDelete();
    const outcome = await pending;
    expect(outcome.status).toBe("success");
  });

  it("restores the row and its user-state record when the server rejects the delete", async () => {
    api.deleteThread.mockRejectedValueOnce(new Error("offline"));
    const client = seededClient();

    const outcome = await deleteProjectChat(client, PROJECT_ID, THREAD_ID);

    expect(outcome.status).toBe("error");
    expect(
      client.getQueryData<ThreadListItem[]>(projectQueryKeys.threads(PROJECT_ID)),
    ).toHaveLength(1);
    expect(flattenChatFeed(client.getQueryData(feedKey))).toHaveLength(1);
    expect(client.getQueryData(projectQueryKeys.threadUserState(PROJECT_ID, THREAD_ID))).toEqual({
      isFavorite: true,
    });
  });
});
