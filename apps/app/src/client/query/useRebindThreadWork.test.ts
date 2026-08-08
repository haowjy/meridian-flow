import type { ListWorksResponse, ThreadListItem } from "@meridian/contracts/protocol";
import type { RebindThreadWorkResponse } from "@meridian/contracts/works";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { projectQueryKeys } from "./project-query-keys";
import {
  convergeProjectedThreadWork,
  convergeThreadWork,
  reconcileThreadWorkMutation,
} from "./useRebindThreadWork";

const { listProjectThreads, listProjectWorks } = vi.hoisted(() => ({
  listProjectThreads: vi.fn(),
  listProjectWorks: vi.fn(),
}));

vi.mock("@/client/api/projects-api", () => ({ listProjectThreads, listProjectWorks }));

describe("convergeThreadWork", () => {
  it("patches binding and primary preference before invalidation refetches", () => {
    const client = new QueryClient();
    client.setQueryData(projectQueryKeys.threads("project-1"), [
      {
        id: "thread-1",
        projectId: "project-1",
        workId: "work-a",
        work: { id: "work-a", title: "A" },
      },
    ]);
    client.setQueryData(projectQueryKeys.works("project-1"), {
      defaultWorkId: "work-a",
      works: [{ id: "work-b", name: "B" }],
    });

    convergeThreadWork(client, "project-1", {
      threadId: "thread-1",
      previousWorkId: "work-a",
      work: { id: "work-b", name: "B" },
      changed: true,
      preferenceChanged: true,
      receipt: {},
      contextUpdate: "delivered",
    } as RebindThreadWorkResponse);

    expect(
      client.getQueryData<ThreadListItem[]>(projectQueryKeys.threads("project-1"))?.[0],
    ).toMatchObject({
      workId: "work-b",
      work: { id: "work-b", title: "B" },
    });
    expect(
      client.getQueryData<ListWorksResponse>(projectQueryKeys.works("project-1"))?.defaultWorkId,
    ).toBe("work-b");
  });
});

describe("convergeProjectedThreadWork", () => {
  it("patches an externally changed binding from the cached catalog", () => {
    const client = new QueryClient();
    client.setQueryData(projectQueryKeys.threads("project-1"), [
      { id: "thread-1", projectId: "project-1", workId: "work-a" },
    ]);
    client.setQueryData(projectQueryKeys.works("project-1"), {
      defaultWorkId: "work-a",
      works: [{ id: "work-b", name: "B" }],
    });

    convergeProjectedThreadWork(client, {
      threadId: "thread-1",
      projectId: "project-1",
      workId: "work-b",
    });

    expect(
      client.getQueryData<ThreadListItem[]>(projectQueryKeys.threads("project-1"))?.[0],
    ).toMatchObject({ workId: "work-b", work: { id: "work-b", title: "B" } });
  });
});

describe("reconcileThreadWorkMutation", () => {
  it("classifies from a fresh post-failure read instead of an older in-flight query", async () => {
    const client = new QueryClient();
    let resolveOld!: (threads: ThreadListItem[]) => void;
    const oldRequest = new Promise<ThreadListItem[]>((resolve) => {
      resolveOld = resolve;
    });
    const oldFetch = client.fetchQuery({
      queryKey: projectQueryKeys.threads("project-1"),
      queryFn: () => oldRequest,
    });
    listProjectThreads.mockResolvedValue([
      { id: "thread-1", projectId: "project-1", workId: "work-b" },
    ]);
    listProjectWorks.mockResolvedValue({ defaultWorkId: "work-b", works: [] });

    const reconciliation = reconcileThreadWorkMutation(client, "project-1", "thread-1", "work-b");
    resolveOld([{ id: "thread-1", projectId: "project-1", workId: "work-a" } as ThreadListItem]);

    await expect(reconciliation).resolves.toBe(true);
    await expect(oldFetch).rejects.toBeDefined();
    expect(
      client.getQueryData<ThreadListItem[]>(projectQueryKeys.threads("project-1"))?.[0]?.workId,
    ).toBe("work-b");
    expect(listProjectThreads).toHaveBeenCalledOnce();
  });
});
