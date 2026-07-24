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
let wholeDraftResponses: unknown[] = [];
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
const draftPreviews = new Map<string, typeof draftPreview>();
const wholeDraftAcceptMutateMock = vi.fn(async (_input: unknown) => {
  const response =
    wholeDraftResponses.length > 0
      ? wholeDraftResponses.shift()
      : wholeDraftResponse
        ? wholeDraftResponse
        : { status: "applied" as const, draftId: "draft-1" };
  if (response instanceof Error) throw response;
  return response;
});
const acceptMutateMock = vi.fn((input: { operationIds?: readonly string[] }) => {
  if (input.operationIds?.length === 1) {
    return operationAcceptMutateMock(input);
  }
  return wholeDraftAcceptMutateMock(input);
});
let rejectPromise: Promise<{ status: "discarded" }> | null = null;
const rejectMutateMock = vi.fn(
  async () => rejectPromise ?? Promise.resolve({ status: "discarded" as const }),
);

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({
    invalidateQueries: vi.fn(),
    setQueryData: vi.fn(),
  }),
}));
vi.mock("@/client/api/drafts-api", () => ({
  getDraftPreview: (_projectId: string, _workId: string, _documentId: string, draftId: string) =>
    draftPreviewPromise ?? Promise.resolve(draftPreviews.get(draftId) ?? draftPreview),
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

  it("acquires and applies every captured draft in a dock batch", async () => {
    let controller: ReturnType<typeof useDraftReviewController> | null = null;
    acceptMutateMock.mockClear();
    wholeDraftAcceptMutateMock.mockClear();
    draftPreviews.set("draft-1", {
      ...draftPreview,
      operations: [{ operationId: "operation-1a" }, { operationId: "operation-1b" }],
    });
    draftPreviews.set("draft-2", {
      ...draftPreview,
      draftRevisionToken: 2,
      branchId: "branch-2",
      operations: [{ operationId: "operation-2a" }, { operationId: "operation-2b" }],
    });

    function Probe() {
      const value = useDraftReviewController("project-1", "work-1", "thread-1");
      useEffect(() => {
        controller = value;
      }, [value]);
      return null;
    }

    await withReactRoot(<Probe />, async () => {
      let outcomes: Awaited<ReturnType<NonNullable<typeof controller>["disposeDrafts"]>> = [];
      await act(async () => {
        outcomes =
          (await controller?.disposeDrafts("apply", [
            { documentId: "document-1", draftId: "draft-1" },
            { documentId: "document-2", draftId: "draft-2" },
          ])) ?? [];
      });

      expect(outcomes).toEqual([{ kind: "applied" }, { kind: "applied" }]);
      expect(wholeDraftAcceptMutateMock).toHaveBeenCalledTimes(2);
      expect(wholeDraftAcceptMutateMock).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          documentId: "document-2",
          draftId: "draft-2",
          branchId: "branch-2",
          draftRevisionToken: 2,
          operationIds: ["operation-2a", "operation-2b"],
        }),
      );
    });
    draftPreviews.clear();
  });

  it("releases a discard reservation when preview settlement arrives before mutation completion", async () => {
    let controller: ReturnType<typeof useDraftReviewController> | null = null;
    rejectMutateMock.mockClear();

    function Probe() {
      const value = useDraftReviewController("project-1", "work-1", "thread-1");
      useEffect(() => {
        controller = value;
      }, [value]);
      return null;
    }

    await withReactRoot(<Probe />, async () => {
      let resolveReject!: (result: { status: "discarded" }) => void;
      rejectPromise = new Promise((resolve) => {
        resolveReject = resolve;
      });
      await act(async () => {
        controller?.enterInlineReview("document-1", "draft-1");
        controller?.inlineReviewModelAvailable(
          "draft-1:0:1",
          "document-1",
          "draft-1",
          ["operation-1"],
          { draftRevisionToken: 1, branchId: "branch-1" },
        );
        controller?.registerInlineReviewRuntime({
          editor: {},
          draftDoc: {},
          projectId: "project-1",
          workId: "work-1",
          documentId: "document-1",
          draftId: "draft-1",
        } as never);
      });

      let discard: Promise<unknown> | undefined;
      await act(async () => {
        discard = controller?.discardOperation("operation-1");
        await vi.waitFor(() => expect(rejectMutateMock).toHaveBeenCalledTimes(1));
      });
      await act(async () => {
        controller?.inlineReviewModelAvailable("draft-1:0:2", "document-1", "draft-1", [], {
          draftRevisionToken: 2,
          branchId: "branch-1",
        });
      });
      await act(async () => {
        resolveReject({ status: "discarded" });
        await discard;
      });
      rejectPromise = null;

      await act(async () => {
        await controller?.reject("document-2", "draft-2");
      });
      expect(rejectMutateMock).toHaveBeenCalledTimes(2);
    });
  });

  it("keeps the existing Undo receipt when an overlapping per-card Apply is blocked", async () => {
    let controller: ReturnType<typeof useDraftReviewController> | null = null;
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
        controller?.registerInlineReviewRuntime({
          editor: {},
          draftDoc: {},
          projectId: "project-1",
          workId: "work-1",
          documentId: "document-1",
          draftId: "draft-1",
        } as never);
      });
      await act(async () => {
        await controller?.acceptOperation("operation-1", {
          operations: [{ operationId: "operation-1" }],
        } as never);
      });
      expect(controller?.inlineReviewMessage).toMatchObject({
        code: "change-applied",
        writeId: "write-1",
      });

      let resolveReject!: (result: { status: "discarded" }) => void;
      rejectPromise = new Promise((resolve) => {
        resolveReject = resolve;
      });
      let discard: Promise<unknown> | undefined;
      await act(async () => {
        discard = controller?.discardOperation("operation-2");
        await vi.waitFor(() => expect(rejectMutateMock).toHaveBeenCalledOnce());
      });
      await act(async () => {
        await controller?.acceptOperation("operation-1", {
          operations: [{ operationId: "operation-1" }],
        } as never);
      });
      expect(controller?.inlineReviewMessage).toMatchObject({
        code: "change-applied",
        writeId: "write-1",
      });

      await act(async () => {
        resolveReject({ status: "discarded" });
        await discard;
      });
      rejectPromise = null;
    });
  });

  it("stops a mixed Apply batch at its first refusal and preserves the explanation", async () => {
    let controller: ReturnType<typeof useDraftReviewController> | null = null;
    wholeDraftAcceptMutateMock.mockClear();
    draftPreviews.set("draft-1", {
      ...draftPreview,
      operations: [{ operationId: "operation-1a" }, { operationId: "operation-1b" }],
    });
    draftPreviews.set("draft-2", {
      ...draftPreview,
      operations: [{ operationId: "operation-2a" }, { operationId: "operation-2b" }],
    });
    wholeDraftResponses = [
      {
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
      },
      { status: "applied", draftId: "draft-2" },
    ];

    function Probe() {
      const value = useDraftReviewController("project-1", "work-1", "thread-1");
      useEffect(() => {
        controller = value;
      }, [value]);
      return null;
    }

    await withReactRoot(<Probe />, async () => {
      await act(async () => {
        await controller?.disposeDrafts("apply", [
          { documentId: "document-1", draftId: "draft-1" },
          { documentId: "document-2", draftId: "draft-2" },
        ]);
      });

      expect(wholeDraftAcceptMutateMock).toHaveBeenCalledTimes(1);
      expect(controller?.applyRefusal).toMatchObject({ reason: "unsynced_live_edits" });
    });
    wholeDraftResponses = [];
    draftPreviews.clear();
  });

  it("publishes a typed dock error when a batch mutation fails", async () => {
    let controller: ReturnType<typeof useDraftReviewController> | null = null;
    wholeDraftResponses = [new Error("offline")];
    draftPreviews.set("draft-1", {
      ...draftPreview,
      operations: [{ operationId: "operation-1a" }, { operationId: "operation-1b" }],
    });

    function Probe() {
      const value = useDraftReviewController("project-1", "work-1", "thread-1");
      useEffect(() => {
        controller = value;
      }, [value]);
      return null;
    }

    await withReactRoot(<Probe />, async () => {
      await act(async () => {
        await controller?.disposeDrafts("apply", [
          { documentId: "document-1", draftId: "draft-1" },
        ]);
      });
      expect(controller?.dockDispositionError).toBe("apply-failed");
    });
    wholeDraftResponses = [];
    draftPreviews.clear();
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
