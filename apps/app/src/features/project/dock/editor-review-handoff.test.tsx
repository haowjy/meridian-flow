// @vitest-environment jsdom
/** Cross-scope review commands retain identity until the matching Editor claims them. */

import { act, useEffect, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DraftReviewBoundary,
  type DraftReviewContextValue,
  useDraftReview,
} from "@/features/chat/DraftReviewProvider";
import { withReactRoot } from "@/test-support/react-dom-harness";
import type { OpenContextRoute } from "../routing/ProjectContextRoute";
import type { AiDraftLaunchTarget } from "./editor-review-handoff";
import {
  EditorReviewHandoffProvider,
  EditorReviewIntentClaimant,
  useOpenEditorReview,
} from "./editor-review-handoff";

const openTab = vi.fn();
vi.mock("@/client/stores", () => ({ useContextTabsActions: () => ({ openTab }) }));

const draftA: AiDraftLaunchTarget = {
  workId: "work-a",
  documentId: "document-shared",
  draftId: "draft-a",
  contextPath: "chapters/shared.md",
};
const draftB: AiDraftLaunchTarget = {
  workId: "work-b",
  documentId: "document-shared",
  draftId: "draft-b",
  contextPath: "chapters/shared.md",
};

let openReview: ((target: AiDraftLaunchTarget) => Promise<void>) | null = null;
let showEditor: ((target: AiDraftLaunchTarget) => void) | null = null;
let showChat: (() => void) | null = null;
let observedScopes: string[] = [];

function CommandCapture() {
  const command = useOpenEditorReview();
  useEffect(() => {
    openReview = command;
  }, [command]);
  return null;
}

function ScopeProbe({ name }: { name: string }) {
  const review = useDraftReview();
  observedScopes.push(`${name}:${review.controller.workId}`);
  return null;
}

function reviewValue(workId: string, enterInlineReview = vi.fn()): DraftReviewContextValue {
  const documentId = draftA.documentId;
  const draftId = workId === "work-a" ? draftA.draftId : draftB.draftId;
  const groups = [{ documentId, drafts: [{ draftId }] }];
  return {
    controller: {
      workId,
      inlineReview: null,
      enterInlineReview,
    },
    groups,
    groupForDocument(candidateDocumentId: string | null | undefined) {
      return groups.find((group) => group.documentId === candidateDocumentId) ?? null;
    },
    activeEditorDocumentId: documentId,
  } as unknown as DraftReviewContextValue;
}

function Harness({
  openContextRoute,
  chatReview,
  editorAReview,
  editorBReview,
}: {
  openContextRoute: OpenContextRoute;
  chatReview: DraftReviewContextValue;
  editorAReview: DraftReviewContextValue;
  editorBReview: DraftReviewContextValue;
}) {
  const [view, setView] = useState<
    { kind: "chat" } | { kind: "editor"; target: AiDraftLaunchTarget }
  >({ kind: "chat" });
  useEffect(() => {
    showChat = () => setView({ kind: "chat" });
    showEditor = (target) => setView({ kind: "editor", target });
  }, []);
  const editorReview =
    view.kind === "editor" && view.target.workId === "work-a" ? editorAReview : editorBReview;

  return (
    <EditorReviewHandoffProvider projectId="project-1" openContextRoute={openContextRoute}>
      <CommandCapture />
      {view.kind === "chat" ? (
        <DraftReviewBoundary value={chatReview}>
          <ScopeProbe name="chat" />
        </DraftReviewBoundary>
      ) : (
        <DraftReviewBoundary value={editorReview}>
          <ScopeProbe name="editor" />
          <EditorReviewIntentClaimant
            editorWorkId={view.target.workId}
            activeScheme="manuscript"
            activePath={view.target.contextPath}
          />
        </DraftReviewBoundary>
      )}
    </EditorReviewHandoffProvider>
  );
}

async function withHarness(
  children: (values: {
    enterA: ReturnType<typeof vi.fn>;
    enterB: ReturnType<typeof vi.fn>;
    navigate: ReturnType<typeof vi.fn>;
  }) => Promise<void>,
  navigate = vi.fn().mockResolvedValue(undefined),
) {
  const enterA = vi.fn();
  const enterB = vi.fn();
  await withReactRoot(
    <Harness
      openContextRoute={navigate}
      chatReview={reviewValue("work-b")}
      editorAReview={reviewValue("work-a", enterA)}
      editorBReview={reviewValue("work-b", enterB)}
    />,
    () => children({ enterA, enterB, navigate }),
  );
}

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

describe("Editor review handoff", () => {
  beforeEach(() => {
    openTab.mockClear();
    openReview = null;
    showEditor = null;
    showChat = null;
    observedScopes = [];
  });

  it("keeps Chat B and Editor A as sibling boundaries", async () => {
    await withHarness(async () => {
      expect(observedScopes.at(-1)).toBe("chat:work-b");
      await act(async () => showEditor?.(draftA));
      expect(observedScopes.at(-1)).toBe("editor:work-a");
      await act(async () => showChat?.());
      expect(observedScopes.at(-1)).toBe("chat:work-b");
    });
  });

  it("does not advertise an already-matching intent when navigation rejects", async () => {
    const route = deferred();
    const navigate = vi.fn(() => route.promise);
    await withHarness(async ({ enterB }) => {
      await act(async () => showEditor?.(draftB));
      let pending: Promise<void> | undefined;
      await act(async () => {
        pending = openReview?.(draftB);
      });
      expect(enterB).not.toHaveBeenCalled();

      route.reject(new Error("route rejected"));
      await act(async () => {
        await expect(pending).rejects.toThrow("route rejected");
      });
      expect(enterB).not.toHaveBeenCalled();
    }, navigate);
  });

  it("claims only the latest of overlapping same-document route commands", async () => {
    const routeA = deferred();
    const routeB = deferred();
    const navigate = vi
      .fn()
      .mockImplementationOnce(() => routeA.promise)
      .mockImplementationOnce(() => routeB.promise);
    await withHarness(async ({ enterA, enterB }) => {
      let pendingA: Promise<void> | undefined;
      let pendingB: Promise<void> | undefined;
      await act(async () => {
        pendingA = openReview?.(draftA);
        pendingB = openReview?.(draftB);
      });

      routeB.resolve();
      await act(async () => {
        await pendingB;
        showEditor?.(draftB);
      });
      expect(enterB).toHaveBeenCalledOnce();
      expect(enterA).not.toHaveBeenCalled();

      routeA.resolve();
      await act(async () => {
        await pendingA;
        showEditor?.(draftA);
      });
      expect(enterA).not.toHaveBeenCalled();
      expect(enterB).toHaveBeenCalledOnce();
    }, navigate);
  });
});
