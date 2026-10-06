// @vitest-environment jsdom
/** A draft-only tab whose draft vanished is classified from a catalog observation made after it vanished. */

import type { Work } from "@meridian/contracts/works";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useContextTabsStore } from "@/client/stores";
import { contextTabFromDraftGroup } from "@/features/project/context/context-tab-from-draft";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { DraftReviewBoundary, useDraftReviewScopeValue } from "./DraftReviewProvider";

const mocks = vi.hoisted(() => ({
  listWorkDrafts: vi.fn(),
  coordinator: { promoteAppliedDraft: vi.fn(async () => true), discardDraft: vi.fn() },
  resources: { acquireCatalog: vi.fn(), acquireCatalogAfter: vi.fn() },
}));

vi.mock("@/client/api/drafts-api", () => ({
  listWorkDrafts: mocks.listWorkDrafts,
  getDraftPreview: vi.fn(),
}));
vi.mock("@/client/query/useContextCatalog", () => ({
  contextCatalogScope: () => ({ kind: "project", projectId: "project-a" }),
  projectCatalogView: (_project: string, _scheme: string, view: { documents: string[] }) => ({
    findDocument: (documentId: string) => (view.documents.includes(documentId) ? {} : null),
  }),
}));
vi.mock("@/features/project/context/account-feature-context", () => ({
  useContextRemovalCoordinator: () => mocks.coordinator,
  useOptionalAccountResourceReplica: () => mocks.resources,
  useLiveDocumentSessionRegistry: () => ({
    retainBranchRooms: vi.fn(),
    releaseBranchRooms: vi.fn(),
    getBranchRoom: vi.fn(),
  }),
}));

const work = { id: "work-a", projectId: "project-a", name: "Work A", archivedAt: null } as Work;

/** One review scope for the Work, composed the way the project view composes it. */
function ReviewScope() {
  const value = useDraftReviewScopeValue({ projectId: "project-a", work });
  return <DraftReviewBoundary value={value}>{null}</DraftReviewBoundary>;
}

const draft = { draftId: "draft-a", documentId: "document-a", status: "active" };

describe("DraftReviewProvider remote settlement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useContextTabsStore.setState({
      byProject: {},
      _reviewOverlayByProject: {},
      _workspaceHydrated: false,
    });
    const tab = contextTabFromDraftGroup({
      workId: "work-a",
      documentId: "document-a",
      draftId: "draft-a",
      contextPath: "/chapter.md",
      isNewDocument: true,
    });
    if (!tab) throw new Error("Draft tab fixture must be editable");
    useContextTabsStore.getState().openTab("project-a", tab);
    mocks.listWorkDrafts.mockResolvedValue({ drafts: [draft] });
    // An observation joined from before the Apply would say the document is absent.
    mocks.resources.acquireCatalog.mockResolvedValue({ documents: [] });
    mocks.resources.acquireCatalogAfter.mockResolvedValue({ documents: ["document-a"] });
  });

  it("promotes the tab of a remote Apply even while an older catalog read is in flight", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await withReactRoot(
      <QueryClientProvider client={queryClient}>
        <ReviewScope />
      </QueryClientProvider>,
      async () => {
        await vi.waitFor(() => expect(mocks.listWorkDrafts).toHaveBeenCalled());
        await act(async () => undefined);
        expect(mocks.resources.acquireCatalogAfter).not.toHaveBeenCalled();

        mocks.listWorkDrafts.mockResolvedValue({ drafts: [] });
        await act(async () => {
          await queryClient.refetchQueries({ queryKey: ["projects", "project-a"] });
        });

        await vi.waitFor(() => expect(mocks.coordinator.promoteAppliedDraft).toHaveBeenCalled());
        expect(mocks.coordinator.discardDraft).not.toHaveBeenCalled();
        expect(mocks.resources.acquireCatalog).not.toHaveBeenCalled();
      },
    );
  });
});
