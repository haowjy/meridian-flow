/** Behavioral coverage for the shared user-state command authority. */
import type { ProjectChatItem } from "@meridian/contracts/protocol";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { groupHomeFeed, type HomeFeedData } from "./home-chat-feed-cache";
import {
  getThreadUserStateTransportState,
  runThreadUserStateCommand,
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
  client.setQueryData<HomeFeedData>(["projects", "project-1", "home-feed"], {
    pages: [
      {
        featured: { continueChat: thread(), favoriteChats: [] },
        recentChats: { items: [], nextCursor: null },
      },
    ],
    pageParams: [null],
  });
const response = (isFavorite = false) => ({
  threadId: "thread-1",
  isFavorite,
  manuallyUnread: false,
  lastOpenedAt: "2026-08-13T00:01:00.000Z",
  attention: "none" as const,
});
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

afterEach(() => vi.unstubAllGlobals());
describe("thread user-state command authority", () => {
  it("lets Home open and visible Chat join one transport and one result", async () => {
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
    const home = runThreadUserStateCommand(client, "project-1", "thread-1", "isUnread", false);
    const chat = runThreadUserStateCommand(client, "project-1", "thread-1", "isUnread", false);
    expect(fetch).toHaveBeenCalledTimes(1);
    resolve(json(response(true)));
    await expect(Promise.all([home, chat])).resolves.toMatchObject([
      { status: "success" },
      { status: "success" },
    ]);
    expect(
      groupHomeFeed(client.getQueryData(["projects", "project-1", "home-feed"])).continueChat,
    ).toMatchObject({ attention: "none", isFavorite: true });
  });

  it("captures the inverse before rollback commits and does not let joined callers diverge", async () => {
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
    const first = runThreadUserStateCommand(client, "project-1", "thread-1", "isFavorite", true, {
      beforeRollback: () =>
        observations.push(
          groupHomeFeed(client.getQueryData(["projects", "project-1", "home-feed"])).continueChat
            ?.isFavorite ?? false,
        ),
    });
    const joined = runThreadUserStateCommand(client, "project-1", "thread-1", "isFavorite", true);
    expect(
      groupHomeFeed(client.getQueryData(["projects", "project-1", "home-feed"])).continueChat
        ?.isFavorite,
    ).toBe(true);
    reject(new Error("offline"));
    await expect(Promise.all([first, joined])).resolves.toMatchObject([
      { status: "error" },
      { status: "error" },
    ]);
    expect(observations).toEqual([true]);
    expect(
      groupHomeFeed(client.getQueryData(["projects", "project-1", "home-feed"])).continueChat
        ?.isFavorite,
    ).toBe(false);
  });
});

describe.each([
  { first: false, second: true },
  { first: true, second: false },
])("serialized $first → $second commands", ({ first, second }) => {
  it.each([
    "success",
    "failure",
  ] as const)("advances after first-command %s and lets same-value callers join", async (settlement) => {
    const client = new QueryClient();
    seed(client);
    const transports: Array<{
      body: unknown;
      resolve: (response: Response) => void;
      reject: (error: Error) => void;
    }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((resolve, reject) => {
            transports.push({ body: JSON.parse(String(init?.body)), resolve, reject });
          }),
      ),
    );

    const firstCommand = runThreadUserStateCommand(
      client,
      "project-1",
      "thread-1",
      "isUnread",
      first,
    );
    expect(getThreadUserStateTransportState(client, "project-1", "thread-1", "isUnread")).toEqual({
      pending: true,
      desiredValue: first,
    });
    const secondCommand = runThreadUserStateCommand(
      client,
      "project-1",
      "thread-1",
      "isUnread",
      second,
    );
    expect(getThreadUserStateTransportState(client, "project-1", "thread-1", "isUnread")).toEqual({
      pending: true,
      desiredValue: second,
    });
    const joinedSecond = runThreadUserStateCommand(
      client,
      "project-1",
      "thread-1",
      "isUnread",
      second,
    );
    expect(transports).toHaveLength(1);
    expect(transports[0]?.body).toEqual({ isUnread: first });

    if (settlement === "success") transports[0]?.resolve(json(response()));
    else transports[0]?.reject(new Error("first offline"));
    await firstCommand;
    expect(transports).toHaveLength(2);
    expect(transports[1]?.body).toEqual({ isUnread: second });

    transports[1]?.resolve(
      json({
        ...response(),
        manuallyUnread: second,
        attention: second ? "unread" : "none",
      }),
    );
    await expect(Promise.all([secondCommand, joinedSecond])).resolves.toMatchObject([
      { status: "success" },
      { status: "success" },
    ]);
    expect(getThreadUserStateTransportState(client, "project-1", "thread-1", "isUnread")).toEqual({
      pending: false,
    });
    expect(transports).toHaveLength(2);
    expect(
      groupHomeFeed(client.getQueryData(["projects", "project-1", "home-feed"])).continueChat
        ?.attention,
    ).toBe(second ? "unread" : "none");
  });
});
