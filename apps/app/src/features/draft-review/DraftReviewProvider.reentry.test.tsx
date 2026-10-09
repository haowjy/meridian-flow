// @vitest-environment jsdom
/**
 * A review on "No changes left" takes up its draft's next proposal. The server
 * closes a draft by resetting its branch and reuses the id for what the AI
 * writes next; the closed review re-enters that id in place (fresh preview and
 * room, completion cleared), decided by a read that started after the close, never
 * by a list row or a read from before it. Real provider, controller, mutations and
 * query cache; the network is the only fake.
 */

import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetDraftCommandRecords } from "@/client/query/draft-command-record";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import {
  applied,
  change,
  draftA,
  listed,
  previewOf,
  renderReviewScopes,
  type ScopeProbe,
} from "@/test-support/draft-review-scope";

const mocks = vi.hoisted(() => ({
  listWorkDrafts: vi.fn(),
  getDraftPreview: vi.fn(),
  applyDraftChanges: vi.fn(),
  discardDraft: vi.fn(),
}));

vi.mock("@/client/api/drafts-api", () => mocks);
vi.mock("@/client/query/useContextCatalog", () => ({
  contextCatalogScope: () => ({ kind: "project", projectId: "project-a" }),
  useContextCatalogView: () => ({ catalog: null }),
  projectCatalogView: () => ({ findDocument: () => null }),
}));
vi.mock("@/features/project/context/account-feature-context", () => ({
  useContextRemovalCoordinator: () => ({ promoteAppliedDraft: vi.fn(), discardDraft: vi.fn() }),
  useOptionalAccountResourceReplica: () => null,
  useLiveDocumentSessionRegistry: () => ({
    retainBranchRooms: vi.fn(),
    releaseBranchRooms: vi.fn(),
    getBranchRoom: () => ({ document: { on: vi.fn(), off: vi.fn() } }),
  }),
}));

const classIds = (probe: ScopeProbe) => probe.header.view.items.map((item) => item.change.classId);

/** The branch after the server's reset: the same id and room family, nothing to review. */
const resetPreview = { ...previewOf(), draftRevisionToken: "draft-reset" };

/** The agent's next proposal on the reused id: another generation, another room. */
const nextProposal = {
  ...previewOf("5"),
  draftRevisionToken: "draft-next",
  reviewRoomName: "review-room-a-next",
};

const listedAgain = (updatedAt: string) => ({ drafts: [{ ...listed, updatedAt }] });

const relist = (probe: () => ScopeProbe) =>
  act(async () => {
    await probe().queryClient.invalidateQueries({
      queryKey: projectQueryKeys.workDrafts("project-a", "work-a"),
    });
  });

/** A's only change is applied and the server closes the draft: the review holds on No changes left. */
async function reviewClosed(probe: () => ScopeProbe) {
  await vi.waitFor(() => expect(mocks.listWorkDrafts).toHaveBeenCalled());
  await act(async () => probe().editor.controller.enterInlineReview("document-a", "draft-a"));
  await vi.waitFor(() => expect(probe().header.view.status).toBe("ready"));
  mocks.applyDraftChanges.mockImplementation(async () => {
    mocks.listWorkDrafts.mockResolvedValue({ drafts: [] });
    mocks.getDraftPreview.mockResolvedValue(resetPreview);
    return applied(true, "2");
  });
  await act(async () => {
    await probe().editor.controller.applyChanges(draftA, change("2"));
  });
  await vi.waitFor(() => expect(probe().header.finished).toBe(true));
  await vi.waitFor(() => expect(probe().editor.groups).toEqual([]));
}

beforeEach(() => {
  vi.clearAllMocks();
  resetDraftCommandRecords();
  mocks.listWorkDrafts.mockResolvedValue({ drafts: [listed] });
  mocks.getDraftPreview.mockResolvedValue(previewOf("2"));
});

describe("a finished review whose draft is proposed to again", () => {
  it("re-enters in place: completion cleared, the new generation's room and changes shown", async () => {
    await renderReviewScopes(async (probe) => {
      await reviewClosed(probe);
      expect(probe().editor.controller.reviewRoomName).toBe("review-room-a");

      mocks.listWorkDrafts.mockResolvedValue(listedAgain("2026-10-09T05:00:00.000Z"));
      mocks.getDraftPreview.mockResolvedValue(nextProposal);
      await relist(probe);

      await vi.waitFor(() => expect(probe().header.finished).toBe(false));
      await vi.waitFor(() => expect(classIds(probe())).toEqual(["class-5"]));
      expect(probe().editor.controller.inlineReview).toMatchObject({
        documentId: "document-a",
        draftId: "draft-a",
      });
      expect(probe().editor.controller.inlineReview?.completion).toBeUndefined();
      await vi.waitFor(() =>
        expect(probe().editor.controller.reviewRoomName).toBe("review-room-a-next"),
      );
      expect(probe().editor.controller.marksVisible).toBe(true);
    });
  });

  it("stays finished when the draft is listed again but a read after the close lists no change", async () => {
    await renderReviewScopes(async (probe) => {
      await reviewClosed(probe);

      // A list read that began before the close lists the draft under a row the review
      // did not close on; the server, read now, has nothing to review.
      mocks.listWorkDrafts.mockResolvedValue(listedAgain("2026-10-06T23:00:00.000Z"));
      const reads = mocks.getDraftPreview.mock.calls.length;
      await relist(probe);
      await vi.waitFor(() =>
        expect(mocks.getDraftPreview.mock.calls.length).toBeGreaterThan(reads),
      );
      await act(async () => undefined);

      expect(probe().header.finished).toBe(true);
      expect(classIds(probe())).toEqual([]);
      expect(probe().editor.controller.reviewRoomName).toBe("review-room-a");
      expect(probe().editor.controller.inlineReview?.completion).toMatchObject({ phase: "closed" });
    });
  });

  it("is not decided by a preview read that was already in flight when the row changed", async () => {
    await renderReviewScopes(async (probe) => {
      await reviewClosed(probe);

      // A read of the draft that began before the list changed, still out, with the old change.
      let staleRead!: (preview: unknown) => void;
      mocks.getDraftPreview.mockReturnValueOnce(
        new Promise((resolve) => {
          staleRead = resolve;
        }),
      );
      await act(async () => {
        void probe().queryClient.invalidateQueries({
          queryKey: projectQueryKeys.workDraftPreview(
            "project-a",
            "work-a",
            "document-a",
            "draft-a",
          ),
        });
      });
      await vi.waitFor(() => expect(mocks.getDraftPreview).toHaveBeenCalledTimes(3));

      mocks.listWorkDrafts.mockResolvedValue(listedAgain("2026-10-06T23:00:00.000Z"));
      await relist(probe);
      await act(async () => staleRead(previewOf("2")));
      await act(async () => undefined);

      expect(probe().header.finished).toBe(true);
      expect(classIds(probe())).toEqual([]);
      expect(probe().editor.controller.reviewRoomName).toBe("review-room-a");
    });
  });

  it("stays finished while the draft stays out of the list", async () => {
    await renderReviewScopes(async (probe) => {
      await reviewClosed(probe);
      const reads = mocks.getDraftPreview.mock.calls.length;

      await relist(probe);
      await act(async () => undefined);

      expect(mocks.getDraftPreview.mock.calls.length).toBe(reads);
      expect(probe().header.finished).toBe(true);
      expect(probe().editor.controller.inlineReview?.completion).toMatchObject({ phase: "closed" });
    });
  });
});
