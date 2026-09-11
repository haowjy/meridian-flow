/** Route-core coverage for Work-draft preview identity. */

import { describe, expect, it, vi } from "vitest";
import { WorkLifecycleUnavailableError } from "../domains/projects/domain/work-lifecycle.js";
import {
  handleApplyWorkDraftRequest,
  handleWorkDraftPreviewRequest,
} from "./draft-review-route.js";

describe("Work-draft preview route", () => {
  it("includes the generation-fenced review room in an active response", async () => {
    const reviewRoomName = "branch:branch-1:gen:2";
    const preview = vi.fn(async () => ({
      status: "active" as const,
      draftId: "branch_test-draft",
      reviewRoomName,
      live: "Live text",
      markdown: "Draft text",
      liveRevisionToken: 1,
      draftRevisionToken: 2,
      operations: [],
      hunks: [],
    }));
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

    const response = await handleWorkDraftPreviewRequest(
      dependencies as never,
      {
        projectId: "project-1",
        workId: "work-1",
        documentId: "document-1",
        draftId: "branch_test-draft",
        userId: "user-1",
      } as never,
    );

    expect(response).toMatchObject({ status: "active", reviewRoomName });
  });

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

it.each([
  "archived",
  "deleted",
  "missing",
] as const)("returns typed unavailability when Apply loses Work authority: %s", async (state) => {
  const dependencies = {
    projects: { findById: async () => ({ userId: "user", deletedAt: null }) },
    works: { findById: async () => ({ projectId: "project" }) },
    documentAccess: {
      canAccessDocument: async () => true,
      canAccessProjectDocument: async () => true,
    },
    documentSync: {
      draftReview: {
        applyWorkDraft: async () => {
          throw new WorkLifecycleUnavailableError("work", state);
        },
      },
    },
  };
  await expect(
    handleApplyWorkDraftRequest(
      dependencies as never,
      {
        projectId: "project",
        workId: "work",
        documentId: "document",
        draftId: "draft",
        userId: "user",
      } as never,
    ),
  ).rejects.toMatchObject({ statusCode: 404, message: "Draft not found" });
});
