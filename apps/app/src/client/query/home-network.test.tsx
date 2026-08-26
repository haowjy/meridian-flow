/** Home network contracts over real TanStack Query observers and controlled HTTP. */
import type {
  HomeChatFeedPage,
  ProjectChatItem,
  ThreadSnapshotResponse,
} from "@meridian/contracts/protocol";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { act, type ReactNode, StrictMode, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { withReactRoot } from "@/test-support/react-dom-harness";
import { groupHomeFeed, type HomeFeedData } from "./home-chat-feed-cache";
import { projectQueryKeys } from "./project-query-keys";
import { threadQueryKeys } from "./thread-query-keys";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@lingui/core/macro", () => ({
  t: (parts: TemplateStringsArray) => parts.join(""),
}));

const threadActions = { setThreadAttention: vi.fn() };
vi.mock("@/client/stores", () => ({
  useThreadActions: () => threadActions,
}));

const { useHomeChatFeed } = await import("./useHomeChatFeed");
const { useThreadOpenAcknowledgement } = await import("./useThreadOpenAcknowledgement");

const projectId = "project-1";
const threadId = "thread-1";
const homePath = `/api/projects/${projectId}/home-feed`;
const cursorPath = `${homePath}?cursor=cursor-2`;
const userStatePath = `/api/threads/${threadId}/user-state`;

const item = (attention: ProjectChatItem["attention"] = "unread"): ProjectChatItem => ({
  id: threadId,
  title: "A chat",
  work: null,
  lastMessagePreview: null,
  lastActivityAt: "2026-08-13T00:00:00.000Z",
  attention,
  isFavorite: false,
});
const page = (items: ProjectChatItem[], nextCursor: string | null = null): HomeChatFeedPage => ({
  featured: { continueChat: items[0] ?? null, favoriteChats: [] },
  recentChats: { items, nextCursor },
});
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

type DeferredResponse = {
  promise: Promise<Response>;
  resolve: (response: Response) => void;
};
function deferredResponse(): DeferredResponse {
  let resolve!: (response: Response) => void;
  return { promise: new Promise((done) => (resolve = done)), resolve };
}

async function waitFor(check: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return;
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  }
  throw new Error("condition was not reached");
}

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: 1, gcTime: Infinity } } });
}

