// @vitest-environment jsdom

import type { ListWorksResponse, ThreadListItem } from "@meridian/contracts/protocol";
import type { RebindThreadWorkResponse, Work } from "@meridian/contracts/works";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { testWorkSlug } from "@/test-support/work-slug";
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

const responseWork = {
  id: "work-b",
  projectId: "project-1",
  createdByUserId: "user-1",
  name: "B",
  slug: testWorkSlug("b"),
  goal: null,
  description: null,
  status: "active",
  archivedAt: null,
  aiWriteMode: "direct",
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
  lastActivityAt: "2026-08-01T00:00:00.000Z",
  deletedAt: null,
} as Work;
const response = {
  threadId: "thread-1",
  before: {
    kind: "work",
    workId: "work-a",
    workSlug: testWorkSlug("a"),
    name: "A",
    goal: null,
    description: null,
    status: "active",
  },
  after: {
    kind: "work",
    workId: "work-b",
    workSlug: testWorkSlug("b"),
    name: "B",
    goal: null,
    description: null,
    status: "active",
  },
  changed: true,
  receipt: {
    operation: "switch",
    category: "binding",
    before: {
      kind: "work",
      workId: "work-a",
      workSlug: testWorkSlug("a"),
      name: "A",
      goal: null,
      description: null,
      status: "active",
    },
    after: {
      kind: "work",
      workId: "work-b",
      workSlug: testWorkSlug("b"),
      name: "B",
      goal: null,
      description: null,
      status: "active",
    },
    inverse: null,
  },
  contextUpdate: "delivered",
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
      works: [responseWork],
    });
    convergeThreadWorkBinding(client, {
      source: "projected",
      seq: "12",
      signal: {
        projectId: "project-1",
        threadId: "thread-1",
        scope: { kind: "work", workId: "work-b", workSlug: testWorkSlug("work-b") },
      },
    });
    convergeThreadWorkBinding(client, {
      source: "projected",
      seq: "11",
      signal: {
        projectId: "project-1",
        threadId: "thread-1",
        scope: { kind: "work", workId: "work-a", workSlug: testWorkSlug("work-a") },
      },
    });
    expect(client.getQueryData(threadQueryKeys.workProjectionCursor("thread-1"))).toEqual({
      seq: "12",
      workId: "work-b",
    });
  });

  it("leaves the canonical Work snapshot to its owner and invalidates associated-chat leaves", () => {
    const client = new QueryClient();
    client.setQueryData(projectQueryKeys.works("project-1"), {
      works: [responseWork],
    });
    const keys = seedAssociatedChats(client);

    convergeThreadWorkBinding(client, {
      source: "projected",
      seq: "12",
      signal: {
        projectId: "project-1",
        threadId: "thread-1",
        scope: { kind: "work", workId: "work-b", workSlug: testWorkSlug("work-b") },
      },
    });

    expect(client.getQueryState(projectQueryKeys.works("project-1"))?.isInvalidated).toBe(false);
    expect(client.getQueryState(keys.workA)?.isInvalidated).toBe(true);
    expect(client.getQueryState(keys.workB)?.isInvalidated).toBe(true);
    expect(client.getQueryState(keys.unrelated)?.isInvalidated).toBe(false);
  });

  it("patches the confirmed binding without changing the Work collection", () => {
    const client = new QueryClient();
    client.setQueryData(projectQueryKeys.homeFeed("project-1"), { fresh: true });
    client.setQueryData(projectQueryKeys.threads("project-1"), [
      { id: "thread-1", workId: "work-a" },
    ]);
    client.setQueryData(projectQueryKeys.works("project-1"), {
      works: [responseWork],
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
    expect(client.getQueryData<ListWorksResponse>(projectQueryKeys.works("project-1"))).toEqual({
      works: [responseWork],
    });
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
        projectId: "project-1",
        catalogGeneration: "generation-1",
        authorityRevision: "1",
        requestId: "request-1",
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
    listProjectWorks.mockResolvedValue(worksSnapshot([{ id: "work-c", name: "C" }], "2"));
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
    client.setQueryData(
      projectQueryKeys.works("project-1"),
      worksSnapshot(
        [
          { id: "work-a", name: "A" },
          { id: "work-b", name: "B" },
          { id: "work-c", name: "C" },
        ],
        "1",
      ),
    );
    let resolveMutation: ((result: RebindThreadWorkResponse) => void) | undefined;
    rebindThreadWork.mockReturnValue(
      new Promise<RebindThreadWorkResponse>((resolve) => {
        resolveMutation = resolve;
      }),
    );
    listProjectThreads.mockResolvedValue([
      { id: "thread-1", projectId: "project-1", workId: "work-c" },
    ]);
    listProjectWorks.mockResolvedValue(worksSnapshot([{ id: "work-c", name: "C" }], "2"));

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
      signal: {
        projectId: "project-1",
        threadId: "thread-1",
        scope: { kind: "work", workId: "work-c", workSlug: testWorkSlug("work-c") },
      },
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

  it("keeps an explicit none result nullable through mutation and caches", async () => {
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    client.setQueryData(projectQueryKeys.threads("project-1"), [
      { id: "thread-1", projectId: "project-1", workId: "work-a" },
    ]);
    client.setQueryData(projectQueryKeys.works("project-1"), { works: [responseWork] });
    rebindThreadWork.mockResolvedValue({
      ...response,
      after: { kind: "none" },
      receipt: { ...response.receipt, after: { kind: "none" } },
    });
    let mutateAsync: ReturnType<typeof useRebindThreadWork>["mutateAsync"] | undefined;
    function Probe() {
      mutateAsync = useRebindThreadWork("project-1", "thread-1").mutateAsync;
      return null;
    }
    const root = createRoot(document.createElement("div"));
    act(() => root.render(createElement(QueryClientProvider, { client }, createElement(Probe))));
    let outcome: Awaited<ReturnType<NonNullable<typeof mutateAsync>>> | undefined;
    await act(async () => {
      outcome = await mutateAsync?.({ target: { kind: "none" }, previousWorkId: "work-a" });
    });
    expect(outcome).toMatchObject({ kind: "confirmed", result: { work: null } });
    expect(
      client.getQueryData<ThreadListItem[]>(projectQueryKeys.threads("project-1"))?.[0]?.workId,
    ).toBeNull();
    act(() => root.unmount());
  });
});

function worksSnapshot(works: unknown[], authorityRevision: string): ListWorksResponse {
  return {
    projectId: "project-1",
    catalogGeneration: "generation-1",
    authorityRevision,
    requestId: `request-${authorityRevision}`,
    works: works as never,
  };
}
