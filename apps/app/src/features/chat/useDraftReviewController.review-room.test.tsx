// @vitest-environment jsdom
/**
 * The review room a launch resolves is not lost when another review closes in
 * the same moment: switching from one document's review to a draft-only
 * document's (the switcher's new-document row, Apply draft or Next draft moving
 * into one) closes the first and opens the second in one effect flush.
 */
import type { Work } from "@meridian/contracts/works";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, useEffect } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenContextRoute } from "@/features/project/routing/ProjectNavigationContext";
import { ProjectNavigationProvider } from "@/features/project/routing/ProjectNavigationContext";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { type DraftReviewController, useDraftReviewController } from "./useDraftReviewController";

const work = { id: "work-a", projectId: "project-a", name: "w", isNoWork: false } as Work;

vi.mock("@/client/api/drafts-api", () => ({
  getDraftPreview: vi.fn(async (_p: string, _w: string, documentId: string, draftId: string) => ({
    status: "active",
    draftId,
    reviewRoomName: `room-${documentId}`,
  })),
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
});
