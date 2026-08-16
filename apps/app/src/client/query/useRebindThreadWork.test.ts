// @vitest-environment jsdom
import type { ListWorksResponse, ThreadListItem } from "@meridian/contracts/protocol";
import type { RebindThreadWorkResponse } from "@meridian/contracts/works";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { projectQueryKeys } from "./project-query-keys";
import { threadQueryKeys } from "./thread-query-keys";
import {
  convergeThreadWorkBinding,
  readStableThreadWorkBinding,
} from "./thread-work-binding-cache";
import { useRebindThreadWork } from "./useRebindThreadWork";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const { listProjectThreads, listProjectWorks, rebindThreadWork } = vi.hoisted(() => ({
  listProjectThreads: vi.fn(),
  listProjectWorks: vi.fn(),
  rebindThreadWork: vi.fn(),
}));
vi.mock("@/client/api/projects-api", () => ({ listProjectThreads, listProjectWorks }));
vi.mock("@/client/api/threads-api", () => ({ rebindThreadWork }));

const response = {
  threadId: "thread-1",
  previousWorkId: "work-a",
  work: { id: "work-b", name: "B" },
  changed: true,
  receipt: { inverse: null },
} as RebindThreadWorkResponse;

describe("thread Work binding convergence", () => {
  function seedAssociatedChats(client: QueryClient) {
    const keys = {
      workA: projectQueryKeys.workThreads("project-1", "work-a"),
      workB: projectQueryKeys.workThreads("project-1", "work-b"),
      unrelated: projectQueryKeys.workThreads("project-2", "work-z"),
    };
    client.setQueryData(keys.workA, []);
    client.setQueryData(keys.workB, []);
    client.setQueryData(keys.unrelated, []);
    return keys;
  }

  it("ignores an older projection cursor", () => {
    const client = new QueryClient();
    client.setQueryData(projectQueryKeys.works("project-1"), {
      newChatFallbackWorkId: "work-a",
      works: [response.work],
    });
    convergeThreadWorkBinding(client, {
      source: "projected",
      seq: "12",
      signal: { projectId: "project-1", threadId: "thread-1", workId: "work-b" },
    });
    convergeThreadWorkBinding(client, {
      source: "projected",
      seq: "11",
      signal: { projectId: "project-1", threadId: "thread-1", workId: "work-a" },
    });
    expect(client.getQueryData(threadQueryKeys.workProjectionCursor("thread-1"))).toEqual({
      seq: "12",
      workId: "work-b",
    });
  });

  it("invalidates the affected Work catalog and every associated-chat leaf for a projected rebind", () => {
    const client = new QueryClient();
    client.setQueryData(projectQueryKeys.works("project-1"), {
      newChatFallbackWorkId: "work-a",
      works: [response.work],
    });
    const keys = seedAssociatedChats(client);

    convergeThreadWorkBinding(client, {
      source: "projected",
      seq: "12",
      signal: { projectId: "project-1", threadId: "thread-1", workId: "work-b" },
    });

    expect(client.getQueryState(projectQueryKeys.works("project-1"))?.isInvalidated).toBe(true);
    expect(client.getQueryState(keys.workA)?.isInvalidated).toBe(true);
    expect(client.getQueryState(keys.workB)?.isInvalidated).toBe(true);
    expect(client.getQueryState(keys.unrelated)?.isInvalidated).toBe(false);
  });

  it("patches the confirmed binding without changing the fallback", () => {
    const client = new QueryClient();
    client.setQueryData(projectQueryKeys.homeFeed("project-1"), { fresh: true });
    client.setQueryData(projectQueryKeys.threads("project-1"), [
      { id: "thread-1", workId: "work-a" },
    ]);
    client.setQueryData(projectQueryKeys.works("project-1"), {
      newChatFallbackWorkId: "work-a",
      works: [response.work],
    });
    const associated = seedAssociatedChats(client);
    convergeThreadWorkBinding(client, {
      source: "confirmed",
      projectId: "project-1",
      result: response,
    });
    expect(
      client.getQueryData<ThreadListItem[]>(projectQueryKeys.threads("project-1"))?.[0].workId,
    ).toBe("work-b");
    expect(
      client.getQueryData<ListWorksResponse>(projectQueryKeys.works("project-1"))
        ?.newChatFallbackWorkId,
    ).toBe("work-a");
    expect(client.getQueryState(associated.workA)?.isInvalidated).toBe(true);
    expect(client.getQueryState(associated.workB)?.isInvalidated).toBe(true);
    expect(client.getQueryState(associated.unrelated)?.isInvalidated).toBe(false);
    expect(client.getQueryState(projectQueryKeys.homeFeed("project-1"))?.isInvalidated).toBe(true);
  });

  it("invalidates only the affected project's associated chats after reconciliation", () => {
    const client = new QueryClient();
    const keys = seedAssociatedChats(client);

    convergeThreadWorkBinding(client, {
      source: "reconciled",
      projectId: "project-1",
      threadId: "thread-1",
      previousWorkId: "work-a",
      threads: [{ id: "thread-1", projectId: "project-1", workId: "work-b" } as ThreadListItem],
      catalog: {
        newChatFallbackWorkId: "work-a",
        works: [
          { id: "work-a", name: "A" },
          { id: "work-b", name: "B" },
        ] as never,
      },
    });

    expect(client.getQueryState(keys.workA)?.isInvalidated).toBe(true);
    expect(client.getQueryState(keys.workB)?.isInvalidated).toBe(true);
    expect(client.getQueryState(keys.unrelated)?.isInvalidated).toBe(false);
  });

  it("retries a causal read when a projection arrives during the first read", async () => {
    const client = new QueryClient();
    listProjectThreads
      .mockImplementationOnce(async () => {
        client.setQueryData(threadQueryKeys.workProjectionCursor("thread-1"), {
          seq: "2",
          workId: "work-c",
        });
        return [{ id: "thread-1", projectId: "project-1", workId: "work-b" }];
      })
      .mockResolvedValue([{ id: "thread-1", projectId: "project-1", workId: "work-c" }]);
    listProjectWorks.mockResolvedValue({
      newChatFallbackWorkId: "work-c",
      works: [{ id: "work-c", name: "C" }],
    });
    await expect(
      readStableThreadWorkBinding(client, {
        projectId: "project-1",
        threadId: "thread-1",
        previousWorkId: "work-a",
      }),
    ).resolves.toMatchObject({ workId: "work-c" });
    expect(listProjectThreads).toHaveBeenCalledTimes(2);
  });

  it("does not let delayed mutation B roll back later projection C", async () => {
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    client.setQueryData(projectQueryKeys.threads("project-1"), [
      { id: "thread-1", projectId: "project-1", workId: "work-a" },
    ]);
    client.setQueryData(projectQueryKeys.works("project-1"), {
      newChatFallbackWorkId: "work-a",
      works: [
        { id: "work-a", name: "A" },
        { id: "work-b", name: "B" },
        { id: "work-c", name: "C" },
      ],
    });
    let resolveMutation: ((result: RebindThreadWorkResponse) => void) | undefined;
    rebindThreadWork.mockReturnValue(
      new Promise<RebindThreadWorkResponse>((resolve) => {
        resolveMutation = resolve;
      }),
    );
    listProjectThreads.mockResolvedValue([
      { id: "thread-1", projectId: "project-1", workId: "work-c" },
    ]);
    listProjectWorks.mockResolvedValue({
      newChatFallbackWorkId: "work-c",
      works: [{ id: "work-c", name: "C" }],
    });

    let mutateAsync: ReturnType<typeof useRebindThreadWork>["mutateAsync"] | undefined;
    function Probe() {
      mutateAsync = useRebindThreadWork("project-1", "thread-1").mutateAsync;
      return null;
    }
    const host = document.createElement("div");
    const root = createRoot(host);
    act(() => root.render(createElement(QueryClientProvider, { client }, createElement(Probe))));

    let pending!: ReturnType<NonNullable<typeof mutateAsync>>;
    await act(async () => {
      pending = mutateAsync?.({
        targetWorkId: "work-b",
        previousWorkId: "work-a",
      }) as typeof pending;
      await Promise.resolve();
    });
    expect(rebindThreadWork).toHaveBeenCalledOnce();
    convergeThreadWorkBinding(client, {
      source: "projected",
      seq: "3",
      signal: { projectId: "project-1", threadId: "thread-1", workId: "work-c" },
    });
    await act(async () => resolveMutation?.(response));

    await expect(pending).resolves.toMatchObject({
      kind: "superseded",
      requestedWorkId: "work-b",
      currentWork: { id: "work-c" },
    });
    expect(
      client.getQueryData<ThreadListItem[]>(projectQueryKeys.threads("project-1"))?.[0]?.workId,
    ).toBe("work-c");
    act(() => root.unmount());
  });
});
