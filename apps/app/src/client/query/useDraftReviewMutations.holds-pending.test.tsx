/**
 * Regression: disposition mutations must hold isPending until the
 * disposition-state refetch (workDrafts) settles. If onSuccess fires the
 * invalidation without returning it, isPending drops while the refetch is
 * still in flight and review verbs re-enable against stale rows.
 */
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { withReactRoot } from "@/test-support/react-dom-harness";

const { acceptDraftMock } = vi.hoisted(() => ({
  acceptDraftMock: vi.fn(),
}));

vi.mock("@/client/api/drafts-api", () => ({
  acceptDraft: acceptDraftMock,
  rejectDraft: vi.fn(),
  undoAcceptDraft: vi.fn(),
  undoRejectDraft: vi.fn(),
}));

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
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    let fetchCount = 0;
    let treeFetchCount = 0;
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
      useQuery({
        queryKey: projectQueryKeys.contextTree("project-1", "manuscript"),
        queryFn: async () => {
          treeFetchCount += 1;
          return [];
        },
      });
      return null;
    }

    acceptDraftMock.mockResolvedValue({ status: "applied" });

    try {
      await withReactRoot(
        <QueryClientProvider client={queryClient}>
          <Harness />
        </QueryClientProvider>,
        async () => {
          expect(fetchCount).toBe(1);
          expect(treeFetchCount).toBe(1);

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
          expect(treeFetchCount).toBe(2);
          expect(harnessRef.accept?.isPending).toBe(true);

          await act(async () => {
            releaseRefetch?.();
          });
          await flushNotifications();
          expect(harnessRef.accept?.isPending).toBe(false);
          expect(harnessRef.accept?.isSuccess).toBe(true);
        },
        { drainMacrotask: true },
      );
    } finally {
      queryClient.clear();
    }
  });
});
