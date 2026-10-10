// @vitest-environment jsdom
/** Compact transfer policy and the dock's independent occupant lifetime. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ContextTab } from "@/client/stores";
import { type DockDocument, useDockDocumentStore } from "./dock-document-store";
import { handOffVisibleDocument } from "./hand-off-visible-document";

const panelTab = {
  kind: "tracked",
  documentId: "panel",
  name: "panel.md",
  scheme: "manuscript",
  path: "/panel.md",
  editable: true,
  filetype: "markdown",
  schemaType: "document",
} satisfies ContextTab;
const chatDocument: DockDocument = {
  projectId: "project",
  screen: "chat",
  tab: panelTab,
  review: null,
};
beforeEach(() => useDockDocumentStore.setState(useDockDocumentStore.getInitialState(), true));
it.each([
  { source: "chat", destination: "chat", tab: panelTab },
  { source: "context", destination: "work", tab: panelTab },
  { source: "work", destination: "context", tab: null },
] as const)("no transfer for $source to $destination without an eligible document", (input) => {
  const claim = vi.fn();
  expect(
    handOffVisibleDocument({
      ...input,
      review: null,
      claim,
      isCurrent: () => true,
      transfer: vi.fn(),
    }),
  ).toBeUndefined();
  expect(claim).not.toHaveBeenCalled();
});
describe("syncOccupantScope", () => {
  it("parks a Chat occupant across screen changes", () => {
    useDockDocumentStore.setState({ occupant: chatDocument });
    for (const screen of ["chat", "work", "context", "chat"] as const) {
      useDockDocumentStore.getState().syncOccupantScope("project", screen, "work");
      expect(useDockDocumentStore.getState().occupant).toEqual(chatDocument);
    }
  });
  it.each([
    "work",
    "context",
    "chat",
  ] as const)("drops a Work occupant leaving its Work or screen for %s", (screen) => {
    useDockDocumentStore.setState({
      occupant: {
        ...chatDocument,
        screen: "work",
        tab: { ...panelTab, scheme: "scratch", workId: "work" },
      },
    });
    useDockDocumentStore.getState().syncOccupantScope("project", "work", "work");
    expect(useDockDocumentStore.getState().occupant).not.toBeNull();
    useDockDocumentStore
      .getState()
      .syncOccupantScope("project", screen, screen === "work" ? "other" : "work");
    expect(useDockDocumentStore.getState().occupant).toBeNull();
  });
  it.each(["chat", "work"] as const)("drops a %s occupant on project change", (screen) => {
    useDockDocumentStore.setState({ occupant: { ...chatDocument, screen } });
    useDockDocumentStore.getState().syncOccupantScope("other", screen, "work");
    expect(useDockDocumentStore.getState().occupant).toBeNull();
  });
});

// Real review/address owners compose with both document hosts; only session,
// TipTap construction and paint are substituted, never the controller.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Editor } from "@tiptap/core";
import { act, type ReactNode, useCallback, useEffect, useState } from "react";
import {
  DraftReviewBoundary,
  useDraftReviewScopeValue,
} from "@/features/draft-review/DraftReviewProvider";
import { createReviewScopeFixture, listed, preview, work } from "@/test-support/draft-review-scope";
import { withReactRoot } from "@/test-support/react-dom-harness";
import * as account from "../context/account-feature-context";
import { ContextDocumentHost } from "../context/ContextDocumentHost";
import { PresentedDocumentContext, resolvePresentedDocument } from "../presented-document";
import { ReviewAddressOwner } from "../ReviewAddressOwner";
import type { OpenContextRoute } from "../routing/ProjectNavigationContext";
import { openDocumentInEditor } from "../routing/use-open-document-in-editor";
import { EditorReviewHandoffProvider } from "./editor-review-handoff";

vi.mock("../context/context-tab-session", () => ({
  resourceAvailabilityRevision: () => "ready",
  ContextTabSessionBoundary: ({
    liveRoom,
    children,
  }: {
    liveRoom: boolean;
    children: (session: unknown, failed: boolean, ready: boolean) => ReactNode;
  }) => children(liveRoom ? liveSession : null, false, true),
}));
vi.mock("@/features/editor/SessionEditor", () => ({
  PendingEditorShell: () => <p>Pending</p>,
  SessionEditor: ({ onConstructed }: { onConstructed?: (editor: Editor | null) => void }) => {
    useEffect(() => {
      onConstructed?.({} as Editor);
      return () => onConstructed?.(null);
    }, []);
    return (
      <p data-prose={onConstructed ? "review" : "live"}>
        {onConstructed ? "Valid draft prose" : "Live body"}
      </p>
    );
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
  PaintCapture: () => null,
  PaintScope: ({ children }: { children: ReactNode }) => children,
}));
const liveSession = {
  suspendPresence: () => {},
  resumePresence: () => {},
  subscribe: () => () => {},
  document: { on: () => {}, off: () => {} },
};
it.each([true, false])("review follows both hand-offs, draft-only=%s", async (draftOnly) => {
  const fixture = createReviewScopeFixture();
  account.useLiveDocumentSessionRegistry().observeBranchRoom = () => () => {};
  const projection = vi.spyOn(account, "useAccountResourceProjection").mockReturnValue({
    records: [],
    folders: [],
    snapshot: null,
  } as unknown as ReturnType<typeof account.useAccountResourceProjection>);
  const tab = {
    ...panelTab,
    documentId: "document-a",
    draftOnly,
    reviewWorkId: "work-a",
    reviewDraftId: "draft-a",
    tabInstanceToken: "token",
  };
  fixture.network.listWorkDrafts.mockResolvedValue({
    drafts: [{ ...listed, contextPath: tab.path, isNewDocument: draftOnly }],
  });
  fixture.network.getDraftPreview.mockResolvedValue(preview);
  const route = vi.fn(async () => ({ kind: "applied" as const }));
  let changeScreen!: (next: "chat" | "context") => void;
  let value!: ReturnType<typeof useDraftReviewScopeValue>;
  function Harness() {
    const [screen, setScreen] = useState<"chat" | "context">("context");
    const occupant = useDockDocumentStore((state) => state.occupant);
    const presented = resolvePresentedDocument({
      phone: false,
      screen,
      dock: occupant,
      editor: {
        workId: "work-a",
        scheme: "manuscript",
        path: tab.path,
        documentId: tab.documentId,
        draftId: "draft-a",
        draftOnly,
      },
    });
    value = useDraftReviewScopeValue({
      projectId: "project-a",
      work,
      draftOnly: presented?.draftOnly,
    });
    const write = useCallback(() => {}, []);
    changeScreen = (next) => {
      const store = useDockDocumentStore.getState();
      const plan = handOffVisibleDocument({
        source: screen,
        destination: next,
        tab: screen === "context" ? tab : (occupant?.tab ?? null),
        review: presented?.review ?? null,
        claim: store.claim,
        isCurrent: store.isCurrent,
        transfer: (to, carried, claim, review) => {
          if (to === "chat")
            store.commit(claim, {
              projectId: "project-a",
              screen: "chat",
              tab: carried,
              review,
            } as DockDocument);
          else store.closeDocument();
        },
      });
      if (next === "context" && plan)
        void openDocumentInEditor(route as unknown as OpenContextRoute, plan.tab, {
          afterCommit: plan.afterCommit,
          review: plan.review,
        });
      setScreen(next);
      plan?.afterCommit();
    };
    return (
      <EditorReviewHandoffProvider
        projectId="project-a"
        openContextRoute={route as unknown as OpenContextRoute}
      >
        <PresentedDocumentContext.Provider value={presented}>
          <DraftReviewBoundary value={value}>
            <ReviewAddressOwner
              review={value}
              presented={presented}
              port={{
                write: (address) =>
                  screen === "chat"
                    ? useDockDocumentStore.getState().setDocumentReview(address)
                    : write(),
                admit: (target) =>
                  value.controller.enterInlineReview(target.documentId, target.draftId),
              }}
            />
            <div data-container="editor">
              <ContextDocumentHost
                container="editor"
                projectId="project-a"
                tab={tab}
                active={screen === "context"}
              />
            </div>
            {occupant ? (
              <div data-container="dock">
                <ContextDocumentHost container="dock" projectId="project-a" tab={tab} active />
              </div>
            ) : null}
          </DraftReviewBoundary>
        </PresentedDocumentContext.Provider>
      </EditorReviewHandoffProvider>
    );
  }
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  try {
    await withReactRoot(
      <QueryClientProvider client={query}>
        <Harness />
      </QueryClientProvider>,
      async () => {
        const container = document.getElementById("root");
        if (!container) throw new Error("Missing harness root");
        await act(async () => value.controller.enterInlineReview(tab.documentId, "draft-a"));
        await vi.waitFor(() => expect(container.textContent).toContain("Valid draft prose"));
        const selected = value.controller.inlineReview;
        await act(async () => changeScreen("chat"));
        expect(container.querySelector('[data-container="dock"]')?.textContent).toContain(
          "Valid draft prose",
        );
        expect(container.querySelector('[data-container="dock"]')?.textContent).not.toContain(
          "Couldn't open this draft.",
        );
        expect(value.controller.inlineReview?.draftId).toBe(selected?.draftId);
        expect(container.querySelectorAll('[data-prose="review"]')).toHaveLength(1);
        await act(async () => changeScreen("context"));
        expect(route).toHaveBeenLastCalledWith(
          expect.objectContaining({ workId: "work-a" }),
          expect.objectContaining({ draftId: "draft-a" }),
        );
        expect(useDockDocumentStore.getState().occupant).toBeNull();
        expect(container.querySelector('[data-container="editor"]')?.textContent).toContain(
          "Valid draft prose",
        );
      },
    );
  } finally {
    projection.mockRestore();
    fixture.dispose();
    query.clear();
  }
});
