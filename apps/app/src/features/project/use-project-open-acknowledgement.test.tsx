// @vitest-environment jsdom
/** ProjectView's one wiring contract between a Home open and the visible Chat owner. */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useThreadOpenAcknowledgement } from "@/client/query/useThreadOpenAcknowledgement";
import { ThreadStoreProvider } from "@/client/stores";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { useProjectOpenAcknowledgement } from "./use-project-open-acknowledgement";

const projectId = "project-1";
const threadId = "thread-1";

async function waitFor(check: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) return;
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  }
  throw new Error("condition not reached");
}

afterEach(() => vi.unstubAllGlobals());

describe("ProjectView Home open composition", () => {
  it("hands the successful navigation transfer to the visible Chat owner", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const patches: Array<{ path: string; body: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        patches.push({ path: String(input), body: JSON.parse(String(init?.body)) });
        return new Response(
          JSON.stringify({
            threadId,
            projectId,
            isFavorite: false,
            attention: "none",
            updatedAt: "2026-08-26T00:00:00.000Z",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }),
    );

    function Harness() {
      const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
      const ownership = useProjectOpenAcknowledgement({
        projectId,
        activeScreen: activeThreadId ? "chat" : "home",
        activeThreadId,
        onSelectThread: async (nextThreadId) => setActiveThreadId(nextThreadId),
      });
      const acknowledgement = useThreadOpenAcknowledgement({
        projectId,
        threadId: activeThreadId ?? "not-routed",
        visible: activeThreadId !== null,
        transfer: ownership.openTransfer,
        onTransferClaimed: ownership.onOpenTransferClaimed,
      });
      return (
        <>
          <button type="button" onClick={() => ownership.onOpenThread(threadId)}>
            Open thread
          </button>
          <output>{acknowledgement.pending ? "saving" : "settled"}</output>
        </>
      );
    }

    await withReactRoot(
      <QueryClientProvider client={client}>
        <ThreadStoreProvider now={0}>
          <Harness />
        </ThreadStoreProvider>
      </QueryClientProvider>,
      async () => {
        await act(async () => {
          document.querySelector("button")?.click();
        });
        await waitFor(() => patches.length === 1);
        await waitFor(() => document.querySelector("output")?.textContent === "settled");

        expect(patches).toEqual([
          expect.objectContaining({
            path: `/api/threads/${threadId}/user-state`,
            body: { isUnread: false },
          }),
        ]);
      },
      { drainMacrotask: true },
    );
  });
});
