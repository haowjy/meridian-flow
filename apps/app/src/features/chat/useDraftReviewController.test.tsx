/** Focused disposition coverage for the shared draft review controller. */
import { act, useEffect } from "react";
import { describe, expect, it, vi } from "vitest";
import { withReactRoot } from "@/test-support/react-dom-harness";

const resolveDraftOnlyTabMock = vi.fn();
const operationAcceptMutateMock = vi.fn(async (_input: unknown) => ({
  status: "partial_applied" as const,
  draftId: "draft-1",
  writeId: "write-1",
}));
let wholeDraftResponse: unknown = null;
const draftPreview = {
  status: "active",
  draftRevisionToken: 1,
  liveRevisionToken: 0,
  branchId: "branch-1",
  reviewRoomName: "branch:branch-1",
  operations: [
    { operationId: "operation-1" },
    { operationId: "operation-2" },
    { operationId: "operation-3" },
  ],
};
let draftPreviewPromise: Promise<typeof draftPreview> | null = null;
const wholeDraftAcceptMutateMock = vi.fn(async (_input: unknown) =>
  wholeDraftResponse ? wholeDraftResponse : { status: "applied" as const, draftId: "draft-1" },
);
const acceptMutateMock = vi.fn((input: { operationIds?: readonly string[] }) => {
  if (input.operationIds?.length === 1) {
    return operationAcceptMutateMock(input);
  }
  return wholeDraftAcceptMutateMock(input);
});
const rejectMutateMock = vi.fn(async () => ({ status: "discarded" as const }));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({
    invalidateQueries: vi.fn(),
    setQueryData: vi.fn(),
  }),
}));
vi.mock("@/client/api/drafts-api", () => ({
  getDraftPreview: () => draftPreviewPromise ?? Promise.resolve(draftPreview),
}));
vi.mock("@/client/query/useDraftReviewMutations", () => ({
  useAcceptDraft: () => ({ mutateAsync: acceptMutateMock }),
  useUndoDraftAccept: () => ({ mutateAsync: vi.fn() }),
  useRejectDraft: () => ({ mutateAsync: rejectMutateMock }),
}));
vi.mock("@/client/stores", () => ({
  useContextTabsStore: {
    getState: () => ({ resolveDraftOnlyTab: resolveDraftOnlyTabMock }),
  },
}));

const { useDraftReviewController } = await import("./useDraftReviewController");

