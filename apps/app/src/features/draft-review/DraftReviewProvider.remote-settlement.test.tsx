// @vitest-environment jsdom
/** A draft-only tab whose draft vanished is classified from a catalog observation made after it vanished. */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useContextTabsStore } from "@/client/stores";
import { contextTabFromDraftGroup } from "@/features/project/context/context-tab-from-draft";
import { dockDocument, useDockDocumentStore } from "@/features/project/dock/dock-document-store";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { DraftOnlySettlement } from "./DraftOnlySettlement";

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
  useContextCatalogView: () => ({ catalog: null }),
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

const draft = { draftId: "draft-a", documentId: "document-a", status: "active" };

describe("DraftReviewProvider remote settlement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useDockDocumentStore.setState(useDockDocumentStore.getInitialState(), true);
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

  it.each([
    ["editor", "apply"],
    ["dock", "apply"],
    ["both", "apply"],
    ["dock", "discard"],
    ["both", "discard"],
  ] as const)("settles remote %s %s from a catalog read after omission", async (container, mode) => {
    const tab = useContextTabsStore.getState()._reviewOverlayByProject["project-a"]?.tabs[0];
    if (!tab) throw new Error("Missing draft overlay");
    if (container !== "editor")
      useDockDocumentStore.setState({
        occupant: dockDocument("project-a", "chat", tab, { workId: "work-a", draftId: "draft-a" }),
      });
    if (container === "dock")
      useContextTabsStore.setState({ _reviewOverlayByProject: {}, byProject: {} });
    mocks.resources.acquireCatalogAfter.mockResolvedValue({
      documents: mode === "apply" ? ["document-a"] : [],
    });
    const claim = useDockDocumentStore.getState().claim();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await withReactRoot(
      <QueryClientProvider client={queryClient}>
        <DraftOnlySettlement projectId="project-a" />
      </QueryClientProvider>,
      async () => {
        await vi.waitFor(() => expect(mocks.listWorkDrafts).toHaveBeenCalled());
        await act(async () => undefined);
        expect(mocks.resources.acquireCatalogAfter).not.toHaveBeenCalled();

        mocks.listWorkDrafts.mockResolvedValue({ drafts: [] });
        await act(async () => {
          await queryClient.refetchQueries({ queryKey: ["projects", "project-a"] });
        });

        await vi.waitFor(() => {
          if (container !== "dock")
            expect(
              mode === "apply"
                ? mocks.coordinator.promoteAppliedDraft
                : mocks.coordinator.discardDraft,
            ).toHaveBeenCalled();
          if (container !== "editor") {
            if (mode === "apply")
              expect(useDockDocumentStore.getState().occupant?.tab).not.toHaveProperty("draftOnly");
            else expect(useDockDocumentStore.getState().occupant).toBeNull();
          }
        });
        expect(useDockDocumentStore.getState().isCurrent(claim)).toBe(true);
        expect(mocks.resources.acquireCatalog).not.toHaveBeenCalled();
      },
    );
  });
});
