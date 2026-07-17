/** Focused disposition coverage for the shared draft review controller. */
import { act, useEffect } from "react";
import { describe, expect, it, vi } from "vitest";
import { withReactRoot } from "@/test-support/react-dom-harness";

const resolveDraftOnlyTabMock = vi.fn();
const operationAcceptMutateMock = vi.fn(
  (_input: unknown, options: { onSuccess: (response: unknown) => void }) => {
    options.onSuccess({ status: "partial_applied", writeId: "write-1" });
  },
);
const wholeDraftAcceptMutateMock = vi.fn();
const acceptMutateMock = vi.fn(
  (
    input: { operationIds?: readonly string[] },
    options: { onSuccess: (response: unknown) => void },
  ) => {
    if (input.operationIds?.length === 1) {
      operationAcceptMutateMock(input, options);
      return;
    }
    wholeDraftAcceptMutateMock(input, options);
  },
);

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({
    invalidateQueries: vi.fn(),
    setQueryData: vi.fn(),
  }),
}));
vi.mock("@/client/api/drafts-api", () => ({
  getDraftPreview: async () => ({
    status: "active",
    draftRevisionToken: 1,
    liveRevisionToken: 0,
    branchId: "branch-1",
    reviewRoomName: "branch:branch-1",
    operations: [{ operationId: "operation-1" }, { operationId: "operation-2" }],
  }),
}));
vi.mock("@/client/query/useDraftReviewMutations", () => ({
  useAcceptDraft: () => ({ isPending: false, mutate: acceptMutateMock }),
  useUndoDraftAccept: () => ({ isPending: false, mutate: vi.fn() }),
  useRejectDraft: () => ({ isPending: false, mutate: vi.fn(), mutateAsync: vi.fn() }),
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

  it("submits every operation from the confirmed preview when applying all", async () => {
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
        await controller?.accept("document-1", "draft-1");
      });

      expect(wholeDraftAcceptMutateMock).toHaveBeenCalledWith(
        expect.objectContaining({ operationIds: ["operation-1", "operation-2"] }),
        expect.any(Object),
      );
    });
  });
});
