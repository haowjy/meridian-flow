// @vitest-environment jsdom
/**
 * The last change handled: what every surface says is the command's own answer,
 * never the optimistic projection's change count. Pending until the server
 * answers, closed when it says it closed the draft, carrying on when it did not.
 * Real provider, controller, mutations and query cache; the network is the only fake.
 */

import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetDraftCommandRecords } from "@/client/query/draft-command-record";
import {
  change,
  draftA,
  listed,
  preview,
  previewOf,
  renderReviewScopes,
  type ScopeProbe,
} from "@/test-support/draft-review-scope";

const mocks = vi.hoisted(() => ({
  listWorkDrafts: vi.fn(),
  getDraftPreview: vi.fn(),
  applyDraftChanges: vi.fn(),
  discardDraft: vi.fn(),
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

const classIds = (probe: ScopeProbe) => probe.header.view.items.map((item) => item.change.classId);

async function reviewOpened(probe: () => ScopeProbe) {
  await vi.waitFor(() => expect(mocks.listWorkDrafts).toHaveBeenCalled());
  await act(async () => probe().editor.controller.enterInlineReview("document-a", "draft-a"));
  await vi.waitFor(() => expect(probe().header.view.status).toBe("ready"));
}

describe("the last change's command in flight", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDraftCommandRecords();
    mocks.listWorkDrafts.mockResolvedValue({ drafts: [listed] });
    mocks.getDraftPreview.mockResolvedValue(previewOf("2"));
  });

  it("does not predict a completion while another change is left", async () => {
    mocks.getDraftPreview.mockResolvedValue(preview);
    mocks.discardDraft.mockReturnValue(new Promise(() => undefined));
    await renderReviewScopes(async (probe) => {
      await reviewOpened(probe);
      await act(async () => {
        void probe().editor.controller.discardChanges(draftA, change("2"));
      });
      expect(probe().editor.controller.inlineReview?.completion).toBeUndefined();
      expect(probe().header.completing).toBeNull();
      expect(classIds(probe())).toEqual(["class-1"]);
    });
  });
});
