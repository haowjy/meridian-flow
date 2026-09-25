/**
 * Contract tests for the one canonical chat-row projection writer: a patch (or
 * `null` removal) reaches the project thread list, every chat-feed page, and
 * every Work-feed page in one batch, and a snapshot can restore all three.
 */
import type { ProjectChatItem, ThreadListItem } from "@meridian/contracts/protocol";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import {
  type ChatFeedData,
  flattenChatFeed,
  patchChatRow,
  removeChatRow,
  restoreChatRow,
  snapshotChatRow,
} from "./chat-projections";
import { projectQueryKeys } from "./project-query-keys";

const PROJECT_ID = "project-1";
const OTHER_PROJECT_ID = "project-2";
const THREAD_ID = "thread-1";
const WORK_ID = "work-1";

function threadListItem(overrides: Partial<ThreadListItem> = {}): ThreadListItem {
  return {
    id: THREAD_ID,
    projectId: PROJECT_ID,
    title: "River",
    work: null,
    actionRequired: false,
    runningTurnId: null,
    ...overrides,
  } as unknown as ThreadListItem;
}

function chatItem(overrides: Partial<ProjectChatItem> = {}): ProjectChatItem {
  return {
    id: THREAD_ID,
    title: "River",
    work: null,
    agentName: null,
    lastMessagePreview: null,
    lastActivityAt: "2026-09-24T12:00:00.000Z",
    actionRequired: false,
    isFavorite: false,
    ...overrides,
  };
}

const page = (items: ProjectChatItem[]): ChatFeedData => ({
  pages: [{ items, nextCursor: null }],
  pageParams: [null],
});

const allKey = projectQueryKeys.chatFeedFilter(PROJECT_ID, { favorite: false, search: null });
const favoriteKey = projectQueryKeys.chatFeedFilter(PROJECT_ID, { favorite: true, search: null });
const workKey = projectQueryKeys.workThreads(PROJECT_ID, WORK_ID);

function seededClient(): QueryClient {
  const client = new QueryClient();
  client.setQueryData(projectQueryKeys.threads(PROJECT_ID), [threadListItem()]);
  client.setQueryData(allKey, page([chatItem()]));
  client.setQueryData(favoriteKey, page([chatItem({ isFavorite: true })]));
  client.setQueryData(workKey, page([chatItem()]));
  return client;
}

describe("patchChatRow", () => {
  it("patches the thread list and every chat/Work feed page in one call", () => {
    const client = seededClient();

    patchChatRow(client, PROJECT_ID, THREAD_ID, {
      threadListItem: (item) => ({ ...item, title: "Renamed" }),
      projectChatItem: (item) => ({ ...item, title: "Renamed" }),
    });

    expect(
      client.getQueryData<ThreadListItem[]>(projectQueryKeys.threads(PROJECT_ID))?.[0]?.title,
    ).toBe("Renamed");
    expect(flattenChatFeed(client.getQueryData(allKey))[0]?.title).toBe("Renamed");
    expect(flattenChatFeed(client.getQueryData(favoriteKey))[0]?.title).toBe("Renamed");
    expect(flattenChatFeed(client.getQueryData(workKey))[0]?.title).toBe("Renamed");
  });

  it("only touches the shapes a patch actually supplies", () => {
    const client = seededClient();

    patchChatRow(client, PROJECT_ID, THREAD_ID, {
      projectChatItem: (item) => ({ ...item, isFavorite: true }),
    });

    // The thread list has no Favorite field; a Favorite-only patch must not
    // touch it.
    expect(
      client.getQueryData<ThreadListItem[]>(projectQueryKeys.threads(PROJECT_ID))?.[0],
    ).toMatchObject({ title: "River" });
    expect(flattenChatFeed(client.getQueryData(allKey))[0]?.isFavorite).toBe(true);
  });

  it("removes the row from the thread list and every feed page via a null patch", () => {
    const client = seededClient();

    removeChatRow(client, PROJECT_ID, THREAD_ID);

    expect(client.getQueryData<ThreadListItem[]>(projectQueryKeys.threads(PROJECT_ID))).toEqual([]);
    expect(flattenChatFeed(client.getQueryData(allKey))).toEqual([]);
    expect(flattenChatFeed(client.getQueryData(favoriteKey))).toEqual([]);
    expect(flattenChatFeed(client.getQueryData(workKey))).toEqual([]);
  });

  it("leaves another project's caches untouched when scoped to one project", () => {
    const client = seededClient();
    client.setQueryData(projectQueryKeys.threads(OTHER_PROJECT_ID), [
      threadListItem({ projectId: OTHER_PROJECT_ID }),
    ]);

    removeChatRow(client, PROJECT_ID, THREAD_ID);

    expect(
      client.getQueryData<ThreadListItem[]>(projectQueryKeys.threads(OTHER_PROJECT_ID)),
    ).toHaveLength(1);
  });

  it("reaches every mounted project's caches when no project is given (lifecycle signal)", () => {
    const client = seededClient();
    client.setQueryData(projectQueryKeys.threads(OTHER_PROJECT_ID), [
      threadListItem({ id: THREAD_ID, projectId: OTHER_PROJECT_ID }),
    ]);
    const otherAllKey = projectQueryKeys.chatFeedFilter(OTHER_PROJECT_ID, {
      favorite: false,
      search: null,
    });
    client.setQueryData(otherAllKey, page([chatItem()]));

    patchChatRow(client, undefined, THREAD_ID, {
      threadListItem: (item) => ({ ...item, actionRequired: true }),
      projectChatItem: (item) => ({ ...item, actionRequired: true }),
    });

    expect(
      client.getQueryData<ThreadListItem[]>(projectQueryKeys.threads(PROJECT_ID))?.[0]
        ?.actionRequired,
    ).toBe(true);
    expect(
      client.getQueryData<ThreadListItem[]>(projectQueryKeys.threads(OTHER_PROJECT_ID))?.[0]
        ?.actionRequired,
    ).toBe(true);
    expect(flattenChatFeed(client.getQueryData(allKey))[0]?.actionRequired).toBe(true);
    expect(flattenChatFeed(client.getQueryData(otherAllKey))[0]?.actionRequired).toBe(true);
  });
});

describe("snapshotChatRow / restoreChatRow", () => {
  it("restores every cache a delete touched, from an exact pre-delete snapshot", () => {
    const client = seededClient();
    const snapshot = snapshotChatRow(client, PROJECT_ID, THREAD_ID);

    removeChatRow(client, PROJECT_ID, THREAD_ID);
    expect(client.getQueryData<ThreadListItem[]>(projectQueryKeys.threads(PROJECT_ID))).toEqual([]);

    restoreChatRow(client, PROJECT_ID, THREAD_ID, snapshot);

    expect(
      client.getQueryData<ThreadListItem[]>(projectQueryKeys.threads(PROJECT_ID)),
    ).toHaveLength(1);
    expect(flattenChatFeed(client.getQueryData(allKey))).toHaveLength(1);
    expect(flattenChatFeed(client.getQueryData(favoriteKey))).toHaveLength(1);
    expect(flattenChatFeed(client.getQueryData(workKey))).toHaveLength(1);
  });
});
