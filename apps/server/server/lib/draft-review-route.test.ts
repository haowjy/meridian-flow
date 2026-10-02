/** Route-core checks for draft disposition catalog reconciliation. */
import { describe, expect, it, vi } from "vitest";
import {
  handleApplyWorkDraftRequest,
  handleDiscardWorkDraftRequest,
} from "./draft-review-route.js";

const input = {
  projectId: "00000000-0000-4000-8000-000000000001",
  workId: "00000000-0000-4000-8000-000000000002",
  documentId: "00000000-0000-4000-8000-000000000003",
  draftId: "draft-1",
  userId: "00000000-0000-4000-8000-000000000004",
} as const;

function dependencies() {
  const refreshProject = vi.fn(async () => {});
  const applyWorkDraft = vi.fn(async () => ({
    status: "applied" as const,
    draftId: input.draftId,
  }));
  const discardWorkDraft = vi.fn(async () => ({
    status: "discarded" as const,
    draftId: input.draftId,
  }));
  return {
    refreshProject,
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
      catalog: { refreshProject },
    },
  };
}

describe("draft review route catalog reconciliation", () => {
  it("refreshes the project catalog after Apply publishes live membership", async () => {
    const { deps, refreshProject } = dependencies();

    await expect(handleApplyWorkDraftRequest(deps as never, input as never)).resolves.toMatchObject(
      {
        status: "applied",
      },
    );

    expect(refreshProject).toHaveBeenCalledWith(input.projectId);
  });

  it("refreshes the project catalog after Discard removes draft membership", async () => {
    const { deps, refreshProject } = dependencies();

    await expect(
      handleDiscardWorkDraftRequest(deps as never, input as never),
    ).resolves.toMatchObject({ status: "discarded" });

    expect(refreshProject).toHaveBeenCalledWith(input.projectId);
  });
});
