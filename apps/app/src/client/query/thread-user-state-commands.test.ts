/**
 * Contract tests for the Project-chat favorite command owner (P1).
 *
 * The owner keeps the normalized projection, per-entity serialization, and the
 * stale-feed barrier. These tests pin the failure payload: a rejected command
 * must retain the exact failed intent so the shared row can retry it, and an
 * older write must not overwrite a newer intent or a newer admitted feed.
 */
import type { ProjectChatItem } from "@meridian/contracts/protocol";
import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { projectQueryKeys } from "./project-query-keys";
import {
  admitThreadUserStateItems,
  beginThreadUserStateFeedRequest,
  getFavoriteCommandView,
  getThreadUserStateRecord,
  runFavoriteCommand,
} from "./thread-user-state-commands";

const mocks = vi.hoisted(() => ({
  updateThreadUserState: vi.fn(),
}));

vi.mock("@/client/api/threads-api", () => ({
  updateThreadUserState: mocks.updateThreadUserState,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const item = (isFavorite = false): ProjectChatItem => ({
  id: "thread-1",
  title: "River",
  work: { id: "work-1", title: "First Work" },
  agentName: "Muse",
  lastMessagePreview: "Keep climbing.",
  lastActivityAt: "2025-08-13T15:30:00.000Z",
  actionRequired: false,
  isFavorite,
});

const PROJECT_ID = "project-1";

function seededClient(isFavorite = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(projectQueryKeys.homeFeed(PROJECT_ID), {
    pages: [
      {
        featured: { continueChat: null, favoriteChats: [] },
        recentChats: { items: [item(isFavorite)], nextCursor: null },
      },
    ],
    pageParams: [null],
  });
  return client;
}

const readRecord = (client: QueryClient) => getThreadUserStateRecord(client, PROJECT_ID, item());

beforeEach(() => {
  mocks.updateThreadUserState.mockReset();
});

describe("runFavoriteCommand", () => {
  it("retains the exact failed intent for retry on rejection", async () => {
    mocks.updateThreadUserState.mockRejectedValueOnce(new Error("refused"));
    const client = seededClient(false);

    const outcome = await runFavoriteCommand(client, PROJECT_ID, "thread-1", true);
    expect(outcome.status).toBe("error");

    const record = readRecord(client);
    expect(record.base.isFavorite).toBe(false);
    const view = getFavoriteCommandView(record);
    expect(view.pending).toBe(false);
    expect(view.error).toBeInstanceOf(Error);
    // Retry must re-dispatch the value that failed, not derive `!isFavorite`.
    expect(view.retryValue).toBe(true);
  });

  it("restores the last confirmed value and retries the failed value under overlap", async () => {
    const first = deferred<{ threadId: string; isFavorite: boolean }>();
    const second = deferred<{ threadId: string; isFavorite: boolean }>();
    mocks.updateThreadUserState
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const client = seededClient(false);

    const firstRun = runFavoriteCommand(client, PROJECT_ID, "thread-1", true);
    const secondRun = runFavoriteCommand(client, PROJECT_ID, "thread-1", false);
    // Serialized per entity: only the first request is in flight.
    expect(mocks.updateThreadUserState).toHaveBeenCalledTimes(1);

    first.resolve({ threadId: "thread-1", isFavorite: true });
    await firstRun;
    second.reject(new Error("refused"));
    await secondRun;

    const view = getFavoriteCommandView(readRecord(client));
    expect(view.pending).toBe(false);
    expect(view.error).toBeInstanceOf(Error);
    // The failed intent was `false`; the inverse derivation would yield `true`.
    expect(view.retryValue).toBe(false);
    // The first write confirmed `true`, so the base is not reverted to `false`.
    expect(readRecord(client).base.isFavorite).toBe(true);
  });

  it("keeps an older admitted feed page from overwriting a newer confirmed base", async () => {
    const client = seededClient(false);
    const generation = beginThreadUserStateFeedRequest(client, PROJECT_ID);
    mocks.updateThreadUserState.mockResolvedValueOnce({
      threadId: "thread-1",
      isFavorite: true,
    });

    await runFavoriteCommand(client, PROJECT_ID, "thread-1", true);
    expect(readRecord(client).base.isFavorite).toBe(true);

    admitThreadUserStateItems(client, PROJECT_ID, [item(false)], generation);

    expect(readRecord(client).base.isFavorite).toBe(true);
  });
});
