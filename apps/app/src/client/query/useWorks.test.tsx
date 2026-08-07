import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { withReactRoot } from "@/test-support/react-dom-harness";

const api = vi.hoisted(() => ({
  listProjectWorks: vi.fn(),
  updateWorkWriteMode: vi.fn(),
}));

vi.mock("@/client/api/projects-api", () => ({
  ...api,
  archiveWork: vi.fn(),
  createProjectWork: vi.fn(),
  deleteWork: vi.fn(),
  setCurrentWork: vi.fn(),
  unarchiveWork: vi.fn(),
  updateWork: vi.fn(),
}));
vi.mock("@/client/stores", () => ({
  useIsProjectPendingCreation: () => false,
}));

const { useUpdateWorkWriteMode, useWorks } = await import("./useWorks");
const { projectQueryKeys } = await import("./project-query-keys");
const { threadQueryKeys } = await import("./thread-query-keys");

const flush = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

describe("Work client queries", () => {
  beforeEach(() => vi.clearAllMocks());

  it("loads the complete Work catalog, including archived Works", async () => {
    api.listProjectWorks.mockResolvedValue({ works: [], defaultWorkId: "work-current" });
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
          expect(state.value?.currentWorkId).toBe("work-current");
        },
        { drainMacrotask: true },
      );
    } finally {
      client.clear();
    }
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
