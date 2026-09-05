/**
 * Regression: disposition mutations must hold isPending until the
 * disposition-state refetch (workDrafts) settles. If onSuccess fires the
 * invalidation without returning it, isPending drops while the refetch is
 * still in flight and review verbs re-enable against stale rows.
 */
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { withReactRoot } from "@/test-support/react-dom-harness";

const { applyDraftMock } = vi.hoisted(() => ({
  applyDraftMock: vi.fn(),
}));

const owner = {
  reserveApply: vi.fn(() => ({
    kind: "reserved",
    unsent: {
      reservation: {
        identity: {
          accountId: "account-1",
          projectId: "project-1",
          workId: "work-1",
          documentId: "doc-1",
          draftId: "branch-1",
        },
        reservationVersion: 1,
      },
    },
  })),
  acquireApplyDispatch: vi.fn((unsent) => ({
    kind: "dispatch-granted",
    dispatch: { reservation: unsent.reservation, dispatchVersion: 1 },
  })),
  recordServerApplied: vi.fn(() => ({
    kind: "recorded",
    recovery: {
      identity: {
        accountId: "account-1",
        projectId: "project-1",
        workId: "work-1",
        documentId: "doc-1",
        draftId: "branch-1",
      },
      entryVersion: 2,
    },
  })),
  markApplyOutcomeUnknown: vi.fn((dispatch) => ({
    kind: "outcome-unknown",
    reservation: dispatch.reservation,
  })),
};

vi.mock("@/features/project/draft-apply-recovery/DraftApplyRecoveryProvider", () => ({
  usePostApplyDispositionOwner: () => owner,
}));

vi.mock("@/client/api/drafts-api", () => ({
  applyDraft: applyDraftMock,
  discardDraft: vi.fn(),
}));

const { useApplyDraft } = await import("./useDraftReviewMutations");
const { projectQueryKeys } = await import("./project-query-keys");

// TanStack Query batches observer notifications through setTimeout; a
// microtask flush alone leaves component state stale.
const flushNotifications = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

describe("useApplyDraft committed outcome", () => {
  beforeEach(() => {
    applyDraftMock.mockReset();
    owner.recordServerApplied.mockClear();
    owner.markApplyOutcomeUnknown.mockClear();
  });

  it("routes a non-authoritative Apply 2xx through the exact outcome-unknown grant", async () => {
    const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    const harnessRef: { apply: ReturnType<typeof useApplyDraft> | null } = { apply: null };
    function Harness() {
      harnessRef.apply = useApplyDraft();
      return null;
    }
    applyDraftMock.mockRejectedValue(
      new Error("Draft Apply response did not prove the requested draft was applied"),
    );
    await withReactRoot(
      <QueryClientProvider client={queryClient}>
        <Harness />
      </QueryClientProvider>,
      async () => {
        const result = await harnessRef.apply?.mutateAsync({
          projectId: "project-1",
          workId: "work-1",
          documentId: "doc-1",
          draftId: "branch-1",
          identity: {
            accountId: "account-1",
            projectId: "project-1",
            workId: "work-1",
            documentId: "doc-1",
            draftId: "branch-1",
          },
          presentation: {
            documentName: "Chapter",
            contextPath: "chapter.md",
            owningWorkLabel: "Work one",
          },
          obligations: { draftTab: { kind: "none" }, branch: { kind: "none" } },
        });
        expect(result).toMatchObject({ kind: "apply-outcome-unknown" });
        expect(applyDraftMock).toHaveBeenCalledOnce();
        expect(owner.recordServerApplied).not.toHaveBeenCalled();
        expect(owner.markApplyOutcomeUnknown).toHaveBeenCalledOnce();
      },
      { drainMacrotask: true },
    );
  });

  it("does not let freshness refetch hold or reject the committed command", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    let fetchCount = 0;
    let treeFetchCount = 0;
    let releaseRefetch: (() => void) | undefined;
    const harnessRef: { apply: ReturnType<typeof useApplyDraft> | null } = { apply: null };

    function Harness() {
      harnessRef.apply = useApplyDraft();
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
        queryKey: projectQueryKeys.contextCatalogView("project-1", "manuscript"),
        queryFn: async () => {
          treeFetchCount += 1;
          return [];
        },
      });
      return null;
    }

    applyDraftMock.mockResolvedValue({ status: "applied", draftId: "branch-1" });

    try {
      await withReactRoot(
        <QueryClientProvider client={queryClient}>
          <Harness />
        </QueryClientProvider>,
        async () => {
          expect(fetchCount).toBe(1);
          expect(treeFetchCount).toBe(1);

          act(() => {
            harnessRef.apply?.mutate({
              projectId: "project-1",
              workId: "work-1",
              documentId: "doc-1",
              draftId: "branch-1",
              identity: {
                accountId: "account-1",
                projectId: "project-1",
                workId: "work-1",
                documentId: "doc-1",
                draftId: "branch-1",
              },
              presentation: {
                documentName: "Chapter",
                contextPath: "chapter.md",
                owningWorkLabel: null,
              },
              obligations: { draftTab: { kind: "none" }, branch: { kind: "none" } },
            });
          });
          // Flush the resolved server call and the onSuccess invalidation kickoff.
          await flushNotifications();

          // Server call is done and the workDrafts refetch is in flight — the
          // mutation must still report pending or verbs re-enable on stale rows.
          expect(applyDraftMock).toHaveBeenCalledTimes(1);
          expect(fetchCount).toBe(2);
          expect(treeFetchCount).toBe(2);
          expect(harnessRef.apply?.isPending).toBe(false);

          await act(async () => {
            releaseRefetch?.();
          });
          await flushNotifications();
          expect(harnessRef.apply?.isPending).toBe(false);
          expect(harnessRef.apply?.isSuccess).toBe(true);
        },
        { drainMacrotask: true },
      );
    } finally {
      queryClient.clear();
    }
  });
});
