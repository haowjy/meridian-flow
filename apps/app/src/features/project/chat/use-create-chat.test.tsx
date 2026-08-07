import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { withReactRoot } from "@/test-support/react-dom-harness";

const createProjectThread = vi.fn();
const invalidateProjectThreadData = vi.fn();

vi.mock("@/client/api/projects-api", () => ({ createProjectThread }));
vi.mock("@/client/query/project-invalidation", () => ({ invalidateProjectThreadData }));

const { useCreateChat } = await import("./use-create-chat");
const flush = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

describe("useCreateChat", () => {
  it("submits the chosen Work, exposes failure, and retries without changing it", async () => {
    createProjectThread
      .mockRejectedValueOnce(new Error("Could not create chat"))
      .mockResolvedValueOnce({ id: "thread-1" });
    invalidateProjectThreadData.mockResolvedValue(undefined);
    const selectThread = vi.fn();
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    const state: { value: ReturnType<typeof useCreateChat> | null } = { value: null };

    function Harness() {
      state.value = useCreateChat("project-1", selectThread);
      return null;
    }

    try {
      await withReactRoot(
        <QueryClientProvider client={client}>
          <Harness />
        </QueryClientProvider>,
        async () => {
          act(() => state.value?.createChat("work-archived-current"));
          await flush();
          expect(state.value?.createError?.message).toBe("Could not create chat");
          expect(selectThread).not.toHaveBeenCalled();

          act(() => state.value?.createChat("work-archived-current"));
          await flush();
          expect(createProjectThread).toHaveBeenNthCalledWith(
            1,
            "project-1",
            expect.objectContaining({ workId: "work-archived-current" }),
          );
          expect(createProjectThread).toHaveBeenNthCalledWith(
            2,
            "project-1",
            expect.objectContaining({ workId: "work-archived-current" }),
          );
          expect(selectThread).toHaveBeenCalledWith("thread-1");
        },
        { drainMacrotask: true },
      );
    } finally {
      client.clear();
    }
  });
});