describe("Home network behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("completes one initial feed request through observer abort/replay and converges dock acknowledgement", async () => {
    const queryClient = client();
    const acknowledgement = deferredResponse();
    const requests: Array<{ path: string; completed: boolean; aborted: boolean }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request, init?: RequestInit) => {
        const path = String(input);
        const record = { path, completed: false, aborted: false };
        requests.push(record);
        if (path === homePath) {
          if (requests.filter((entry) => entry.path === homePath).length === 1) {
            return new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener("abort", () => {
                record.aborted = true;
                reject(new DOMException("Aborted", "AbortError"));
              });
            });
          }
          record.completed = true;
          return Promise.resolve(json(page([item()])));
        }
        if (path === userStatePath) {
          return acknowledgement.promise.then((response) => {
            record.completed = true;
            return response;
          });
        }
        throw new Error(`unexpected request: ${path}`);
      }),
    );

    queryClient.setQueryData(threadQueryKeys.snapshot(threadId), {
      attention: "unread",
    } as ThreadSnapshotResponse);
    let feed: ReturnType<typeof useHomeChatFeed> | null = null;
    let showDock: (() => void) | null = null;
    function Harness() {
      const [visible, setVisible] = useState(false);
      showDock = () => setVisible(true);
      feed = useHomeChatFeed(projectId);
      useQuery<ThreadSnapshotResponse>({
        queryKey: threadQueryKeys.snapshot(threadId),
        queryFn: () => Promise.reject(new Error("seeded snapshot must not refetch")),
        staleTime: Infinity,
      });
      useThreadOpenAcknowledgement({
        threadId,
        projectId,
        visible: feed.isSuccess && visible,
      });
      return null;
    }

    try {
      await withReactRoot(
        <StrictMode>
          <QueryClientProvider client={queryClient}>
            <Harness />
          </QueryClientProvider>
        </StrictMode>,
        async () => {
          await waitFor(() => requests.filter((entry) => entry.path === homePath).length >= 2);
          await waitFor(() => feed?.isSuccess === true);
          expect(requests.filter((entry) => entry.path === userStatePath)).toHaveLength(0);
          await act(async () => showDock?.());
          await waitFor(
            () => requests.filter((entry) => entry.path === userStatePath).length === 1,
          );
          acknowledgement.resolve(
            json({
              threadId,
              isFavorite: true,
              manuallyUnread: false,
              lastOpenedAt: "2026-08-13T00:01:00.000Z",
              attention: "none",
            }),
          );
          await waitFor(
            () =>
              groupHomeFeed(
                queryClient.getQueryData<HomeFeedData>(projectQueryKeys.homeFeed(projectId)),
              ).continueChat?.attention === "none",
          );

          const homeRequests = requests.filter((entry) => entry.path === homePath);
          expect(homeRequests.filter((entry) => entry.completed)).toHaveLength(1);
          expect(homeRequests.filter((entry) => entry.aborted)).toHaveLength(1);
          expect(requests.filter((entry) => entry.path === userStatePath)).toHaveLength(1);
          expect(
            groupHomeFeed(
              queryClient.getQueryData<HomeFeedData>(projectQueryKeys.homeFeed(projectId)),
            ).continueChat,
          ).toMatchObject({ attention: "none" });
        },
        { drainMacrotask: true },
      );
    } finally {
      queryClient.clear();
    }
  });

  it("makes one failed initial request and waits for manual refetch", async () => {
    const queryClient = client();
    const failure = deferredResponse();
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        calls++;
        return failure.promise;
      }),
    );
    let feed: ReturnType<typeof useHomeChatFeed> | null = null;
    function Harness() {
      feed = useHomeChatFeed(projectId);
      return null;
    }
    try {
      await withReactRoot(
        <QueryClientProvider client={queryClient}>
          <Harness />
        </QueryClientProvider>,
        async () => {
          await waitFor(() => calls === 1);
          failure.resolve(json({ message: "offline" }, 503));
          await waitFor(() => feed?.isError === true);
          await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
          expect(calls).toBe(1);
        },
        { drainMacrotask: true },
      );
    } finally {
      queryClient.clear();
    }
  });

  it("preserves cards after one failed cursor request and retries that cursor exactly once", async () => {
    const queryClient = client();
    let cursorCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const path = String(input);
        if (path === homePath) return Promise.resolve(json(page([item()], "cursor-2")));
        if (path === cursorPath) {
          cursorCalls++;
          return Promise.resolve(
            cursorCalls === 1 ? json({ message: "offline" }, 503) : json(page([], null)),
          );
        }
        throw new Error(`unexpected request: ${path}`);
      }),
    );
    let feed: ReturnType<typeof useHomeChatFeed> | null = null;
    function Harness() {
      feed = useHomeChatFeed(projectId);
      return null;
    }
    try {
      await withReactRoot(
        <QueryClientProvider client={queryClient}>
          <Harness />
        </QueryClientProvider>,
        async () => {
          await waitFor(() => feed?.isSuccess === true);
          await act(async () => {
            await feed?.fetchNextPage();
          });
          await waitFor(() => feed?.isFetchNextPageError === true);
          expect(cursorCalls).toBe(1);
          expect(feed?.grouped.continueChat?.id).toBe(threadId);

          await act(async () => {
            await feed?.fetchNextPage();
          });
          await waitFor(() => feed?.isFetchNextPageError === false);
          expect(cursorCalls).toBe(2);
          expect(feed?.grouped.continueChat?.id).toBe(threadId);
        },
        { drainMacrotask: true },
      );
    } finally {
      queryClient.clear();
    }
  });
});
