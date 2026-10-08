// @vitest-environment jsdom
/**
 * Apply draft and Discard draft move to the next draft while the command runs,
 * but an offline click sends nothing: the writer stays on the draft, which
 * says the command was not sent. Real provider, controller, mutations and
 * query cache; the network is the only fake.
 */
import { onlineManager } from "@tanstack/react-query";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDraftCommandRecords } from "@/client/query/draft-command-record";
import type { ReviewFileTarget } from "@/features/draft-review/review-files";
import { listed, preview, renderReviewScopes } from "@/test-support/draft-review-scope";

const mocks = vi.hoisted(() => ({
  listWorkDrafts: vi.fn(),
  getDraftPreview: vi.fn(),
  applyWorkDraft: vi.fn(),
  discardWorkDraft: vi.fn(),
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

describe("a whole-draft command clicked while offline", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDraftCommandRecords();
    mocks.listWorkDrafts.mockResolvedValue({ drafts: [draftOf("a"), draftOf("b")] });
    mocks.getDraftPreview.mockResolvedValue(preview);
  });
  afterEach(() => onlineManager.setOnline(true));

  it.each([
    "applyDraft",
    "discardDraft",
  ] as const)("%s keeps the writer on the draft and says it was not sent", async (command) => {
    const opened: ReviewFileTarget[] = [];
    await renderReviewScopes(
      async (probe) => {
        await vi.waitFor(() => expect(probe().editor.groups).toHaveLength(2));
        await act(async () => probe().editor.controller.enterInlineReview("document-a", "draft-a"));
        await vi.waitFor(() => expect(probe().header.view.status).toBe("ready"));
        expect(probe().header.next?.documentId).toBe("document-b");
        onlineManager.setOnline(false);
        await act(async () => probe().header[command]());
        await vi.waitFor(() => expect(probe().header.commandError).not.toBeNull());
        expect(opened).toEqual([]);
        expect(mocks.applyWorkDraft).not.toHaveBeenCalled();
        expect(mocks.discardWorkDraft).not.toHaveBeenCalled();
      },
      {
        reviewed: { documentId: "document-a", draftId: "draft-a" },
        onOpenDraft: (row) => opened.push(row),
      },
    );
  });
});
