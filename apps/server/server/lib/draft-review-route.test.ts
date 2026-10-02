/** Route-core checks for draft disposition catalog reconciliation. */
import { describe, expect, it, vi } from "vitest";
import { createInMemoryEventSink } from "../domains/observability/index.js";
import {
  handleApplyWorkDraftRequest,
  handleDiscardWorkDraftRequest,
  scheduleDraftCatalogRefresh,
} from "./draft-review-route.js";

const input = {
  projectId: "00000000-0000-4000-8000-000000000001",
  workId: "00000000-0000-4000-8000-000000000002",
  documentId: "00000000-0000-4000-8000-000000000003",
  draftId: "draft-1",
  userId: "00000000-0000-4000-8000-000000000004",
} as const;

function dependencies() {
  const applyWorkDraft = vi.fn(async () => ({
    status: "applied" as const,
    draftId: input.draftId,
  }));
  const discardWorkDraft = vi.fn(async () => ({
    status: "discarded" as const,
    draftId: input.draftId,
  }));
  return {
    deps: {
      projects: {
        findById: async () => ({ userId: input.userId, deletedAt: null }),
      },
      works: {
        findById: async () => ({ projectId: input.projectId }),
      },
      documentAccess: {
        canAccessDocument: async () => true,
        canAccessProjectDocument: async () => true,
      },
      documentSync: { draftReview: { applyWorkDraft, discardWorkDraft } },
    },
  };
}

describe("draft review route catalog reconciliation", () => {
  it("returns a committed Apply without waiting for catalog reconciliation", async () => {
    const { deps } = dependencies();

    await expect(handleApplyWorkDraftRequest(deps as never, input as never)).resolves.toMatchObject(
      {
        status: "applied",
      },
    );
  });

  it("returns a committed Discard without waiting for catalog reconciliation", async () => {
    const { deps } = dependencies();

    await expect(
      handleDiscardWorkDraftRequest(deps as never, input as never),
    ).resolves.toMatchObject({ status: "discarded" });
  });

  it("schedules the narrow project refresh and logs failure without rejecting", async () => {
    const refreshProjectDocuments = vi.fn(async () => {
      throw new Error("catalog unavailable");
    });
    const eventSink = createInMemoryEventSink();
    let task: (() => Promise<void>) | undefined;

    scheduleDraftCatalogRefresh(
      { contextCatalogRefresh: { refreshProjectDocuments }, eventSink } as never,
      input.projectId as never,
      (scheduled) => {
        task = scheduled;
      },
    );

    expect(refreshProjectDocuments).not.toHaveBeenCalled();
    await expect(task?.()).resolves.toBeUndefined();
    expect(refreshProjectDocuments).toHaveBeenCalledWith(input.projectId);
    expect(eventSink.events).toEqual([
      expect.objectContaining({
        level: "error",
        source: "draft-review",
        name: "CatalogRefreshFailure",
        payload: expect.objectContaining({ projectId: input.projectId }),
      }),
    ]);
  });
});
