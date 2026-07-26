/** Focused disposition coverage for the shared draft review controller. */
import { act, useEffect } from "react";
import { describe, expect, it, vi } from "vitest";
import { withReactRoot } from "@/test-support/react-dom-harness";

const resolveDraftOnlyTabMock = vi.fn();
const wholeDraftResponse: unknown = null;
let wholeDraftResponses: unknown[] = [];
let acceptPromise: Promise<{ status: "applied"; draftId: string }> | null = null;
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
const draftPreviews = new Map<string, typeof draftPreview>();
const acceptMutateMock = vi.fn(async (_input: unknown) => {
  if (acceptPromise) return acceptPromise;
  const response =
    wholeDraftResponses.length > 0
      ? wholeDraftResponses.shift()
      : wholeDraftResponse
        ? wholeDraftResponse
        : { status: "applied" as const, draftId: "draft-1" };
  if (response instanceof Error) throw response;
  return response;
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
    Promise.resolve(draftPreviews.get(draftId) ?? draftPreview),
}));
vi.mock("@/client/query/useDraftReviewMutations", () => ({
  useAcceptDraft: () => ({ mutateAsync: acceptMutateMock }),
  useRejectDraft: () => ({ mutateAsync: rejectMutateMock }),
}));
vi.mock("@/client/stores", () => ({
  useContextTabsStore: {
    getState: () => ({ resolveDraftOnlyTab: resolveDraftOnlyTabMock }),
  },
}));

const { useDraftReviewController } = await import("./useDraftReviewController");

describe("useDraftReviewController", () => {
  it("materializes a draft-only tab when per-card Apply commits the branch", async () => {
    let controller: ReturnType<typeof useDraftReviewController> | null = null;
    resolveDraftOnlyTabMock.mockClear();
    acceptMutateMock.mockClear();
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

      expect(acceptMutateMock).toHaveBeenCalledOnce();
      expect(resolveDraftOnlyTabMock).toHaveBeenCalledWith("project-1", "document-1", "committed");
    });
  });

  it("submits branch identity without preview operation evidence", async () => {
    let controller: ReturnType<typeof useDraftReviewController> | null = null;
    acceptMutateMock.mockClear();

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
      await act(async () => {
        await controller?.accept("document-1", "draft-1");
      });

      expect(acceptMutateMock).toHaveBeenCalledWith(
        expect.objectContaining({
          branchId: "branch-1",
        }),
      );
      expect(acceptMutateMock).not.toHaveBeenCalledWith(
        expect.objectContaining({ operationIds: expect.anything() }),
      );
    });
  });

  it("reports reviewed whole-draft failures after preview readiness", async () => {
    let controller: ReturnType<typeof useDraftReviewController> | null = null;
    wholeDraftResponses = [new Error("offline")];

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
      expect(controller?.canAcceptReviewedDraft).toBe(false);

      await act(async () => {
        controller?.inlineReviewModelAvailable(
          "draft-1:0:1",
          "document-1",
          "draft-1",
          ["operation-1", "operation-2"],
          { draftRevisionToken: 1, branchId: "branch-1" },
        );
      });
      expect(controller?.canAcceptReviewedDraft).toBe(true);

      await act(async () => {
        await controller?.accept("document-1", "draft-1");
      });
      expect(controller?.inlineReviewMessage).toMatchObject({
        code: "apply-failed",
        tone: "error",
      });
    });
    wholeDraftResponses = [];
  });

  it("acquires and applies every captured draft in a dock batch", async () => {
    let controller: ReturnType<typeof useDraftReviewController> | null = null;
    acceptMutateMock.mockClear();
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
      expect(acceptMutateMock).toHaveBeenCalledTimes(2);
      expect(acceptMutateMock).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          documentId: "document-2",
          draftId: "draft-2",
        }),
      );
    });
    draftPreviews.clear();
  });

  it("discards a change with no editor mounted, so the Changes rail works off the Editor screen", async () => {
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
      // No registerInlineReviewRuntime: review is open, but the manuscript pane
      // is not mounted — the writer is reviewing from Home or Chat.
      await act(async () => {
        controller?.enterInlineReview("document-1", "draft-1");
      });

      let outcome: unknown;
      await act(async () => {
        outcome = await controller?.discardOperation("operation-1");
      });

      expect(outcome).toEqual({ kind: "discarded" });
      expect(rejectMutateMock).toHaveBeenCalledTimes(1);
    });
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

  it("locks every disposition while a whole-branch Apply is unsettled", async () => {
    let controller: ReturnType<typeof useDraftReviewController> | null = null;
    acceptMutateMock.mockClear();
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

      let resolveAccept!: (response: { status: "applied"; draftId: string }) => void;
      acceptPromise = new Promise((resolve) => {
        resolveAccept = resolve;
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

      expect(acceptMutateMock).toHaveBeenCalledOnce();
      expect(rejectMutateMock).not.toHaveBeenCalled();

      await act(async () => {
        resolveAccept({ status: "applied", draftId: "draft-1" });
        await operationApply;
      });
      acceptPromise = null;
    });
  });
});
