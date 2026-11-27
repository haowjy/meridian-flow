import type { ProjectChatItem } from "@meridian/contracts/protocol";
import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { projectQueryKeys } from "./project-query-keys";
import {
  admitThreadUserStateItems,
  beginThreadUserStateFeedRequest,
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
  client.setQueryData(projectQueryKeys.chatFeed(PROJECT_ID), {
    pages: [
      {
        items: [item(isFavorite)],
        nextCursor: null,
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
  it("restores the last confirmed value and retries the failed value under overlap", async () => {
    const first = deferred<{ threadId: string; isFavorite: boolean }>();
    const second = deferred<{ threadId: string; isFavorite: boolean }>();
    mocks.updateThreadUserState
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const client = seededClient(false);

    const firstRun = runFavoriteCommand(client, PROJECT_ID, "thread-1", true);
    const secondRun = runFavoriteCommand(client, PROJECT_ID, "thread-1", false);
    expect(mocks.updateThreadUserState).toHaveBeenCalledTimes(1);

    first.resolve({ threadId: "thread-1", isFavorite: true });
    await firstRun;
    second.reject(new Error("refused"));
    await secondRun;

    const record = readRecord(client);
    expect(record.favorite).toBeUndefined();
    expect(record.favoriteError?.error).toBeInstanceOf(Error);
    expect(record.favoriteError?.desiredValue).toBe(false);
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
