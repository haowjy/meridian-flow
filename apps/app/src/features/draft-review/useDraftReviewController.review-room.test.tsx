// @vitest-environment jsdom
/**
 * The review room lives in the open review (the reducer's), found by a read the
 * controller starts for a review that has none. A launch's room is not lost when
 * another review closes in the same moment: switching from one document's review
 * to a draft-only document's (the switcher's new-document row, Apply draft or
 * Next draft moving into one) closes the first and opens the second in one effect
 * flush. A failed read is the review's error, and entering the draft again retries it.
 */
import type { Work } from "@meridian/contracts/works";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, useEffect } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import type { OpenContextRoute } from "@/features/project/routing/ProjectNavigationContext";
import { ProjectNavigationProvider } from "@/features/project/routing/ProjectNavigationContext";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { type DraftReviewController, useDraftReviewController } from "./useDraftReviewController";

const work = { id: "work-a", projectId: "project-a", name: "w", isNoWork: false } as Work;

const failing = vi.hoisted(() => new Set<string>());
/** Reads of a document still to be cancelled in flight, as a refresh's invalidation does. */
const cancelled = vi.hoisted(() => ({
  reads: new Map<string, number>(),
  cancel: (_documentId: string) => {},
}));
vi.mock("@/client/api/drafts-api", () => ({
  getDraftPreview: vi.fn(async (_p: string, _w: string, documentId: string, draftId: string) => {
    if (failing.has(documentId)) throw new Error("offline");
    const toCancel = cancelled.reads.get(documentId) ?? 0;
    if (toCancel > 0) {
      cancelled.reads.set(documentId, toCancel - 1);
      await Promise.resolve();
      cancelled.cancel(documentId);
      return new Promise<never>(() => {});
    }
    return {
      status: "active",
      draftId,
      draftGeneration: 1,
      inlineModelPresent: true,
      reviewRoomName: `room-${documentId}`,
      operations: [],
      hunks: [],
    };
  }),
}));
vi.mock("@/features/project/context/account-feature-context", () => ({
  useContextRemovalCoordinator: () => ({}),
}));

let controller: DraftReviewController;
/** The document a child opens as soon as it sees no review open, like the address owner's follow-up claim. */
let openNext: string | null = null;

/** A descendant of the hook's owner: its effects run before the owner's in a flush. */
function Claimant({ review }: { review: DraftReviewController }) {
  useEffect(() => {
    if (review.inlineReview || !openNext) return;
    const documentId = openNext;
    openNext = null;
    review.enterInlineReview(documentId, `draft-${documentId}`);
  }, [review]);
  return null;
}

function Owner() {
  controller = useDraftReviewController({ projectId: "project-a", work });
  return <Claimant review={controller} />;
}

describe("review room across a review switch", () => {
  beforeEach(() => {
    openNext = null;
    failing.clear();
    cancelled.reads.clear();
  });

  it("resolves the room of a review opened in the flush that closes the previous one", async () => {
    await withReactRoot(
      <QueryClientProvider client={new QueryClient()}>
        <ProjectNavigationProvider openContextRoute={vi.fn<OpenContextRoute>()} screen="context">
          <Owner />
        </ProjectNavigationProvider>
      </QueryClientProvider>,
      async () => {
        await act(async () => controller.enterInlineReview("doc-a", "draft-doc-a"));
        expect(controller.reviewRoomName).toBe("room-doc-a");

        openNext = "doc-new";
        await act(async () => controller.exitInlineReview());
        expect(controller.inlineReview?.documentId).toBe("doc-new");
        expect(controller.reviewRoomName).toBe("room-doc-new");
        expect(controller.reviewRoomError).toBe(false);
      },
    );
  });
  it("reports a failed read as the review's room error, and entering the draft again retries it", async () => {
    await withReactRoot(
      <QueryClientProvider client={new QueryClient()}>
        <ProjectNavigationProvider openContextRoute={vi.fn<OpenContextRoute>()} screen="context">
          <Owner />
        </ProjectNavigationProvider>
      </QueryClientProvider>,
      async () => {
        failing.add("doc-flaky");
        await act(async () => controller.enterInlineReview("doc-flaky", "draft-doc-flaky"));
        await vi.waitFor(() => expect(controller.reviewRoomError).toBe(true));
        expect(controller.reviewRoomName).toBeNull();

        failing.clear();
        await act(async () => controller.enterInlineReview("doc-flaky", "draft-doc-flaky"));
        await vi.waitFor(() => expect(controller.reviewRoomName).toBe("room-doc-flaky"));
        expect(controller.reviewRoomError).toBe(false);
      },
    );
  });

  describe("a read cancelled in flight", () => {
    const withCancellingClient = (run: () => Promise<void>) => {
      const client = new QueryClient();
      cancelled.cancel = (documentId) =>
        void client.cancelQueries({
          queryKey: projectQueryKeys.workDraftPreview(
            "project-a",
            "work-a",
            documentId,
            `draft-${documentId}`,
          ),
        });
      return withReactRoot(
        <QueryClientProvider client={client}>
          <ProjectNavigationProvider openContextRoute={vi.fn<OpenContextRoute>()} screen="context">
            <Owner />
          </ProjectNavigationProvider>
        </QueryClientProvider>,
        run,
      );
    };

    it("is read again, and a cancellation is not a failed room", async () => {
      cancelled.reads.set("doc-busy", 2);
      await withCancellingClient(async () => {
        await act(async () => controller.enterInlineReview("doc-busy", "draft-doc-busy"));
        await vi.waitFor(() => expect(controller.reviewRoomName).toBe("room-doc-busy"));
        expect(controller.reviewRoomError).toBe(false);
      });
    });

    it("is read again only a bounded number of times, then the room is failed and re-entry retries", async () => {
      cancelled.reads.set("doc-busy", 1_000);
      await withCancellingClient(async () => {
        await act(async () => controller.enterInlineReview("doc-busy", "draft-doc-busy"));
        await vi.waitFor(() => expect(controller.reviewRoomError).toBe(true));
        expect(controller.reviewRoomName).toBeNull();

        cancelled.reads.clear();
        await act(async () => controller.enterInlineReview("doc-busy", "draft-doc-busy"));
        await vi.waitFor(() => expect(controller.reviewRoomName).toBe("room-doc-busy"));
        expect(controller.reviewRoomError).toBe(false);
      });
    });
  });

  it("holds the room with the review: leaving drops it, and a stale one is read again in place", async () => {
    await withReactRoot(
      <QueryClientProvider client={new QueryClient()}>
        <ProjectNavigationProvider openContextRoute={vi.fn<OpenContextRoute>()} screen="context">
          <Owner />
        </ProjectNavigationProvider>
      </QueryClientProvider>,
      async () => {
        await act(async () => controller.enterInlineReview("doc-a", "draft-doc-a"));
        expect(controller.reviewRoomName).toBe("room-doc-a");
        expect(controller.inlineReview?.roomName).toBe("room-doc-a");

        await act(async () => controller.reviewRoomStale("doc-a", "draft-doc-a", "room-doc-a"));
        await vi.waitFor(() => expect(controller.reviewRoomName).toBe("room-doc-a"));
        expect(controller.inlineReview?.documentId).toBe("doc-a");

        await act(async () => controller.exitReview());
        expect(controller.inlineReview).toBeNull();
        expect(controller.reviewRoomName).toBeNull();
      },
    );
  });
});
