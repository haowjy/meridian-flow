// @vitest-environment jsdom
/** A draft-only tab whose draft vanished is classified from a catalog observation made after it vanished. */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Editor } from "@tiptap/core";
import { act, type ReactNode, useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import { useContextTabsStore } from "@/client/stores";
import { TooltipProvider } from "@/components/ui/tooltip";
import * as account from "@/features/project/context/account-feature-context";
import { ContextDocumentHost } from "@/features/project/context/ContextDocumentHost";
import { contextTabFromDraftGroup } from "@/features/project/context/context-tab-from-draft";
import { DocumentPaneChrome } from "@/features/project/context/DocumentPaneChrome";
import { dockDocument, useDockDocumentStore } from "@/features/project/dock/dock-document-store";
import { EditorReviewHandoffProvider } from "@/features/project/dock/editor-review-handoff";
import {
  PresentedDocumentContext,
  resolvePresentedDocument,
} from "@/features/project/presented-document";
import { ReviewAddressOwner } from "@/features/project/ReviewAddressOwner";
import { createReviewScopeFixture, listed, preview, work } from "@/test-support/draft-review-scope";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { DraftOnlySettlement } from "./DraftOnlySettlement";
import { DraftReviewBoundary, useDraftReviewScopeValue } from "./DraftReviewProvider";

vi.mock("@/features/project/context/context-tab-session", () => ({
  resourceAvailabilityRevision: () => "ready",
  ContextTabSessionBoundary: ({
    children,
  }: {
    children: (session: null, failed: boolean, ready: boolean) => ReactNode;
  }) => children(null, false, true),
}));
vi.mock("@/features/editor/SessionEditor", () => ({
  PendingEditorShell: () => <p>Pending</p>,
  SessionEditor: ({ onConstructed }: { onConstructed?: (editor: Editor | null) => void }) => {
    useEffect(() => {
      onConstructed?.({} as Editor);
      return () => onConstructed?.(null);
    }, []);
    return <p>Document prose</p>;
  },
}));
vi.mock("@/features/editor/useInlineReviewFocus", () => ({ useInlineReviewFocus: () => {} }));
vi.mock("@/features/editor/useInlineReviewSync", () => ({
  useInlineReviewSync: ({
    editor,
    onInlineModelAvailable,
    documentId,
    draftId,
  }: {
    editor: Editor | null;
    onInlineModelAvailable: (model: string, documentId: string, draftId: string) => void;
    documentId: string;
    draftId: string;
  }) => {
    useEffect(() => {
      if (editor) onInlineModelAvailable("model", documentId, draftId);
    }, [editor]);
  },
}));
vi.mock("@/components/app/PaintHold", () => ({
  usePaintPending: () => {},
  PaintCapture: () => null,
  PaintScope: ({ children }: { children: ReactNode }) => children,
}));
const resources = { acquireCatalog: vi.fn(), acquireCatalogAfter: vi.fn() };
let fixture: ReturnType<typeof createReviewScopeFixture>;
let promote: ReturnType<typeof vi.spyOn>;
let replica: ReturnType<typeof vi.spyOn>;
let projection: ReturnType<typeof vi.spyOn>;
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
    replica = vi.spyOn(account, "useAccountResourceReplica").mockReturnValue(resources as never);
    projection = vi.spyOn(account, "useAccountResourceProjection").mockReturnValue({
      records: [],
      folders: [],
      snapshot: { records: [], folders: [], catalogs: [] },
      error: null,
    } as never);
    const registry = account.useLiveDocumentSessionRegistry();
    registry.observeBranchRoom = () => () => undefined;
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
    replica.mockRestore();
    projection.mockRestore();
    promote.mockRestore();
    discard.mockRestore();
    fixture.dispose();
  });

  it.each([
    ["dock", "apply"],
    ["dock", "discard"],
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
    let finishCatalog!: () => void;
    resources.acquireCatalogAfter.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishCatalog = () => resolve({ documents: mode === "apply" ? ["document-a"] : [] });
        }),
    );
    const claim = useDockDocumentStore.getState().claim();
    const admission = vi.fn();
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
        <PresentedDocumentContext.Provider value={presented}>
          <DraftReviewBoundary value={selected}>
            <DraftOnlySettlement projectId="project-a" />
            <ReviewAddressOwner
              review={selected}
              presented={presented}
              port={{
                write: (address) => useDockDocumentStore.getState().setDocumentReview(address),
                admit: (target) => {
                  admission(target);
                  // A second admission of this unchanged intrinsic address is the
                  // observable cycle; stop it here so act can report the regression.
                  expect(admission).toHaveBeenCalledTimes(1);
                  selected?.controller.enterInlineReview(target.documentId, target.draftId);
                },
              }}
            />
            {dock && dock.tab.kind === "tracked" ? (
              <>
                <DocumentPaneChrome
                  projectId="project-a"
                  editorWorkId="work-a"
                  tab={dock.tab}
                  archivedWork={null}
                  identityReadOnly={false}
                  onCloseTab={() => undefined}
                  onCommitted={() => undefined}
                  onOpenExisting={() => undefined}
                />
                <ContextDocumentHost projectId="project-a" container="dock" tab={dock.tab} active />
              </>
            ) : null}
          </DraftReviewBoundary>
        </PresentedDocumentContext.Provider>
      );
    }
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await withReactRoot(
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <EditorReviewHandoffProvider
            projectId="project-a"
            openContextRoute={async () => ({ kind: "cancelled" }) as never}
          >
            {container === "dock" ? <DockReview /> : <DraftOnlySettlement projectId="project-a" />}
          </EditorReviewHandoffProvider>
        </TooltipProvider>
      </QueryClientProvider>,
      async () => {
        useDockDocumentStore.setState({ accountId: "account-a" });
        await vi.waitFor(() => expect(fixture.network.listWorkDrafts).toHaveBeenCalled());
        await act(async () => undefined);
        expect(resources.acquireCatalogAfter).not.toHaveBeenCalled();

        fixture.network.listWorkDrafts.mockResolvedValue({ drafts: [] });
        const emptyPreview = {
          ...preview,
          draftGeneration: mode === "discard" ? 2 : 1,
          operations: [],
          hunks: [],
        };
        fixture.network.getDraftPreview.mockResolvedValue(emptyPreview);
        await act(async () => {
          queryClient.setQueryData(
            projectQueryKeys.workDraftPreview("project-a", "work-a", "document-a", "draft-a"),
            emptyPreview,
          );
          await queryClient.refetchQueries({
            queryKey: projectQueryKeys.workDrafts("project-a", "work-a"),
          });
        });

        await vi.waitFor(() => expect(resources.acquireCatalogAfter).toHaveBeenCalled());
        // Empty active preview arrives before the live catalog, just like a remote
        // room reset. Lifecycle alone decides whether this overlay promotes or closes.
        if (container === "dock") {
          expect(selected?.controller.inlineReview?.draftId).toBe("draft-a");
          expect(useDockDocumentStore.getState().occupant?.tab).toHaveProperty("draftOnly", true);
          expect(useContextTabsStore.getState().byProject).toEqual({});
        }
        await act(async () => finishCatalog());
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
        expect(
          JSON.parse(window.sessionStorage.getItem("meridian:dock:v1") ?? "null")?.occupant,
        ).toEqual(useDockDocumentStore.getState().occupant);
        expect(admission).toHaveBeenCalledTimes(container === "dock" ? 1 : 0);
        expect(useDockDocumentStore.getState().isCurrent(claim)).toBe(true);
        expect(resources.acquireCatalog).not.toHaveBeenCalled();
      },
    );
  });
});
