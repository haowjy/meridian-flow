// @vitest-environment jsdom
/** Account-close snapshot retirement in the QueryClient above account composition. */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { threadQueryKeys } from "@/client/query/thread-query-keys";
import {
  convergeThreadWorkBinding,
  readStableThreadWorkBinding,
} from "@/client/query/thread-work-binding-cache";
import { ThreadStoreProvider } from "./thread-store";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const epoch = vi.hoisted(() => ({ signal: null as AbortSignal | null }));
const causal = vi.hoisted(() => ({ list: vi.fn(), refresh: vi.fn() }));
vi.mock("@/features/project/context/account-feature-context", () => ({
  useOptionalAccountEpochSignal: () => epoch.signal,
}));
vi.mock("@/client/api/projects-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/client/api/projects-api")>()),
  listProjectThreads: (...args: unknown[]) => causal.list(...args),
}));
vi.mock("@/client/query/works-projection-acquisition", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/client/query/works-projection-acquisition")>()),
  refreshWorksSnapshot: (...args: unknown[]) => causal.refresh(...args),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});

describe("thread snapshot account close", () => {
  it("removes only canonical snapshots and cannot reuse or publish the old query", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const oldA = new AbortController();
    epoch.signal = oldA.signal;
    let accountKey = "A1";
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const render = async () => {
      await act(async () => {
        root.render(
          <QueryClientProvider client={client}>
            <ThreadStoreProvider now={0} key={accountKey}>
              ok
            </ThreadStoreProvider>
          </QueryClientProvider>,
        );
      });
    };
    await render();
    disposers.push(async () => {
      await act(async () => root.unmount());
      client.clear();
      host.remove();
    });
    const key = threadQueryKeys.snapshot("thread-1");
    const inactive = threadQueryKeys.snapshot("thread-inactive");
    client.setQueryData(inactive, { thread: { id: "thread-inactive", userId: "A" } });
    client.setQueryData(["projects", "catalog"], { marker: "keep" });
    client.setQueryData(["works", "catalog"], { marker: "keep" });
    const oldGate = deferred<unknown>();
    let oldCalls = 0;
    const oldRequest = client
      .fetchQuery({
        queryKey: key,
        queryFn: () => {
          oldCalls++;
          return oldGate.promise;
        },
      })
      .catch(() => undefined);
    expect(oldCalls).toBe(1);
    const oldThreads = deferred<unknown>();
    const oldWorks = deferred<unknown>();
    causal.list.mockReturnValueOnce(oldThreads.promise);
    causal.refresh.mockReturnValueOnce(oldWorks.promise);
    const oldBinding = readStableThreadWorkBinding(
      client,
      { projectId: "project-1", threadId: "thread-1", previousWorkId: null },
      oldA.signal,
    ).catch(() => undefined);
    await vi.waitFor(() => expect(causal.list).toHaveBeenCalledTimes(1));
    act(() => oldA.abort());
    expect(client.getQueryState(key)).toBeUndefined();
    expect(client.getQueryState(inactive)).toBeUndefined();
    expect(client.getQueryData(["projects", "catalog"])).toEqual({ marker: "keep" });
    expect(client.getQueryData(["works", "catalog"])).toEqual({ marker: "keep" });

    const accountB = new AbortController();
    epoch.signal = accountB.signal;
    accountKey = "B";
    await render();
    client.setQueryData(key, { thread: { id: "thread-1", userId: "B", workId: null } });
    act(() => accountB.abort());
    expect(client.getQueryState(key)).toBeUndefined();

    epoch.signal = new AbortController().signal;
    accountKey = "A2";
    await render();
    const newGate = deferred<unknown>();
    let newCalls = 0;
    const newRequest = client.fetchQuery({
      queryKey: key,
      queryFn: () => {
        newCalls++;
        return newGate.promise;
      },
    });
    expect(newCalls).toBe(1);
    const currentSnapshot = { thread: { id: "thread-1", userId: "A", workId: null } };
    newGate.resolve(currentSnapshot);
    await expect(newRequest).resolves.toBe(currentSnapshot);
    oldGate.resolve({ thread: { id: "thread-1", userId: "A", workId: "work-old" } });
    await oldRequest;
    oldThreads.resolve([{ id: "thread-1", workId: "work-old" }]);
    oldWorks.resolve({
      projectId: "project-1",
      catalogGeneration: "1",
      authorityRevision: "1",
      requestId: "old",
      works: [{ id: "work-old", name: "Old", deletedAt: null }],
      noWork: { id: "no-work", name: "No Work" },
    });
    await oldBinding;
    expect(client.getQueryData(key)).toBe(currentSnapshot);
  });

  it("fences an old Work-binding convergence but keeps the exact current writer", () => {
    const client = new QueryClient();
    const key = threadQueryKeys.snapshot("thread-1");
    client.setQueryData(key, { thread: { id: "thread-1", workId: null } });
    const old = new AbortController();
    old.abort();
    const transition = {
      source: "confirmed",
      projectId: "project-1",
      result: {
        threadId: "thread-1",
        before: { workId: null },
        after: { workId: "work-1" },
        changed: true,
      },
    } as const;
    convergeThreadWorkBinding(client, transition as never, old.signal);
    expect(
      (client.getQueryData(key) as { thread: { workId: string | null } }).thread.workId,
    ).toBeNull();
    convergeThreadWorkBinding(client, transition as never, new AbortController().signal);
    expect((client.getQueryData(key) as { thread: { workId: string | null } }).thread.workId).toBe(
      "work-1",
    );
    client.clear();
  });
});
