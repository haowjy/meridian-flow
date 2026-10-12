// @vitest-environment jsdom
/** Regression probe: browser refuses access to localStorage itself at initial bind. */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { MeridianApiError } from "@/client/api/meridian-error";
import {
  bindChatSubmissions,
  forgetCreatedChat,
  getChatSubmissionAccountId,
} from "@/client/chat-submissions";
import { threadSnapshotQueryOptions } from "@/client/query/useThreadSnapshotSync";
import { ThreadStoreProvider } from "@/client/stores";
import { useProjectChatNavigation } from "@/features/project/routing/chat-navigation";

vi.mock("@/client/chat-submissions/adapters/browser-lock", async () => {
  const { MemorySubmissionLock } = await import("@/client/chat-submissions/adapters/memory-lock");
  return { browserSubmissionLock: new MemorySubmissionLock() };
});
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
it("repairs confirmed missing-chat route when localStorage getter is denied", async () => {
  const blocked = vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
    throw new DOMException("Storage access denied", "SecurityError");
  });
  const client = new QueryClient();
  const go = vi.fn(async () => ({ kind: "applied" as const }));
  const root = createRoot(document.createElement("div"));
  function Harness() {
    useProjectChatNavigation({
      accountId: "writer",
      projectId: "project",
      activeScreen: "chat",
      urlChatId: "gone",
      go,
    });
    return null;
  }
  try {
    bindChatSubmissions("writer");
    expect(getChatSubmissionAccountId()).toBe("writer");
    expect(await forgetCreatedChat("writer", "gone")).toBe("unavailable");
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <ThreadStoreProvider now={0}>
            <Harness />
          </ThreadStoreProvider>
        </QueryClientProvider>,
      ),
    );
    const query = client
      .getQueryCache()
      .build(client, { queryKey: threadSnapshotQueryOptions("gone").queryKey });
    await act(async () => {
      query.setState({
        status: "error",
        errorUpdatedAt: Date.now(),
        error: new MeridianApiError(
          {
            code: "thread_not_found",
            details: { authenticatedUserId: "writer" },
            message: "Thread not found",
            source: "system",
            retryable: false,
          },
          404,
        ),
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(go).toHaveBeenCalledWith({ kind: "chat-index" }, { replace: true });
  } finally {
    act(() => root.unmount());
    client.clear();
    blocked.mockRestore();
  }
});
