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
  preferenceChanged: true,
  receipt: { inverse: { command: "switch", workId: "work-a" } },
} as RebindThreadWorkResponse;

describe("thread Work binding convergence", () => {
  it("ignores an older projection cursor", () => {
    const client = new QueryClient();
    client.setQueryData(projectQueryKeys.works("project-1"), {
      defaultWorkId: "work-a",
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

  it("patches confirmed binding and preference synchronously", () => {
    const client = new QueryClient();
    client.setQueryData(projectQueryKeys.threads("project-1"), [
      { id: "thread-1", workId: "work-a" },
    ]);
    client.setQueryData(projectQueryKeys.works("project-1"), {
      defaultWorkId: "work-a",
      works: [response.work],
    });
    convergeThreadWorkBinding(client, {
      source: "confirmed",
      projectId: "project-1",
      result: response,
    });
    expect(
      client.getQueryData<ThreadListItem[]>(projectQueryKeys.threads("project-1"))?.[0].workId,
    ).toBe("work-b");
    expect(
      client.getQueryData<ListWorksResponse>(projectQueryKeys.works("project-1"))?.defaultWorkId,
    ).toBe("work-b");
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
      defaultWorkId: "work-c",
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

  it("does not let delayed mutation B roll back later projection C or offer stale Undo", async () => {
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    client.setQueryData(projectQueryKeys.threads("project-1"), [
      { id: "thread-1", projectId: "project-1", workId: "work-a" },
    ]);
    client.setQueryData(projectQueryKeys.works("project-1"), {
      defaultWorkId: "work-a",
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
      defaultWorkId: "work-c",
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
    expect(await pending).not.toHaveProperty("undoWorkId");
    expect(
      client.getQueryData<ThreadListItem[]>(projectQueryKeys.threads("project-1"))?.[0]?.workId,
    ).toBe("work-c");
    act(() => root.unmount());
  });
});
