// @vitest-environment jsdom
import type { ProjectChatItem, WorkChatFeedPage } from "@meridian/contracts/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withReactRoot } from "@/test-support/react-dom-harness";

const api = vi.hoisted(() => ({ listWorkThreads: vi.fn() }));
const store = vi.hoisted(() => ({ pending: false }));
vi.mock("@/client/api/projects-api", () => api);
vi.mock("@/client/stores", () => ({ useIsProjectPendingCreation: () => store.pending }));

const { projectQueryKeys } = await import("./project-query-keys");
const { useWorkThreads } = await import("./useWorkThreads");
const flush = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
const item = (id: string): ProjectChatItem => ({
  id,
  title: id,
  work: { id: "current-work", title: "Current Work" },
  lastMessagePreview: "preview",
  lastActivityAt: "2026-08-01T00:00:00.000000Z",
  attention: "none",
  isFavorite: false,
});
const page = (ids: string[], nextCursor: string | null = null): WorkChatFeedPage => ({
  items: ids.map(item),
  nextCursor,
});

describe("useWorkThreads", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store.pending = false;
  });

  it("loads bounded pages, de-duplicates overlap, and guards stale next-page identities", async () => {
    api.listWorkThreads
      .mockResolvedValueOnce(page(["a", "b"], "cursor-2"))
      .mockResolvedValueOnce(page(["b", "c"]));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let current: ReturnType<typeof useWorkThreads> | null = null;
    function Harness() {
      current = useWorkThreads("project-1", "work-1");
      return null;
    }
    await withReactRoot(
      <QueryClientProvider client={client}>
        <Harness />
      </QueryClientProvider>,
      async () => {
        await flush();
        expect(api.listWorkThreads).toHaveBeenNthCalledWith(
          1,
          "work-1",
          expect.objectContaining({ cursor: null, signal: expect.any(AbortSignal) }),
        );
        expect(current?.threads?.map(({ id }) => id)).toEqual(["a", "b"]);
        const stale = current?.nextPageIdentity;
        if (!stale) throw new Error("missing next identity");
        current?.fetchNextPageFor(stale);
        await flush();
        expect(current?.threads?.map(({ id }) => id)).toEqual(["a", "b", "c"]);
        current?.fetchNextPageFor(stale);
        await flush();
        expect(api.listWorkThreads).toHaveBeenCalledTimes(2);
      },
      { drainMacrotask: true },
    );
    client.clear();
  });

  it("isolates project and Work identities beneath the project invalidation prefix", async () => {
    api.listWorkThreads.mockResolvedValue(page([]));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const unrelated = projectQueryKeys.workThreads("project-2", "work-1");
    client.setQueryData(unrelated, { pages: [page(["other"])], pageParams: [null] });
    function Harness() {
      useWorkThreads("project-1", "work-1");
      useWorkThreads("project-1", "work-2");
      return null;
    }
    await withReactRoot(
      <QueryClientProvider client={client}>
        <Harness />
      </QueryClientProvider>,
      async () => {
        await flush();
        expect(api.listWorkThreads.mock.calls.map(([id]) => id)).toEqual(["work-1", "work-2"]);
        await client.invalidateQueries({
          queryKey: projectQueryKeys.workThreads("project-1"),
          refetchType: "none",
        });
        expect(client.getQueryState(unrelated)?.isInvalidated).toBe(false);
      },
      { drainMacrotask: true },
    );
    client.clear();
  });

  it("does not request while disabled and exposes a failed initial page as an error", async () => {
    api.listWorkThreads.mockRejectedValue(new Error("unavailable"));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let current: ReturnType<typeof useWorkThreads> | null = null;
    function Harness() {
      current = useWorkThreads("project-1", "work-1", { enabled: !store.pending });
      return null;
    }
    store.pending = true;
    await withReactRoot(
      <QueryClientProvider client={client}>
        <Harness />
      </QueryClientProvider>,
      async () => {
        await flush();
        expect(api.listWorkThreads).not.toHaveBeenCalled();
      },
      { drainMacrotask: true },
    );
    store.pending = false;
    await withReactRoot(
      <QueryClientProvider client={client}>
        <Harness />
      </QueryClientProvider>,
      async () => {
        await flush();
        expect(current).toMatchObject({ threads: null, isError: true });
      },
      { drainMacrotask: true },
    );
    client.clear();
  });
});
