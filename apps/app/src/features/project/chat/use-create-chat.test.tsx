import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { withReactRoot } from "@/test-support/react-dom-harness";

const createProjectThread = vi.fn();
const invalidateProjectThreadData = vi.fn();

vi.mock("@/client/api/projects-api", () => ({ createProjectThread }));
vi.mock("@/client/query/project-invalidation", () => ({ invalidateProjectThreadData }));

const { useCreateChat } = await import("./use-create-chat");
const flush = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

describe("useCreateChat", () => {
  beforeEach(() => {
    createProjectThread.mockReset();
    invalidateProjectThreadData.mockReset();
  });
  it("omits Work, exposes failure, and retries through the shared lifecycle", async () => {
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
          act(() => state.value?.createChat());
          await flush();
          expect(state.value?.createError?.message).toBe("Could not create chat");
          expect(selectThread).not.toHaveBeenCalled();

          act(() => state.value?.createChat());
          await flush();
          expect(createProjectThread).toHaveBeenNthCalledWith(
            1,
            "project-1",
            expect.not.objectContaining({ workId: expect.anything() }),
          );
          expect(createProjectThread).toHaveBeenNthCalledWith(
            2,
            "project-1",
            expect.not.objectContaining({ workId: expect.anything() }),
          );
          expect(selectThread).toHaveBeenCalledWith("thread-1");
        },
        { drainMacrotask: true },
      );
    } finally {
      client.clear();
    }
  });

  it("suppresses overlapping creates in the same tick", async () => {
    let resolveCreate!: (thread: { id: string }) => void;
    createProjectThread.mockImplementationOnce(
      () => new Promise<{ id: string }>((resolve) => (resolveCreate = resolve)),
    );
    invalidateProjectThreadData.mockResolvedValue(undefined);
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    const state: { value: ReturnType<typeof useCreateChat> | null } = { value: null };

    function Harness() {
      state.value = useCreateChat("project-1", vi.fn());
      return null;
    }

    try {
      await withReactRoot(
        <QueryClientProvider client={client}>
          <Harness />
        </QueryClientProvider>,
        async () => {
          await act(async () => {
            state.value?.createChat();
            state.value?.createChat();
            await Promise.resolve();
          });
          expect(createProjectThread).toHaveBeenCalledTimes(1);
          resolveCreate({ id: "thread-1" });
          await flush();
        },
        { drainMacrotask: true },
      );
    } finally {
      client.clear();
    }
  });
});
