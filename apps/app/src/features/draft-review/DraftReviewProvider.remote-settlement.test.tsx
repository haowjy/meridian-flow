// @vitest-environment jsdom
/** A draft-only tab whose draft vanished is classified from a catalog observation made after it vanished. */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useContextTabsStore } from "@/client/stores";
import { DocumentSession } from "@/core/editor/document-session";
import { contextTabFromDraftGroup } from "@/features/project/context/context-tab-from-draft";
import { dockDocument, useDockDocumentStore } from "@/features/project/dock/dock-document-store";
import { resolvePresentedDocument } from "@/features/project/presented-document";
import { ReviewAddressOwner } from "@/features/project/ReviewAddressOwner";
import { preview, work } from "@/test-support/draft-review-scope";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { DraftOnlySettlement } from "./DraftOnlySettlement";
import { useDraftReviewScopeValue } from "./DraftReviewProvider";

const mocks = vi.hoisted(() => ({
  listWorkDrafts: vi.fn(),
  getDraftPreview: vi.fn(),
  session: null as DocumentSession | null,
  registry: { retainBranchRooms: vi.fn(), releaseBranchRooms: vi.fn(), getBranchRoom: vi.fn() },
  coordinator: { promoteAppliedDraft: vi.fn(async () => true), discardDraft: vi.fn() },
  resources: { acquireCatalog: vi.fn(), acquireCatalogAfter: vi.fn() },
}));

vi.mock("@/client/api/drafts-api", () => ({
  listWorkDrafts: mocks.listWorkDrafts,
  getDraftPreview: mocks.getDraftPreview,
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
  useLiveDocumentSessionRegistry: () => mocks.registry,
}));

const draft = { draftId: "draft-a", documentId: "document-a", status: "active" };

describe("DraftReviewProvider remote settlement", () => {
  beforeEach(() => {
    mocks.session?.destroy();
    mocks.session = new DocumentSession({
      roomKey: "review-room-a",
      persistence: { kind: "none" },
    });
    mocks.getDraftPreview.mockResolvedValue(preview);
    mocks.registry.getBranchRoom.mockImplementation(() => mocks.session);
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
    let selected: ReturnType<typeof useDraftReviewScopeValue> | null = null;
    function DockReview() {
      const dock = useDockDocumentStore((state) => state.occupant);
      const presented = resolvePresentedDocument({
        phone: false,
        screen: "chat",
        dock,
        editor: { workId: "work-a", scheme: null, path: null, draftOnly: false },
      });
      selected = useDraftReviewScopeValue({
        projectId: "project-a",
        work,
        draftOnly: presented?.draftOnly,
      });
      return (
        <>
          <DraftOnlySettlement projectId="project-a" />
          <ReviewAddressOwner
            review={selected}
            presented={presented}
            port={{
              write: (address) => useDockDocumentStore.getState().setDocumentReview(address),
              admit: (target) =>
                selected?.controller.enterInlineReview(target.documentId, target.draftId),
            }}
          />
        </>
      );
    }
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await withReactRoot(
      <QueryClientProvider client={queryClient}>
        {container === "dock" ? <DockReview /> : <DraftOnlySettlement projectId="project-a" />}
      </QueryClientProvider>,
      async () => {
        await vi.waitFor(() => expect(mocks.listWorkDrafts).toHaveBeenCalled());
        await act(async () => undefined);
        expect(mocks.resources.acquireCatalogAfter).not.toHaveBeenCalled();

        mocks.listWorkDrafts.mockResolvedValue({ drafts: [] });
        mocks.getDraftPreview.mockResolvedValue({
          status: "gone",
          draftId: "draft-a",
          draftGeneration: 1,
        });
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
        if (container === "dock" && mode === "apply") {
          await act(async () => {
            await queryClient.invalidateQueries({ queryKey: ["projects", "project-a"] });
          });
          await vi.waitFor(() => expect(selected?.controller.inlineReview).toBeNull());
          expect(useDockDocumentStore.getState().occupant?.review).toBeNull();
        }
        expect(useDockDocumentStore.getState().isCurrent(claim)).toBe(true);
        expect(mocks.resources.acquireCatalog).not.toHaveBeenCalled();
      },
    );
  });
});
