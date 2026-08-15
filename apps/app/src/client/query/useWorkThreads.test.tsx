import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { withReactRoot } from "@/test-support/react-dom-harness";

const api = vi.hoisted(() => ({ listWorkThreads: vi.fn() }));
const store = vi.hoisted(() => ({ pending: false }));

vi.mock("@/client/api/projects-api", () => api);
vi.mock("@/client/stores", () => ({
  useIsProjectPendingCreation: () => store.pending,
}));

const { projectQueryKeys } = await import("./project-query-keys");
const { useWorkThreads } = await import("./useWorkThreads");

const flush = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

describe("useWorkThreads", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store.pending = false;
  });

  it("uses a per-Work leaf below the project-wide invalidation prefix", async () => {
    api.listWorkThreads.mockResolvedValue([]);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const prefix = projectQueryKeys.workThreads("project-1");
    const leaf = projectQueryKeys.workThreads("project-1", "work-1");
    const unrelated = projectQueryKeys.workThreads("project-2", "work-1");
    client.setQueryData(unrelated, []);
    let current: ReturnType<typeof useWorkThreads> | null = null;

    function Harness() {
      current = useWorkThreads("project-1", "work-1");
      return null;
    }

    try {
      await withReactRoot(
        <QueryClientProvider client={client}>
          <Harness />
        </QueryClientProvider>,
        async () => {
          await flush();
          expect(api.listWorkThreads).toHaveBeenCalledWith("work-1");
          expect(current?.threads).toEqual([]);
          expect(client.getQueryData(leaf)).toEqual([]);

          await client.invalidateQueries({ queryKey: prefix, refetchType: "none" });
          expect(client.getQueryState(leaf)?.isInvalidated).toBe(true);
          expect(client.getQueryState(unrelated)?.isInvalidated).toBe(false);
        },
        { drainMacrotask: true },
      );
    } finally {
      client.clear();
    }
  });

  it("does not request while disabled or while its project is pending creation", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    store.pending = true;

    function Harness() {
      useWorkThreads("project-1", "work-1");
      useWorkThreads("project-1", "work-2", { enabled: false });
      return null;
    }

    try {
      await withReactRoot(
        <QueryClientProvider client={client}>
          <Harness />
        </QueryClientProvider>,
        flush,
      );
      expect(api.listWorkThreads).not.toHaveBeenCalled();
    } finally {
      client.clear();
    }
  });

  it("normalizes request failures to an error with an empty collection", async () => {
    api.listWorkThreads.mockRejectedValue(new Error("unavailable"));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let current: ReturnType<typeof useWorkThreads> | null = null;

    function Harness() {
      current = useWorkThreads("project-1", "work-1");
      return null;
    }

    try {
      await withReactRoot(
        <QueryClientProvider client={client}>
          <Harness />
        </QueryClientProvider>,
        async () => {
          await flush();
          expect(current).toMatchObject({ threads: [], isError: true });
        },
        { drainMacrotask: true },
      );
    } finally {
      client.clear();
    }
  });
});
