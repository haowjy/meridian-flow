/** Focused disposition coverage for the shared draft review controller. */
import { act, useEffect } from "react";
import { describe, expect, it, vi } from "vitest";
import { withReactRoot } from "@/test-support/react-dom-harness";

const resolveDraftOnlyTabMock = vi.fn();
const wholeDraftResponse: unknown = null;
let wholeDraftResponses: unknown[] = [];
let applyPromise: Promise<{ status: "applied"; draftId: string }> | null = null;
const draftPreview = {
  status: "active",
  draftId: "draft-1",
  draftRevisionToken: 1,
  liveRevisionToken: 0,
  reviewRoomName: "branch:branch-1",
  operations: [
    { operationId: "operation-1" },
    { operationId: "operation-2" },
    { operationId: "operation-3" },
  ],
};
const draftPreviews = new Map<string, typeof draftPreview>();
const applyMutateMock = vi.fn(async (_input: unknown) => {
  if (applyPromise) return applyPromise;
  const response =
    wholeDraftResponses.length > 0
      ? wholeDraftResponses.shift()
      : wholeDraftResponse
        ? wholeDraftResponse
        : { status: "applied" as const, draftId: "draft-1" };
  if (response instanceof Error) throw response;
  return response;
});
let discardPromise: Promise<{ status: "discarded" }> | null = null;
const discardMutateMock = vi.fn(
  async () => discardPromise ?? Promise.resolve({ status: "discarded" as const }),
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
vi.mock("@/features/project/context/context-removal-coordinator", () => ({
  contextRemovalCoordinator: {
    applyDraftMetadata: (...args: unknown[]) => resolveDraftOnlyTabMock(...args, "committed"),
    discardDraft: (_projectId: string, reviewWorkId: string, documentId: string) => {
      resolveDraftOnlyTabMock(_projectId, reviewWorkId, documentId, "discarded");
      return Promise.resolve({ kind: "noop" });
    },
  },
}));
vi.mock("@/client/query/useDraftReviewMutations", () => ({
  useApplyDraft: () => ({ mutateAsync: applyMutateMock }),
  useDiscardDraft: () => ({ mutateAsync: discardMutateMock }),
}));
vi.mock("@/client/stores", () => ({
  useContextTabsStore: {
    getState: () => ({ resolveDraftOnlyTab: resolveDraftOnlyTabMock }),
  },
}));

const { useDraftReviewController } = await import("./useDraftReviewController");

describe("useDraftReviewController", () => {
  it("applies by product draft identity without rendered operation cards", async () => {
    let controller: ReturnType<typeof useDraftReviewController> | null = null;
    applyMutateMock.mockClear();
    resolveDraftOnlyTabMock.mockClear();

    function Probe() {
      const value = useDraftReviewController("project-1", "work-1", "thread-1");
      useEffect(() => {
        controller = value;
      }, [value]);
      return null;
    }

    await withReactRoot(<Probe />, async () => {
      await act(async () => {
        await controller?.apply("document-1", "draft-1");
      });

      expect(applyMutateMock).toHaveBeenCalledWith(
        expect.objectContaining({
          draftId: "draft-1",
        }),
      );
      expect(applyMutateMock).not.toHaveBeenCalledWith(
        expect.objectContaining({ operationIds: expect.anything() }),
      );
      expect(resolveDraftOnlyTabMock).toHaveBeenCalledWith(
        "project-1",
        "work-1",
        "document-1",
        "committed",
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
      expect(controller?.canApplyReviewedDraft).toBe(false);

      await act(async () => {
        controller?.inlineReviewModelAvailable("draft-1:0:1", "document-1", "draft-1");
      });
      expect(controller?.canApplyReviewedDraft).toBe(true);

      await act(async () => {
        await controller?.apply("document-1", "draft-1");
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
    applyMutateMock.mockClear();
    draftPreviews.set("draft-1", {
      ...draftPreview,
      operations: [{ operationId: "operation-1a" }, { operationId: "operation-1b" }],
    });
    draftPreviews.set("draft-2", {
      ...draftPreview,
      draftRevisionToken: 2,
      draftId: "draft-2",
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
      expect(applyMutateMock).toHaveBeenCalledTimes(2);
      expect(applyMutateMock).toHaveBeenNthCalledWith(
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
    discardMutateMock.mockClear();

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
      expect(discardMutateMock).toHaveBeenCalledTimes(1);
    });
  });

  it("releases a discard reservation when preview settlement arrives before mutation completion", async () => {
    let controller: ReturnType<typeof useDraftReviewController> | null = null;
    discardMutateMock.mockClear();

    function Probe() {
      const value = useDraftReviewController("project-1", "work-1", "thread-1");
      useEffect(() => {
        controller = value;
      }, [value]);
      return null;
    }

    await withReactRoot(<Probe />, async () => {
      let resolveDiscard!: (result: { status: "discarded" }) => void;
      discardPromise = new Promise((resolve) => {
        resolveDiscard = resolve;
      });
      await act(async () => {
        controller?.enterInlineReview("document-1", "draft-1");
        controller?.inlineReviewModelAvailable("draft-1:0:1", "document-1", "draft-1");
        controller?.registerInlineReviewRuntime({
          editor: {},
          documentId: "document-1",
          draftId: "draft-1",
        } as never);
      });

      let discard: Promise<unknown> | undefined;
      await act(async () => {
        discard = controller?.discardOperation("operation-1");
        await vi.waitFor(() => expect(discardMutateMock).toHaveBeenCalledTimes(1));
      });
      await act(async () => {
        controller?.inlineReviewModelAvailable("draft-1:0:2", "document-1", "draft-1");
      });
      await act(async () => {
        resolveDiscard({ status: "discarded" });
        await discard;
      });
      discardPromise = null;

      await act(async () => {
        await controller?.discard("document-2", "draft-2");
      });
      expect(discardMutateMock).toHaveBeenCalledTimes(2);
      expect(resolveDraftOnlyTabMock).toHaveBeenCalledWith(
        "project-1",
        "work-1",
        "document-2",
        "discarded",
      );
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
    applyMutateMock.mockClear();
    discardMutateMock.mockClear();

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
        controller?.inlineReviewModelAvailable("draft-1:0:1", "document-1", "draft-1");
      });

      let resolveApply!: (response: { status: "applied"; draftId: string }) => void;
      applyPromise = new Promise((resolve) => {
        resolveApply = resolve;
      });
      const activeController = controller;
      if (!activeController) throw new Error("controller did not mount");
      let wholeApply!: ReturnType<typeof activeController.apply>;
      await act(async () => {
        wholeApply = activeController.apply("document-1", "draft-1");
        await Promise.resolve();
        await activeController.apply("document-1", "draft-1");
        await activeController.discardOperation("operation-2");
        await activeController.discard("document-2", "draft-2");
      });

      expect(applyMutateMock).toHaveBeenCalledOnce();
      expect(discardMutateMock).not.toHaveBeenCalled();

      await act(async () => {
        resolveApply({ status: "applied", draftId: "draft-1" });
        await wholeApply;
      });
      applyPromise = null;
    });
  });
});