describe("useDraftReviewController", () => {
  it("materializes a draft-only tab on the first partial apply", async () => {
    let controller: ReturnType<typeof useDraftReviewController> | null = null;
    resolveDraftOnlyTabMock.mockClear();
    acceptMutateMock.mockClear();
    operationAcceptMutateMock.mockClear();
    wholeDraftAcceptMutateMock.mockClear();
    rejectMutateMock.mockClear();

    function Probe() {
      const value = useDraftReviewController("project-1", "work-1", "thread-1");
      useEffect(() => {
        controller = value;
      }, [value]);
      return null;
    }

    await withReactRoot(<Probe />, async () => {
      await act(async () => {
        controller?.enterInlineReview("document-1", "draft-1");
      });
      await act(async () => {
        await controller?.acceptOperation("operation-1", {
          operations: [{ operationId: "operation-1" }],
        } as never);
      });

      expect(operationAcceptMutateMock).toHaveBeenCalledOnce();
      expect(wholeDraftAcceptMutateMock).not.toHaveBeenCalled();
      expect(resolveDraftOnlyTabMock).toHaveBeenCalledWith("project-1", "document-1", "committed");
    });
  });

  it("submits only the operations from the displayed preview when applying all", async () => {
    let controller: ReturnType<typeof useDraftReviewController> | null = null;
    acceptMutateMock.mockClear();
    wholeDraftAcceptMutateMock.mockClear();

    function Probe() {
      const value = useDraftReviewController("project-1", "work-1", "thread-1");
      useEffect(() => {
        controller = value;
      }, [value]);
      return null;
    }

    await withReactRoot(<Probe />, async () => {
      await act(async () => {
        controller?.inlineReviewModelAvailable(
          "draft-1:0:1",
          "document-1",
          "draft-1",
          ["operation-1", "operation-2"],
          { draftRevisionToken: 1, branchId: "branch-1" },
        );
      });
      // A second operation may arrive after the render above. Apply-all must
      // remain pinned to the model the writer reviewed rather than refetching it.
      await act(async () => {
        await controller?.accept("document-1", "draft-1");
      });

      expect(wholeDraftAcceptMutateMock).toHaveBeenCalledWith(
        expect.objectContaining({
          branchId: "branch-1",
          draftRevisionToken: 1,
          operationIds: ["operation-1", "operation-2"],
        }),
      );
    });
  });

  it("locks every Apply before per-card revision acquisition settles", async () => {
    let controller: ReturnType<typeof useDraftReviewController> | null = null;
    acceptMutateMock.mockClear();
    operationAcceptMutateMock.mockClear();
    wholeDraftAcceptMutateMock.mockClear();
    rejectMutateMock.mockClear();

    function Probe() {
      const value = useDraftReviewController("project-1", "work-1", "thread-1");
      useEffect(() => {
        controller = value;
      }, [value]);
      return null;
    }

    await withReactRoot(<Probe />, async () => {
      await act(async () => {
        controller?.enterInlineReview("document-1", "draft-1");
        controller?.inlineReviewModelAvailable(
          "draft-1:0:1",
          "document-1",
          "draft-1",
          ["operation-1", "operation-2"],
          { draftRevisionToken: 1, branchId: "branch-1" },
        );
      });

      let resolvePreview!: (preview: typeof draftPreview) => void;
      draftPreviewPromise = new Promise((resolve) => {
        resolvePreview = resolve;
      });
      const activeController = controller;
      if (!activeController) throw new Error("controller did not mount");
      let operationApply!: ReturnType<typeof activeController.acceptOperation>;
      await act(async () => {
        operationApply = activeController.acceptOperation("operation-1", {
          operations: [{ operationId: "operation-1" }],
        } as never);
        await Promise.resolve();
        await activeController.acceptOperation("operation-2", {
          operations: [{ operationId: "operation-2" }],
        } as never);
        await activeController.accept("document-1", "draft-1");
        await activeController.reject("document-2", "draft-2");
      });

      expect(wholeDraftAcceptMutateMock).not.toHaveBeenCalled();
      expect(rejectMutateMock).not.toHaveBeenCalled();

      await act(async () => {
        resolvePreview(draftPreview);
        await operationApply;
      });
      expect(operationAcceptMutateMock).toHaveBeenCalledOnce();
      draftPreviewPromise = null;
    });
  });

  it("clears a prior Apply refusal when a re-reviewed per-card Apply succeeds", async () => {
    let controller: ReturnType<typeof useDraftReviewController> | null = null;
    wholeDraftResponse = {
      status: "concurrent_conflict",
      reason: "draft_base_divergence",
      conflictedBlocks: ["block-1"],
      conflicts: [
        {
          blockId: "block-1",
          journalIds: [1],
          draftBaseUpdateSeq: 1,
          effect: "deletion",
          evidence: "human_live_update",
          captured: { base: "block-1|Old.", live: "block-1|Writer text.", proposed: null },
          why: "Apply would remove writer text.",
        },
      ],
    };

    function Probe() {
      const value = useDraftReviewController("project-1", "work-1", "thread-1");
      useEffect(() => {
        controller = value;
      }, [value]);
      return null;
    }

    await withReactRoot(<Probe />, async () => {
      await act(async () => {
        controller?.enterInlineReview("document-1", "draft-1");
        controller?.inlineReviewModelAvailable(
          "draft-1:0:1",
          "document-1",
          "draft-1",
          ["operation-1", "operation-2"],
          { draftRevisionToken: 1, branchId: "branch-1" },
        );
      });
      await act(async () => {
        await controller?.accept("document-1", "draft-1");
      });
      expect(controller?.applyRefusal).toMatchObject({ reason: "unsynced_live_edits" });

      await act(async () => {
        controller?.inlineReviewModelAvailable(
          "draft-1:0:2",
          "document-1",
          "draft-1",
          ["operation-1"],
          { draftRevisionToken: 2, branchId: "branch-1" },
        );
        await controller?.acceptOperation("operation-1", {
          operations: [{ operationId: "operation-1" }],
        } as never);
      });
      expect(controller?.applyRefusal).toBeNull();
    });
    wholeDraftResponse = null;
  });
});
