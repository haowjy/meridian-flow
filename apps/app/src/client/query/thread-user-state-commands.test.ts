/** Behavioral coverage for optimistic favorite convergence. */
import type { ProjectChatItem } from "@meridian/contracts/protocol";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { groupHomeFeed, type HomeFeedData } from "./home-chat-feed-cache";
import { projectQueryKeys } from "./project-query-keys";
import {
  admitThreadUserStateItems,
  beginThreadUserStateFeedRequest,
  getFavoriteCommandView,
  getThreadUserStateRecord,
  runFavoriteCommand,
  type ThreadUserStateRecord,
} from "./thread-user-state-commands";

const thread = (): ProjectChatItem => ({
  id: "thread-1",
  title: "River",
  work: null,
  lastMessagePreview: null,
  lastActivityAt: "2026-08-13T00:00:00.000Z",
  actionRequired: false,
  isFavorite: false,
});
const seed = (client: QueryClient) =>
  client.setQueryData<HomeFeedData>(projectQueryKeys.homeFeed("project-1"), {
    pages: [
      {
        featured: { continueChat: thread(), favoriteChats: [] },
        recentChats: { items: [], nextCursor: null },
      },
    ],
    pageParams: [null],
  });
const response = (isFavorite: boolean) => ({ threadId: "thread-1", isFavorite });
const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
const record = (client: QueryClient) => {
  const value = client.getQueryData<ThreadUserStateRecord>(
    projectQueryKeys.threadUserState("project-1", "thread-1"),
  );
  if (!value) throw new Error("missing normalized thread state");
  return value;
};

afterEach(() => vi.unstubAllGlobals());

describe("thread favorite command authority", () => {
  it("optimistically projects favorite and rolls back after failure", async () => {
    const client = new QueryClient();
    seed(client);
    let reject!: (error: Error) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((_, fail) => {
            reject = fail;
          }),
      ),
    );
    const observations: boolean[] = [];
    const command = runFavoriteCommand(client, "project-1", "thread-1", true, {
      beforeRollback: () =>
        observations.push(
          groupHomeFeed(client.getQueryData(projectQueryKeys.homeFeed("project-1"))).continueChat
            ?.isFavorite ?? false,
        ),
    });
    expect(getFavoriteCommandView(record(client))).toMatchObject({
      pending: true,
      desiredValue: true,
    });
    reject(new Error("offline"));
    await expect(command).resolves.toMatchObject({ status: "error" });
    expect(observations).toEqual([true]);
    expect(
      groupHomeFeed(client.getQueryData(projectQueryKeys.homeFeed("project-1"))).continueChat
        ?.isFavorite,
    ).toBe(false);
  });

  it("rejects a stale feed favorite after a successful command", async () => {
    const client = new QueryClient();
    seed(client);
    const stale = beginThreadUserStateFeedRequest(client, "project-1");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json(response(true))),
    );
    await runFavoriteCommand(client, "project-1", "thread-1", true);
    admitThreadUserStateItems(client, "project-1", [thread()], stale);
    expect(getThreadUserStateRecord(client, "project-1", thread()).base.isFavorite).toBe(true);
  });

  it("serializes opposite favorite values and converges on the latest response", async () => {
    const client = new QueryClient();
    seed(client);
    const transports: Array<{ resolve: (value: Response) => void }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            transports.push({ resolve });
          }),
      ),
    );
    const favorite = runFavoriteCommand(client, "project-1", "thread-1", true);
    const unfavorite = runFavoriteCommand(client, "project-1", "thread-1", false);
    expect(transports).toHaveLength(1);
    transports[0]?.resolve(json(response(true)));
    await favorite;
    expect(transports).toHaveLength(2);
    transports[1]?.resolve(json(response(false)));
    await unfavorite;
    expect(record(client).base.isFavorite).toBe(false);
  });
});
