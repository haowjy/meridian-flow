// @vitest-environment jsdom
/**
 * Per-change Discard is fenced like per-change Apply: it sends the preview's
 * revision tokens with its operation ids, and a `stale` answer is a refusal of
 * that change (refreshed, restored, never a closed or discarded draft).
 * Real provider, controller, mutations and query cache; the network is the only fake.
 */

import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetDraftCommandRecords } from "@/client/query/draft-command-record";
import {
  change,
  discarded,
  listed,
  preview,
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

async function reviewOpened(probe: () => ScopeProbe) {
  await vi.waitFor(() => expect(mocks.listWorkDrafts).toHaveBeenCalled());
  await act(async () => probe().editor.controller.enterInlineReview("document-a", "draft-a"));
  await vi.waitFor(() => expect(probe().header.view.status).toBe("ready"));
}

describe("discarding one change", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDraftCommandRecords();
    mocks.listWorkDrafts.mockResolvedValue({ drafts: [listed] });
    mocks.getDraftPreview.mockResolvedValue(preview);
  });

  it("sends the preview's revision tokens with its operation ids", async () => {
    mocks.discardDraft.mockResolvedValue(discarded(false));
    await renderReviewScopes(async (probe) => {
      await reviewOpened(probe);
      await act(async () => {
        await probe().editor.controller.discardChange(change("2"));
      });
      expect(mocks.discardDraft).toHaveBeenCalledWith(
        "project-a",
        "work-a",
        "document-a",
        expect.objectContaining({
          draftId: "draft-a",
          operationIds: ["2"],
          liveRevisionToken: "live-1",
          draftRevisionToken: "draft-1",
        }),
      );
    });
  });

  it("a whole-draft Discard stays unfenced", async () => {
    mocks.discardDraft.mockResolvedValue(discarded(true));
    await renderReviewScopes(async (probe) => {
      await reviewOpened(probe);
      await act(async () => {
        await probe().editor.controller.discard("document-a", "draft-a");
      });
      expect(mocks.discardDraft).toHaveBeenCalledWith("project-a", "work-a", "document-a", {
        draftId: "draft-a",
      });
    });
  });

  it("a stale answer refreshes and brings the change back, as a stale Apply does", async () => {
    mocks.discardDraft.mockResolvedValue({ status: "stale", draftId: "draft-a" });
    await renderReviewScopes(async (probe) => {
      await reviewOpened(probe);
      const reads = mocks.getDraftPreview.mock.calls.length;
      await act(async () => {
        await probe().editor.controller.discardChange(change("2"));
      });
      await vi.waitFor(() =>
        expect(mocks.getDraftPreview.mock.calls.length).toBeGreaterThan(reads),
      );
      expect(classIds(probe())).toEqual(["class-1", "class-2"]);
      expect(
        probe().header.view.items.find((item) => item.change.classId === "class-2")?.failure,
      ).toMatchObject({ code: "stale", mode: "discard" });
      expect(probe().header.finished).toBe(false);
      expect(probe().editor.controller.inlineReview?.completion).toBeUndefined();
    });
  });

  it("a stale last Discard withdraws the pending completion and never closes the draft", async () => {
    mocks.getDraftPreview.mockResolvedValue(previewOf("2"));
    mocks.discardDraft.mockResolvedValue({ status: "stale", draftId: "draft-a" });
    await renderReviewScopes(async (probe) => {
      await reviewOpened(probe);
      await act(async () => {
        await probe().editor.controller.discardChange(change("2"));
      });
      expect(probe().editor.controller.inlineReview?.completion).toBeUndefined();
      expect(probe().header.finished).toBe(false);
      expect(probe().header.completing).toBeNull();
      expect(classIds(probe())).toEqual(["class-2"]);
      expect(probe().editor.controller.inlineReview?.draftId).toBe("draft-a");
      expect(probe().header.view.items[0]?.failure).toMatchObject({ code: "stale" });
    });
  });

  it("a stale answer claiming draftClosed does not close the review", async () => {
    mocks.getDraftPreview.mockResolvedValue(previewOf("2"));
    mocks.discardDraft.mockResolvedValue({
      status: "stale",
      draftId: "draft-a",
      draftClosed: true,
    });
    await renderReviewScopes(async (probe) => {
      await reviewOpened(probe);
      await act(async () => {
        await probe().editor.controller.discardChange(change("2"));
      });
      expect(probe().editor.controller.inlineReview?.completion).toBeUndefined();
    });
  });
});
