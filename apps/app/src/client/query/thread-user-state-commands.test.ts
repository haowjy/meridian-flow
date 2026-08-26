/** Behavioral coverage for the shared user-state command authority. */
import type { ProjectChatItem } from "@meridian/contracts/protocol";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { groupHomeFeed, type HomeFeedData } from "./home-chat-feed-cache";
import { projectQueryKeys } from "./project-query-keys";
import {
  admitThreadUserStateItems,
  beginThreadUserStateFeedRequest,
  getThreadUserStateCommandView,
  getThreadUserStateRecord,
  projectThreadUserState,
  runThreadUserStateCommand,
  type ThreadUserStateField,
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
const commandView = (client: QueryClient, field: ThreadUserStateField) => {
  const record = client.getQueryData<ThreadUserStateRecord>(
    projectQueryKeys.threadUserState("project-1", "thread-1"),
  );
  if (!record) throw new Error("missing normalized thread state");
  return getThreadUserStateCommandView(record, field);
};

afterEach(() => vi.unstubAllGlobals());
describe("thread user-state command authority", () => {
  it("never rewrites cached Work feeds for a row command", async () => {
    const client = new QueryClient();
    seed(client);
    const workFeed = {
      pages: [{ items: [thread()], nextCursor: null }],
      pageParams: [null],
    };
    client.setQueryData(projectQueryKeys.workThreads("project-1", "work-1"), workFeed);
    let resolve!: (value: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((done) => {
            resolve = done;
          }),
      ),
    );
    const command = runThreadUserStateCommand(client, "project-1", "thread-1", "isFavorite", true);
    expect(client.getQueryData(projectQueryKeys.workThreads("project-1", "work-1"))).toBe(workFeed);
    resolve(json(response(true)));
    await command;
    expect(client.getQueryData(projectQueryKeys.workThreads("project-1", "work-1"))).toBe(workFeed);
  });

  it("rejects pre-command feed arrivals and admits a request begun after acknowledgement", async () => {
    const client = new QueryClient();
    seed(client);
    const before = beginThreadUserStateFeedRequest(client, "project-1");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json(response(true))),
    );
    await runThreadUserStateCommand(client, "project-1", "thread-1", "isFavorite", true);
    admitThreadUserStateItems(client, "project-1", [{ ...thread(), isFavorite: false }], before);
    let record = getThreadUserStateRecord(client, "project-1", thread());
    expect(projectThreadUserState(thread(), record).isFavorite).toBe(true);
    const after = beginThreadUserStateFeedRequest(client, "project-1");
    admitThreadUserStateItems(client, "project-1", [{ ...thread(), isFavorite: false }], after);
    record = getThreadUserStateRecord(client, "project-1", thread());
    expect(projectThreadUserState(thread(), record).isFavorite).toBe(false);
  });

  it("orders reverse Home and Work arrivals after a successful mutation", async () => {
    const client = new QueryClient();
    seed(client);
    const requestBeforeMutation = beginThreadUserStateFeedRequest(client, "project-1");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json(response(true))),
    );
    await runThreadUserStateCommand(client, "project-1", "thread-1", "isFavorite", true);

    const olderHomeRequest = beginThreadUserStateFeedRequest(client, "project-1");
    const newerWorkRequest = beginThreadUserStateFeedRequest(client, "project-1");
    expect(olderHomeRequest).toBeGreaterThan(requestBeforeMutation);
    expect(newerWorkRequest).toBeGreaterThan(olderHomeRequest);
    admitThreadUserStateItems(
      client,
      "project-1",
      [{ ...thread(), isFavorite: true }],
      newerWorkRequest,
    );
    admitThreadUserStateItems(
      client,
      "project-1",
      [{ ...thread(), isFavorite: false }],
      olderHomeRequest,
    );
    let record = getThreadUserStateRecord(client, "project-1", thread());
    expect(projectThreadUserState(thread(), record).isFavorite).toBe(true);

    const olderWorkRequest = beginThreadUserStateFeedRequest(client, "project-1");
    const newerHomeRequest = beginThreadUserStateFeedRequest(client, "project-1");
    expect(olderWorkRequest).toBeGreaterThan(newerWorkRequest);
    expect(newerHomeRequest).toBeGreaterThan(olderWorkRequest);
    admitThreadUserStateItems(
      client,
      "project-1",
      [{ ...thread(), isFavorite: false }],
      newerHomeRequest,
    );
    admitThreadUserStateItems(
      client,
      "project-1",
      [{ ...thread(), isFavorite: true }],
      olderWorkRequest,
    );
    record = getThreadUserStateRecord(client, "project-1", thread());
    expect(projectThreadUserState(thread(), record).isFavorite).toBe(false);
  });

  it.each([
    {
      name: "unread commits before favorite but responds after it",
      commands: [
        { field: "isFavorite", value: true },
        { field: "isUnread", value: false },
      ],
      responseArrival: [
        { field: "isFavorite", snapshot: { ...response(true), attention: "none" } },
        { field: "isUnread", snapshot: { ...response(false), attention: "none" } },
      ],
    },
    {
      name: "favorite commits before unread but responds after it",
      commands: [
        { field: "isUnread", value: false },
        { field: "isFavorite", value: true },
      ],
      responseArrival: [
        { field: "isUnread", snapshot: { ...response(true), attention: "none" } },
        { field: "isFavorite", snapshot: { ...response(true), attention: "unread" } },
      ],
    },
  ] as const)("preserves final server truth when $name", async ({ commands, responseArrival }) => {
    const client = new QueryClient();
    seed(client);
    const workItem = thread();
    client.setQueryData(projectQueryKeys.workThreads("project-1", "work-1"), {
      pages: [{ items: [workItem], nextCursor: null }],
      pageParams: [null],
    });
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
    const pending = commands.map(({ field, value }) =>
      runThreadUserStateCommand(client, "project-1", "thread-1", field, value),
    );
    for (const { field, snapshot } of responseArrival) {
      const transport = transports.find(({ body }) => field in body);
      transport?.resolve(json(snapshot));
      await pending[commands.findIndex((command) => command.field === field)];
    }

    const record = getThreadUserStateRecord(client, "project-1", thread());
    const expected = {
      isFavorite: true,
      attention: "none",
    } as const;
    expect(record.base).toEqual(expected);
    expect(
      groupHomeFeed(client.getQueryData(projectQueryKeys.homeFeed("project-1"))).continueChat,
    ).toMatchObject(expected);
    expect(projectThreadUserState(workItem, record)).toMatchObject(expected);
  });

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
    ).toMatchObject({ attention: "none", isFavorite: false });
    const record = getThreadUserStateRecord(client, "project-1", thread());
    expect(record.base).toEqual({ attention: "none", isFavorite: false });
    expect(record.barriers).toEqual({ isUnread: expect.any(Number) });
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
    expect(commandView(client, "isUnread")).toEqual({
      pending: true,
      desiredValue: first,
      error: undefined,
    });
    const secondCommand = runThreadUserStateCommand(
      client,
      "project-1",
      "thread-1",
      "isUnread",
      second,
    );
    expect(commandView(client, "isUnread")).toEqual({
      pending: true,
      desiredValue: second,
      error: undefined,
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
    expect(commandView(client, "isUnread")).toEqual({ pending: false, error: undefined });
    expect(transports).toHaveLength(2);
    expect(
      groupHomeFeed(client.getQueryData(["projects", "project-1", "home-feed"])).continueChat
        ?.attention,
    ).toBe(second ? "unread" : "none");
  });
});
