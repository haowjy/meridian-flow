/** Behavioral coverage for field-scoped favorite and open-acknowledgement convergence. */
import type { ProjectChatItem } from "@meridian/contracts/protocol";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { groupHomeFeed, type HomeFeedData } from "./home-chat-feed-cache";
import { projectQueryKeys } from "./project-query-keys";
import {
  acknowledgeThreadOpen,
  admitThreadUserStateItems,
  beginThreadUserStateFeedRequest,
  getFavoriteCommandView,
  getThreadUserStateRecord,
  projectThreadUserState,
  runFavoriteCommand,
  type ThreadUserStateRecord,
} from "./thread-user-state-commands";

const thread = (attention: ProjectChatItem["attention"] = "unread"): ProjectChatItem => ({
  id: "thread-1",
  title: "River",
  work: null,
  lastMessagePreview: null,
  lastActivityAt: "2026-08-13T00:00:00.000Z",
  attention,
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
const response = (
  input: { isFavorite?: boolean; attention?: ProjectChatItem["attention"] } = {},
) => ({
  threadId: "thread-1",
  isFavorite: input.isFavorite ?? false,
  lastOpenedAt: "2026-08-13T00:01:00.000Z",
  attention: input.attention ?? ("none" as const),
});
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const record = (client: QueryClient) => {
  const value = client.getQueryData<ThreadUserStateRecord>(
    projectQueryKeys.threadUserState("project-1", "thread-1"),
  );
  if (!value) throw new Error("missing normalized thread state");
  return value;
};

afterEach(() => vi.unstubAllGlobals());

describe("thread user-state command authority", () => {
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

  it("keeps favorite and attention responses field-scoped when they arrive out of order", async () => {
    const client = new QueryClient();
    seed(client);
    const transports: Array<{ body: Record<string, boolean>; resolve: (value: Response) => void }> =
      [];
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((resolve) => {
            transports.push({ body: JSON.parse(String(init?.body)), resolve });
          }),
      ),
    );

    const favorite = runFavoriteCommand(client, "project-1", "thread-1", true);
    const opened = acknowledgeThreadOpen(client, "project-1", "thread-1");
    expect(transports.map(({ body }) => body)).toEqual([
      { isFavorite: true },
      { acknowledgeOpen: true },
    ]);

    transports[1]?.resolve(json(response({ isFavorite: false, attention: "none" })));
    await opened;
    transports[0]?.resolve(json(response({ isFavorite: true, attention: "unread" })));
    await favorite;

    expect(record(client).base).toEqual({ isFavorite: true, attention: "none" });
    expect(
      groupHomeFeed(client.getQueryData(projectQueryKeys.homeFeed("project-1"))).continueChat,
    ).toMatchObject({ isFavorite: true, attention: "none" });
  });

  it("rejects stale feed fields independently after successful writes", async () => {
    const client = new QueryClient();
    seed(client);
    const stale = beginThreadUserStateFeedRequest(client, "project-1");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json(response({ isFavorite: true }))),
    );
    await runFavoriteCommand(client, "project-1", "thread-1", true);
    admitThreadUserStateItems(
      client,
      "project-1",
      [{ ...thread("actionRequired"), isFavorite: false }],
      stale,
    );
    expect(
      projectThreadUserState(thread(), getThreadUserStateRecord(client, "project-1", thread())),
    ).toMatchObject({
      isFavorite: true,
      attention: "actionRequired",
    });
  });

  it("joins concurrent open acknowledgements into one transport", async () => {
    const client = new QueryClient();
    seed(client);
    let resolve!: (value: Response) => void;
    const fetch = vi.fn(
      () =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    );
    vi.stubGlobal("fetch", fetch);
    const home = acknowledgeThreadOpen(client, "project-1", "thread-1");
    const chat = acknowledgeThreadOpen(client, "project-1", "thread-1");
    expect(fetch).toHaveBeenCalledTimes(1);
    resolve(json(response()));
    await expect(Promise.all([home, chat])).resolves.toMatchObject([
      { status: "success" },
      { status: "success" },
    ]);
    expect(record(client).barriers).toEqual({ attention: expect.any(Number) });
  });
});
