import type { Work } from "@meridian/contracts/works";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseExplicitWork, resolveRouteWork } from "@/features/project/routing/project-route";
import { withReactRoot } from "@/test-support/react-dom-harness";

const api = vi.hoisted(() => ({
  listProjectWorks: vi.fn(),
  createProjectWork: vi.fn(),
  updateWorkWriteMode: vi.fn(),
}));

vi.mock("@/client/api/projects-api", () => ({
  ...api,
  archiveWork: vi.fn(),
  deleteWork: vi.fn(),
  unarchiveWork: vi.fn(),
  updateWork: vi.fn(),
}));
vi.mock("@/client/stores", () => ({
  useIsProjectPendingCreation: () => false,
}));

const { useUpdateWorkWriteMode, useWorkMutations, useWorks } = await import("./useWorks");
const { projectQueryKeys } = await import("./project-query-keys");
const { threadQueryKeys } = await import("./thread-query-keys");

const flush = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

describe("Work client queries", () => {
  beforeEach(() => vi.clearAllMocks());

  it("loads the complete Work catalog, including archived Works", async () => {
    api.listProjectWorks.mockResolvedValue({ works: [], newChatFallbackWorkId: "work-current" });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const state: { value: ReturnType<typeof useWorks> | null } = { value: null };

    function Harness() {
      state.value = useWorks("project-1");
      return null;
    }

    try {
      await withReactRoot(
        <QueryClientProvider client={client}>
          <Harness />
        </QueryClientProvider>,
        async () => {
          await flush();
          expect(api.listProjectWorks).toHaveBeenCalledWith("project-1", { status: "all" });
          expect(state.value?.newChatFallbackWorkId).toBe("work-current");
        },
        { drainMacrotask: true },
      );
    } finally {
      client.clear();
    }
  });

  it.each([
    { type: "create", data: { name: "New Work" } },
    { type: "update", workId: "work-1", data: { name: "Renamed Work" } },
    { type: "archive", workId: "work-1" },
    { type: "unarchive", workId: "work-1" },
    { type: "delete", workId: "work-1" },
  ] as const)("invalidates Home after Work $type", async (action) => {
    const client = new QueryClient();
    const homeKey = projectQueryKeys.homeFeed("project-1");
    const associated = projectQueryKeys.workThreads("project-1", "work-1");
    client.setQueryData(homeKey, { fresh: true });
    client.setQueryData(associated, { fresh: true });
    const state: { value: ReturnType<typeof useWorkMutations> | null } = { value: null };

    function Harness() {
      state.value = useWorkMutations("project-1");
      return null;
    }

    try {
      await withReactRoot(
        <QueryClientProvider client={client}>
          <Harness />
        </QueryClientProvider>,
        async () => {
          await act(async () => {
            await state.value?.mutateAsync(action);
          });
          expect(client.getQueryState(homeKey)?.isInvalidated).toBe(true);
          expect(client.getQueryState(associated)?.isInvalidated).toBe(action.type !== "create");
        },
      );
    } finally {
      client.clear();
    }
  });

  it("adopts a created Work into the catalog before route resolution", async () => {
    const created = {
      id: "11111111-1111-4111-8111-111111111111",
      name: "New Work",
    } as Work;
    api.createProjectWork.mockResolvedValue(created);
    const client = new QueryClient();
    client.setQueryData(projectQueryKeys.works("project-1"), {
      works: [],
      newChatFallbackWorkId: "fallback",
    });
    const state: { value: ReturnType<typeof useWorkMutations> | null } = { value: null };
    function Harness() {
      state.value = useWorkMutations("project-1");
      return null;
    }
    await withReactRoot(
      <QueryClientProvider client={client}>
        <Harness />
      </QueryClientProvider>,
      async () => {
        await act(async () => {
          await state.value?.mutateAsync({ type: "create", data: { name: "New Work" } });
        });
        const catalog = client.getQueryData<{
          works: (typeof created)[];
          newChatFallbackWorkId: string;
        }>(projectQueryKeys.works("project-1"));
        expect(catalog).toEqual({
          works: [created],
          newChatFallbackWorkId: "fallback",
        });
        expect(
          resolveRouteWork(parseExplicitWork(created.id), {
            status: "success",
            works: catalog?.works ?? [],
          }).status,
        ).toBe("present");
      },
    );
    client.clear();
  });

  it.each([
    "confirmation_required",
    "updated",
  ] as const)("invalidates every Work push projection after %s", async (status) => {
    api.updateWorkWriteMode.mockResolvedValue(
      status === "updated"
        ? { status, aiWriteMode: "direct", pendingChangeCount: 0 }
        : { status, aiWriteMode: "draft", pendingChangeCount: 2 },
    );
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const state: { value: ReturnType<typeof useUpdateWorkWriteMode> | null } = { value: null };

    function Harness() {
      state.value = useUpdateWorkWriteMode("project-1", "work-1");
      return null;
    }

    try {
      await withReactRoot(
        <QueryClientProvider client={client}>
          <Harness />
        </QueryClientProvider>,
        async () => {
          await act(async () => {
            await state.value?.mutateAsync({ aiWriteMode: "direct", confirmedPush: true });
          });
          expect(invalidate).toHaveBeenCalledWith({
            queryKey: projectQueryKeys.workDrafts("project-1", "work-1"),
          });
          expect(invalidate).toHaveBeenCalledWith({
            queryKey: projectQueryKeys.threads("project-1"),
          });
          expect(invalidate).toHaveBeenCalledWith({ queryKey: threadQueryKeys.all });
          expect(invalidate).toHaveBeenCalledWith({
            queryKey: ["projects", "project-1", "works", "work-1", "documents"],
          });
        },
        { drainMacrotask: true },
      );
    } finally {
      client.clear();
    }
  });
});
