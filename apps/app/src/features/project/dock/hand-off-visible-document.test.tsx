// @vitest-environment jsdom
/** Real review/address owners witness hand-offs and container-local document/review Close. */

import type { ParsedRequestId } from "@meridian/contracts/request-id";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
beforeEach(() => {
  vi.useFakeTimers();
  useDockDocumentStore.setState(useDockDocumentStore.getInitialState(), true);
});
afterEach(() => vi.useRealTimers());

// Real review/address owners compose with both document hosts; only session,
// TipTap construction and paint are substituted, never the controller.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Editor } from "@tiptap/core";
import { act, type ReactNode, useEffect, useState } from "react";
import {
  DraftReviewBoundary,
  useDraftReviewScopeValue,
} from "@/features/draft-review/DraftReviewProvider";
import { createReviewScopeFixture, listed, preview, work } from "@/test-support/draft-review-scope";
import { settleReact, withReactRoot } from "@/test-support/react-dom-harness";
import * as account from "../context/account-feature-context";
import { ContextDocumentHost } from "../context/ContextDocumentHost";
import { PresentedDocumentContext, resolvePresentedDocument } from "../presented-document";
import { ReviewAddressOwner } from "../ReviewAddressOwner";
import type { OpenContextRoute } from "../routing/ProjectNavigationContext";
import { useEditorContainerAddress } from "../routing/project-local-selection";
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
  let setEditorDraftId!: (draftId: string | undefined) => void;
  const route = vi.fn(async (_target: unknown, options?: { draftId?: string }) => {
    setEditorDraftId(options?.draftId);
    return { kind: "applied" as const };
  });
  let editorDraftId: string | undefined;
  let changeScreen!: (next: "chat" | "context") => void;
  let value!: ReturnType<typeof useDraftReviewScopeValue>;
  function Harness() {
    const [screen, setScreen] = useState<"chat" | "context">("context");
    const [draftId, setDraftId] = useState<string | undefined>("draft-a");
    editorDraftId = draftId;
    setEditorDraftId = setDraftId;
    const editorAddress = useEditorContainerAddress({
      active: screen === "context",
      accountId: "account-a",
      address: {
        projectId: "project-a",
        destination:
          screen === "context"
            ? { kind: "document", scheme: "manuscript", path: "panel.md" }
            : { kind: "chat-index" },
        work: { kind: "id", id: work.id as ParsedRequestId },
        ...(screen === "context" ? { draftId } : {}),
      },
      documentId: screen === "context" ? tab.documentId : null,
      workId: "work-a",
    });
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
        draftId: screen === "context" ? draftId : undefined,
        draftOnly,
      },
    });
    value = useDraftReviewScopeValue({
      projectId: "project-a",
      work,
      presented,
    });
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
      if (next === "context" && plan?.review)
        void openDocumentInEditor(route as unknown as OpenContextRoute, plan.tab, {
          afterCommit: plan.afterCommit,
          review: plan.review,
        });
      if (next === "context" && !plan?.review)
        void route({}, { draftId: editorAddress?.address.draftId });
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
                  screen !== "context"
                    ? useDockDocumentStore.getState().setDocumentReview(address)
                    : setDraftId(address?.draftId),
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
        await settleReact(() => expect(container.textContent).toContain("Valid draft prose"));
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
        await act(async () => changeScreen("chat"));
        await act(async () => useDockDocumentStore.getState().closeDocument());
        expect(useDockDocumentStore.getState().occupant).toBeNull();
        await act(async () => changeScreen("context"));
        expect(editorDraftId).toBe("draft-a");
        await settleReact(() => expect(value.controller.inlineReview?.draftId).toBe("draft-a"));
        expect(container.querySelector('[data-container="editor"]')?.textContent).toContain(
          "Valid draft prose",
        );
        if (!draftOnly) {
          await act(async () => changeScreen("chat"));
          await act(async () => value.controller.exitInlineReview());
          expect(useDockDocumentStore.getState().occupant?.review).toBeNull();
          expect(editorDraftId).toBe("draft-a");
          await act(async () => changeScreen("context"));
          expect(editorDraftId).toBe("draft-a");
          await settleReact(() => expect(value.controller.inlineReview?.draftId).toBe("draft-a"));
        }
      },
    );
  } finally {
    projection.mockRestore();
    fixture.dispose();
    query.clear();
  }
});
