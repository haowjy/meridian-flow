// @vitest-environment jsdom
/**
 * The draft the writer is about to be moved to (Apply draft, Discard draft,
 * Next draft) is read while they are still in this one, through the shared
 * preview query. Real provider, controller, mutations and query cache; the
 * network is the only fake.
 */
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetDraftCommandRecords } from "@/client/query/draft-command-record";
import { listed, preview, renderReviewScopes } from "@/test-support/draft-review-scope";

const mocks = vi.hoisted(() => ({
  listWorkDrafts: vi.fn(),
  getDraftPreview: vi.fn(),
}));
vi.mock("@/client/api/drafts-api", () => mocks);
vi.mock("@/client/query/useContextCatalog", () => ({
  contextCatalogScope: () => ({ kind: "project", projectId: "project-a" }),
  useContextCatalogView: () => ({ catalog: null }),
  projectCatalogView: () => ({ findDocument: () => null }),
}));
vi.mock("@/features/project/context/account-feature-context", () => ({
  useContextRemovalCoordinator: () => ({ promoteAppliedDraft: vi.fn(), discardDraft: vi.fn() }),
  useOptionalAccountResourceReplica: () => null,
  useLiveDocumentSessionRegistry: () => ({
    retainBranchRooms: vi.fn(),
    releaseBranchRooms: vi.fn(),
    getBranchRoom: () => ({ document: { on: vi.fn(), off: vi.fn() } }),
  }),
}));

const draftOf = (name: string) => ({
  ...listed,
  documentId: `document-${name}`,
  draftId: `draft-${name}`,
  documentName: `Chapter ${name}`,
});

describe("the next draft's preview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDraftCommandRecords();
    mocks.listWorkDrafts.mockResolvedValue({ drafts: [draftOf("a"), draftOf("b"), draftOf("c")] });
    mocks.getDraftPreview.mockResolvedValue(preview);
  });

  it("is read once this review's own preview is in, and only that draft's", async () => {
    await renderReviewScopes(
      async (probe) => {
        await vi.waitFor(() => expect(probe().header.switcher.rows).toHaveLength(3));
        await act(async () => probe().editor.controller.enterInlineReview("document-a", "draft-a"));
        await vi.waitFor(() => expect(probe().header.view.status).toBe("ready"));
        await vi.waitFor(() => {
          const read = mocks.getDraftPreview.mock.calls.map((call) => call[3]);
          expect(read).toContain("draft-b");
        });
        // The third draft is not the next one: it is read only when the switcher opens.
        expect(mocks.getDraftPreview.mock.calls.map((call) => call[3])).not.toContain("draft-c");
      },
      { reviewed: { documentId: "document-a", draftId: "draft-a" } },
    );
  });
});
