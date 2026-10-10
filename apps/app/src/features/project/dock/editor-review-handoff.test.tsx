// @vitest-environment jsdom
/** Cross-scope review commands retain identity until the matching Editor claims them. */

import { act, useEffect, useLayoutEffect, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PaintCapture, PaintHold, usePaintPending } from "@/components/app/PaintHold";
import {
  DraftReviewBoundary,
  type DraftReviewContextValue,
} from "@/features/draft-review/DraftReviewProvider";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { PresentedDocumentContext } from "../presented-document";
import type { OpenContextRoute } from "../routing/ProjectNavigationContext";
import type { AiDraftLaunchTarget } from "./editor-review-handoff";
import {
  EditorReviewHandoffProvider,
  EditorReviewIntentClaimant,
  useOpenEditorReview,
  useRequestedReview,
} from "./editor-review-handoff";

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

function CommandCapture() {
  const command = useOpenEditorReview();
  useEffect(() => {
    openReview = command;
  }, [command]);
  return null;
}

function reviewValue(workId: string, enterInlineReview = vi.fn()): DraftReviewContextValue {
  const documentId = draftA.documentId;
  const draftId = workId === "work-a" ? draftA.draftId : draftB.draftId;
  const files = [{ documentId, draft: { draftId } }];
  return {
    controller: {
      workId,
      inlineReview: null,
      enterInlineReview,
    },
    files,
    fileForDocument(candidateDocumentId: string | null | undefined) {
      return files.find((group) => group.documentId === candidateDocumentId) ?? null;
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
    showEditor = (target) => setView({ kind: "editor", target });
  }, []);
  const presentedReview =
    view.kind === "editor" && view.target.workId === "work-a" ? editorAReview : editorBReview;

  return (
    <EditorReviewHandoffProvider projectId="project-1" openContextRoute={openContextRoute}>
      <CommandCapture />
      {view.kind === "chat" ? (
        <DraftReviewBoundary value={chatReview}>{null}</DraftReviewBoundary>
      ) : (
        <DraftReviewBoundary value={presentedReview}>
          <EditorReviewIntentClaimant editorWorkId={view.target.workId} activeScheme="manuscript" />
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
  navigate = vi.fn().mockResolvedValue({ kind: "applied" }),
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
  const promise = new Promise<{ kind: "applied" }>((onResolve, onReject) => {
    resolve = () => onResolve({ kind: "applied" });
    reject = onReject;
  });
  return { promise, resolve, reject };
}

describe("Editor review handoff", () => {
  beforeEach(() => {
    openReview = null;
    showEditor = null;
  });

  it("retries a superseded route settlement once with the review address", async () => {
    const navigate = vi
      .fn()
      .mockResolvedValueOnce({ kind: "superseded" })
      .mockResolvedValueOnce({ kind: "applied" });
    await withHarness(async ({ enterB }) => {
      await act(async () => showEditor?.(draftB));
      await act(async () => openReview?.(draftB));
      expect(enterB).toHaveBeenCalledOnce();
      expect(navigate).toHaveBeenCalledTimes(2);
      expect(navigate).toHaveBeenLastCalledWith(
        expect.objectContaining({ documentId: draftB.documentId }),
        expect.objectContaining({ replaceIfSameDocument: true, draftId: draftB.draftId }),
      );
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

it("a warm destination requests review before passive admission, and an admitted review owns a failed route", async () => {
  const route = deferred();
  let selected: string | null = null;
  let repaint!: () => void;
  let movePresentation!: () => void;
  let requestedByHost: string | null = null;
  const exposed: string[] = [];
  function Destination() {
    const requested = useRequestedReview({
      container: "editor",
      editorWorkId: "work-a",
      activeScheme: "manuscript",
      documentId: draftA.documentId,
    });
    requestedByHost = requested;
    usePaintPending(Boolean(requested));
    useLayoutEffect(() => {
      if (!requested && selected) exposed.push("live");
    });
    return (
      <>
        <PaintCapture surface={requested ?? "live"} />
        <p>{requested ? "pending review" : "warm live"}</p>
      </>
    );
  }
  function Owner() {
    const [container, setContainer] = useState<"editor" | "dock">("editor");
    movePresentation = () => setContainer("dock");
    const [, update] = useState(0);
    repaint = () => update((n) => n + 1);
    const value = reviewValue(
      "work-a",
      vi.fn((_doc, draft) => {
        selected = draft;
        repaint();
      }),
    );
    value.controller.inlineReview = selected
      ? ({ documentId: draftA.documentId, draftId: selected } as NonNullable<
          typeof value.controller.inlineReview
        >)
      : null;
    return (
      <PresentedDocumentContext.Provider
        value={{
          container,
          documentId: draftA.documentId,
          scheme: "manuscript",
          path: draftA.contextPath,
          review: null,
          draftOnly: false,
        }}
      >
        <DraftReviewBoundary value={value}>
          <PaintHold status="Opening">
            <Destination />
          </PaintHold>
          <EditorReviewIntentClaimant editorWorkId="work-a" activeScheme="manuscript" />
        </DraftReviewBoundary>
      </PresentedDocumentContext.Provider>
    );
  }
  await withReactRoot(
    <EditorReviewHandoffProvider projectId="project-1" openContextRoute={() => route.promise}>
      <CommandCapture />
      <Owner />
    </EditorReviewHandoffProvider>,
    async () => {
      let done!: Promise<void>;
      await act(async () => {
        if (!openReview) throw new Error("Missing command");
        done = openReview(draftA).catch(() => {});
      });
      expect(selected).toBe(draftA.draftId);
      expect(document.querySelector("[data-paint-hold]")?.textContent).toBe("warm live");
      await act(async () => {
        route.reject(new Error("route failed"));
        await done;
      });
      expect(document.querySelector("[data-paint-page]")?.textContent).toBe("pending review");
      expect(exposed).toEqual([]);
      await act(async () => movePresentation());
      expect(requestedByHost).toBeNull();
    },
  );
});

it("clears a draft-only request when routing fails before admission", async () => {
  const route = deferred();
  let requested: string | null = null;
  function Destination() {
    requested = useRequestedReview({
      container: "editor",
      editorWorkId: "work-a",
      activeScheme: "manuscript",
      documentId: draftA.documentId,
    });
    return null;
  }
  const value = reviewValue("work-a");
  await withReactRoot(
    <EditorReviewHandoffProvider projectId="project-1" openContextRoute={() => route.promise}>
      <CommandCapture />
      <PresentedDocumentContext.Provider
        value={{
          container: "editor",
          documentId: draftA.documentId,
          scheme: "manuscript",
          path: draftA.contextPath,
          review: null,
          draftOnly: false,
        }}
      >
        <DraftReviewBoundary value={value}>
          <Destination />
        </DraftReviewBoundary>
      </PresentedDocumentContext.Provider>
    </EditorReviewHandoffProvider>,
    async () => {
      let done!: Promise<void>;
      await act(async () => {
        if (!openReview) throw new Error("Missing command");
        done = openReview({ ...draftA, isNewDocument: true }).catch(() => {});
      });
      expect(requested).toBe(draftA.draftId);
      await act(async () => {
        route.reject(new Error("route failed"));
        await done;
      });
      expect(requested).toBeNull();
    },
  );
});
