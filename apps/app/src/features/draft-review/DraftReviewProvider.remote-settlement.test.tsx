// @vitest-environment jsdom
/** A draft-only tab whose draft vanished is classified from a catalog observation made after it vanished. */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useContextTabsStore } from "@/client/stores";
import { contextTabFromDraftGroup } from "@/features/project/context/context-tab-from-draft";
import { dockDocument, useDockDocumentStore } from "@/features/project/dock/dock-document-store";
import { resolvePresentedDocument } from "@/features/project/presented-document";
import { ReviewAddressOwner } from "@/features/project/ReviewAddressOwner";
import { createReviewScopeFixture, listed, preview, work } from "@/test-support/draft-review-scope";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { DraftOnlySettlement } from "./DraftOnlySettlement";
import { useDraftReviewScopeValue } from "./DraftReviewProvider";

const resources = { acquireCatalog: vi.fn(), acquireCatalogAfter: vi.fn() };
let fixture: ReturnType<typeof createReviewScopeFixture>;
let promote: ReturnType<typeof vi.spyOn>;
let discard: ReturnType<typeof vi.spyOn>;

vi.mock("@/client/query/useContextCatalog", () => ({
  contextCatalogScope: () => ({ kind: "project", projectId: "project-a" }),
  useContextCatalogView: () => ({ catalog: null }),
  projectCatalogView: (_project: string, _scheme: string, view: { documents: string[] }) => ({
    findDocument: (documentId: string) => (view.documents.includes(documentId) ? {} : null),
  }),
}));
describe("DraftReviewProvider remote settlement", () => {
  beforeEach(() => {
    fixture = createReviewScopeFixture({ resources: resources as never });
    promote = vi.spyOn(fixture.removal, "promoteAppliedDraft").mockResolvedValue(true);
    discard = vi.spyOn(fixture.removal, "discardDraft").mockReturnValue({ kind: "noop" });
    fixture.network.getDraftPreview.mockResolvedValue(preview);
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
    fixture.network.listWorkDrafts.mockResolvedValue({ drafts: [listed] });
    // An observation joined from before the Apply would say the document is absent.
    resources.acquireCatalog.mockResolvedValue({ documents: [] });
    resources.acquireCatalogAfter.mockResolvedValue({ documents: ["document-a"] });
  });

  afterEach(() => {
    promote.mockRestore();
    discard.mockRestore();
    fixture.dispose();
  });

  it.each([
    ["dock", "apply"],
    ["both", "apply"],
    ["both", "discard"],
  ] as const)("settles remote %s %s from a catalog read after omission", async (container, mode) => {
    const tab = useContextTabsStore.getState()._reviewOverlayByProject["project-a"]?.tabs[0];
    if (!tab) throw new Error("Missing draft overlay");
    useDockDocumentStore.setState({
      occupant: dockDocument("project-a", "chat", tab, { workId: "work-a", draftId: "draft-a" }),
    });
    if (container === "dock")
      useContextTabsStore.setState({ _reviewOverlayByProject: {}, byProject: {} });
    resources.acquireCatalogAfter.mockResolvedValue({
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
        presented,
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
        await vi.waitFor(() => expect(fixture.network.listWorkDrafts).toHaveBeenCalled());
        await act(async () => undefined);
        expect(resources.acquireCatalogAfter).not.toHaveBeenCalled();

        fixture.network.listWorkDrafts.mockResolvedValue({ drafts: [] });
        fixture.network.getDraftPreview.mockResolvedValue({
          status: "gone",
          draftId: "draft-a",
        });
        await act(async () => {
          await queryClient.refetchQueries({ queryKey: ["projects", "project-a"] });
        });

        await vi.waitFor(() => {
          if (container !== "dock") expect(mode === "apply" ? promote : discard).toHaveBeenCalled();
          if (mode === "apply")
            expect(useDockDocumentStore.getState().occupant?.tab).not.toHaveProperty("draftOnly");
          else expect(useDockDocumentStore.getState().occupant).toBeNull();
        });
        if (container === "dock" && mode === "apply") {
          await act(async () => {
            await queryClient.invalidateQueries({ queryKey: ["projects", "project-a"] });
          });
          await vi.waitFor(() => expect(selected?.controller.inlineReview).toBeNull());
          expect(useDockDocumentStore.getState().occupant?.review).toBeNull();
        }
        expect(useDockDocumentStore.getState().isCurrent(claim)).toBe(true);
        expect(resources.acquireCatalog).not.toHaveBeenCalled();
      },
    );
  });
});
