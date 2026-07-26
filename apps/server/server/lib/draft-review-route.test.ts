/** Route-core coverage for Work-draft preview identity. */

import { describe, expect, it, vi } from "vitest";
import { handleWorkDraftPreviewRequest } from "./draft-review-route.js";

describe("Work-draft preview route", () => {
  it("preserves draft identity when the draft is already gone", async () => {
    const draftId = "branch_test-draft";
    const preview = vi.fn(async () => ({ status: "gone" as const, draftId, live: "Live text" }));
    const dependencies = {
      projects: {
        findById: vi.fn(async () => ({ userId: "user-1", deletedAt: null })),
      },
      works: {
        findById: vi.fn(async () => ({ projectId: "project-1" })),
      },
      documentAccess: {
        canAccessDocument: vi.fn(async () => true),
        canAccessProjectDocument: vi.fn(async () => true),
      },
      documentSync: { draftReview: { preview } },
    };

    await expect(
      handleWorkDraftPreviewRequest(
        dependencies as never,
        {
          projectId: "project-1",
          workId: "work-1",
          documentId: "document-1",
          draftId,
          userId: "user-1",
        } as never,
      ),
    ).resolves.toEqual({ status: "gone", draftId, live: "Live text" });
  });
});
