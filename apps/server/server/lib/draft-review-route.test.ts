/** Route-level coverage for work draft list serialization and project-scoped derivation. */
import { describe, expect, it, vi } from "vitest";
import { handleWorkDraftAcceptRequest, handleWorkDraftListRequest } from "./draft-review-route.js";

const PROJECT_ID = "00000000-0000-4000-8000-000000000101";
const WORK_ID = "00000000-0000-4000-8000-000000000102";
const USER_ID = "00000000-0000-4000-8000-000000000103";

describe("handleWorkDraftListRequest", () => {
  it("emits isNewDocument only for drafts derived from draft-only manifest membership", async () => {
    const list = vi
      .fn()
      .mockResolvedValue([draft("new-document", true), draft("existing-document", false)]);
    const response = await handleWorkDraftListRequest(
      {
        projects: {
          findById: async () => ({ userId: USER_ID, deletedAt: null }) as never,
        },
        works: {
          findById: async () => ({ projectId: PROJECT_ID }) as never,
        },
        documentAccess: {
          canAccessDocument: async () => true,
          canAccessProjectDocument: async () => true,
        },
        documentSync: { draftReview: { list } as never },
      },
      {
        projectId: PROJECT_ID as never,
        workId: WORK_ID as never,
        userId: USER_ID as never,
      },
    );

    expect(list).toHaveBeenCalledWith({ projectId: PROJECT_ID, workId: WORK_ID });
    expect(response.drafts[0]).toMatchObject({ draftId: "new-document", isNewDocument: true });
    expect(response.drafts[1]).not.toHaveProperty("isNewDocument");
  });
});

describe("handleWorkDraftAcceptRequest", () => {
  it("preserves concurrent push conflicts for the review client", async () => {
    const response = await handleWorkDraftAcceptRequest(
      {
        projects: { findById: async () => ({ userId: USER_ID, deletedAt: null }) as never },
        works: { findById: async () => ({ projectId: PROJECT_ID }) as never },
        documentAccess: {
          canAccessDocument: async () => true,
          canAccessProjectDocument: async () => true,
        },
        documentSync: {
          draftReview: {
            accept: async () => ({
              status: "concurrent_conflict",
              reason: "draft_base_divergence",
              conflictedBlocks: ["block-a"],
              conflicts: [],
            }),
          } as never,
        },
      },
      {
        projectId: PROJECT_ID as never,
        workId: WORK_ID as never,
        documentId: "document-1" as never,
        branchId: "branch-1",
        userId: USER_ID as never,
        draftRevisionToken: 1,
      },
    );

    expect(response).toEqual({
      status: "concurrent_conflict",
      reason: "draft_base_divergence",
      conflictedBlocks: ["block-a"],
      conflicts: [],
    });
  });
});

function draft(id: string, createdDocument: boolean) {
  return {
    id,
    documentId: `document-${id}`,
    documentName: id,
    contextPath: `/${id}.md`,
    status: "active" as const,
    lastActorTurnId: null,
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    appliedAt: null,
    discardedAt: null,
    wordsAdded: 1,
    wordsRemoved: 0,
    createdDocument,
  };
}
