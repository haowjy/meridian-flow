/**
 * Regression: disposition mutations must hold isPending until the
 * disposition-state refetch (workDrafts) settles. If onSuccess fires the
 * invalidation without returning it, isPending drops while the refetch is
 * still in flight and review verbs re-enable against stale rows.
 */
import { createRequire } from "node:module";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

const { acceptDraftMock } = vi.hoisted(() => ({
  acceptDraftMock: vi.fn(),
}));

vi.mock("@/client/api/drafts-api", () => ({
  acceptDraft: acceptDraftMock,
  rejectDraft: vi.fn(),
  undoAcceptDraft: vi.fn(),
  undoRejectDraft: vi.fn(),
}));

const require = createRequire(import.meta.url);
const { JSDOM } = require("jsdom") as {
  JSDOM: new (html: string) => { window: Window & typeof globalThis & { close: () => void } };
};

const { useAcceptDraft } = await import("./useDraftReviewMutations");
const { projectQueryKeys } = await import("./project-query-keys");

// TanStack Query batches observer notifications through setTimeout; a
// microtask flush alone leaves component state stale.
const flushNotifications = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

describe("useAcceptDraft pending lifecycle", () => {
  it("holds isPending until the workDrafts refetch settles", async () => {
    const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
    const previousWindow = globalThis.window;
    const previousDocument = globalThis.document;
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    let fetchCount = 0;
    let releaseRefetch: (() => void) | undefined;
    const harnessRef: { accept: ReturnType<typeof useAcceptDraft> | null } = { accept: null };

    function Harness() {
      harnessRef.accept = useAcceptDraft();
      // Mounted subscriber so invalidateQueries actually refetches the key.
      useQuery({
        queryKey: projectQueryKeys.workDrafts("project-1", "work-1"),
        queryFn: () => {
          fetchCount += 1;
          if (fetchCount === 1) return Promise.resolve([]);
          return new Promise<unknown[]>((resolve) => {
            releaseRefetch = () => resolve([]);
          });
        },
      });
      return null;
    }

    acceptDraftMock.mockResolvedValue({ status: "applied" });

    try {
      const rootNode = dom.window.document.getElementById("root");
      if (!rootNode) throw new Error("missing root");
      const root = createRoot(rootNode);
      await act(async () => {
        root.render(
          <QueryClientProvider client={queryClient}>
            <Harness />
          </QueryClientProvider>,
        );
      });
      expect(fetchCount).toBe(1);

      act(() => {
        harnessRef.accept?.mutate({
          projectId: "project-1",
          workId: "work-1",
          documentId: "doc-1",
          draftId: "branch-1",
          branchId: "branch-1",
          draftRevisionToken: 1,
        });
      });
      // Flush the resolved server call and the onSuccess invalidation kickoff.
      await flushNotifications();

      // Server call is done and the workDrafts refetch is in flight — the
      // mutation must still report pending or verbs re-enable on stale rows.
      expect(acceptDraftMock).toHaveBeenCalledTimes(1);
      expect(fetchCount).toBe(2);
      expect(harnessRef.accept?.isPending).toBe(true);

      await act(async () => {
        releaseRefetch?.();
      });
      await flushNotifications();
      expect(harnessRef.accept?.isPending).toBe(false);
      expect(harnessRef.accept?.isSuccess).toBe(true);

      await act(async () => root.unmount());
    } finally {
      queryClient.clear();
      // Drain batched notification timers before tearing down the JSDOM
      // globals — a late notify with no window crashes react-dom.
      await new Promise((resolve) => setTimeout(resolve, 0));
      globalThis.window = previousWindow;
      globalThis.document = previousDocument;
      dom.window.close();
    }
  });
});
