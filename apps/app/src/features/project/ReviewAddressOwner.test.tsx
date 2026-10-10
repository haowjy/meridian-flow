// @vitest-environment jsdom
/** Address ownership keeps inline review and Editor history on one document. */
import { act, useEffect, useMemo, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DraftReviewContextValue } from "@/features/draft-review/DraftReviewProvider";
import { withReactRoot } from "@/test-support/react-dom-harness";
import {
  type AiDraftLaunchTarget,
  EditorReviewHandoffProvider,
  useOpenEditorReview,
} from "./dock/editor-review-handoff";
import { ReviewAddressOwner } from "./ReviewAddressOwner";
import type { OpenContextRoute } from "./routing/ProjectNavigationContext";

const draft: AiDraftLaunchTarget = {
  workId: "work-1",
  documentId: "document-a",
  draftId: "draft-a",
  contextPath: "chapters/a.md",
};
let openReview: ((target: AiDraftLaunchTarget) => Promise<void>) | null = null;
type InlineReview = {
  documentId: string;
  draftId: string;
  completion?: { phase: "pending" | "closed"; documentName: string | null };
};
let setInline: ((inline: InlineReview | null) => void) | null = null;

function CommandCapture() {
  const open = useOpenEditorReview();
  useEffect(() => {
    openReview = open;
  }, [open]);
  return null;
}

function Harness({
  requestedDraftId,
  activeScreen = "context",
  activeScheme = "manuscript",
  activePath = draft.contextPath,
  activeDocumentId,
  onSetDraftId,
  exitInlineReview,
  openContextRoute,
  listed = true,
  container = "editor",
  draftOnly = false,
  admit = vi.fn(),
}: {
  /** The Work's draft list still names the reviewed document. */
  listed?: boolean;
  container?: "editor" | "dock";
  draftOnly?: boolean;
  admit?: (target: AiDraftLaunchTarget) => void;
  requestedDraftId?: string;
  activeScreen?: "chat" | "work" | "context";
  activeScheme?: "manuscript" | null;
  activePath?: string | null;
  activeDocumentId?: string;
  onSetDraftId: (draftId: string | null) => void;
  exitInlineReview?: () => void;
  openContextRoute: OpenContextRoute;
}) {
  const [inline, updateInline] = useState<InlineReview | null>(null);
  setInline = updateInline;
  const review = useMemo(
    () =>
      ({
        controller: {
          workId: draft.workId,
          inlineReview: inline,
          exitInlineReview: exitInlineReview ?? vi.fn(),
        },
        drafts: { status: "ready" },
        files: [
          {
            documentId: draft.documentId,
            documentName: "A",
            contextPath: draft.contextPath,
            draft: {
              draftId: draft.draftId,
              documentId: draft.documentId,
              documentName: "A",
              contextPath: draft.contextPath,
              status: "active",
              updatedAt: "2026-10-02T00:00:00.000Z",
            },
          },
        ],
        fileForDocument: (documentId: string | null | undefined) =>
          listed && documentId === draft.documentId
            ? {
                documentId: draft.documentId,
                documentName: "A",
                contextPath: draft.contextPath,
                draft: { draftId: draft.draftId },
              }
            : null,
      }) as unknown as DraftReviewContextValue,
    [exitInlineReview, inline, listed],
  );
  return (
    <EditorReviewHandoffProvider projectId="project-1" openContextRoute={openContextRoute}>
      <CommandCapture />
      <ReviewAddressOwner
        review={review}
        presented={
          activeScreen === "context" || container === "dock"
            ? {
                container,
                documentId: activeDocumentId ?? null,
                scheme: activeScheme,
                path: activePath,
                draftOnly,
                review: requestedDraftId
                  ? { workId: draft.workId, draftId: requestedDraftId }
                  : null,
              }
            : null
        }
        port={{
          write: (address) => onSetDraftId(address?.draftId ?? null),
          admit: container === "dock" ? admit : (target) => openReview?.(target),
        }}
      />
    </EditorReviewHandoffProvider>
  );
}

describe("ReviewAddressOwner", () => {
  beforeEach(() => {
    openReview = null;
    setInline = null;
  });

  it("exits inline review when the address resolves to another document at the same path", async () => {
    const exit = vi.fn();
    await withReactRoot(
      <Harness
        activeDocumentId="document-b"
        onSetDraftId={vi.fn()}
        exitInlineReview={exit}
        openContextRoute={vi.fn(async () => ({ kind: "applied" as const }))}
      />,
      async () => {
        await act(async () =>
          setInline?.({ documentId: draft.documentId, draftId: draft.draftId }),
        );
        expect(exit).toHaveBeenCalledOnce();
      },
    );
  });

  describe("a review whose draft the list no longer names", () => {
    const finished = {
      documentId: draft.documentId,
      draftId: draft.draftId,
      completion: { phase: "closed" as const, documentName: "A" },
    };

    it("stays open on its document although the list no longer names it", async () => {
      const exit = vi.fn();
      await withReactRoot(
        <Harness
          listed={false}
          activeDocumentId={draft.documentId}
          requestedDraftId={draft.draftId}
          onSetDraftId={vi.fn()}
          exitInlineReview={exit}
          openContextRoute={vi.fn(async () => ({ kind: "applied" as const }))}
        />,
        async () => {
          await act(async () => setInline?.(finished));
          expect(exit).not.toHaveBeenCalled();
        },
      );
    });

    it("stays open while the address is still resolving", async () => {
      const exit = vi.fn();
      await withReactRoot(
        <Harness
          listed={false}
          onSetDraftId={vi.fn()}
          exitInlineReview={exit}
          openContextRoute={vi.fn(async () => ({ kind: "applied" as const }))}
        />,
        async () => {
          await act(async () => setInline?.(finished));
          expect(exit).not.toHaveBeenCalled();
        },
      );
    });

    it("still leaves when the writer goes to another document", async () => {
      const exit = vi.fn();
      await withReactRoot(
        <Harness
          listed={false}
          activePath="chapters/b.md"
          activeDocumentId="document-b"
          onSetDraftId={vi.fn()}
          exitInlineReview={exit}
          openContextRoute={vi.fn(async () => ({ kind: "applied" as const }))}
        />,
        async () => {
          await act(async () => setInline?.(finished));
          expect(exit).toHaveBeenCalledOnce();
        },
      );
    });

    it("an unfinished review whose draft left the list is left to the review's own list decision", async () => {
      const exit = vi.fn();
      const setDraftId = vi.fn();
      await withReactRoot(
        <Harness
          listed={false}
          activeDocumentId={draft.documentId}
          onSetDraftId={setDraftId}
          exitInlineReview={exit}
          openContextRoute={vi.fn(async () => ({ kind: "applied" as const }))}
        />,
        async () => {
          await act(async () =>
            setInline?.({ documentId: draft.documentId, draftId: draft.draftId }),
          );
          expect(exit).not.toHaveBeenCalled();
          expect(setDraftId).toHaveBeenLastCalledWith(draft.draftId);
          expect(setDraftId).not.toHaveBeenCalledWith(null);
        },
      );
    });
  });

  it("never writes a draft identity on a non-document screen", async () => {
    const exit = vi.fn();
    const setDraftId = vi.fn();
    await withReactRoot(
      <Harness
        activeScreen="chat"
        activeScheme={null}
        activePath={null}
        onSetDraftId={setDraftId}
        exitInlineReview={exit}
        openContextRoute={vi.fn(async () => ({ kind: "applied" as const }))}
      />,
      async () => {
        await act(async () =>
          setInline?.({ documentId: draft.documentId, draftId: draft.draftId }),
        );
        expect(exit).toHaveBeenCalledOnce();
        expect(setDraftId).not.toHaveBeenCalledWith(draft.draftId);
      },
    );
  });

  it("does not compete with its own pending same-document launch", async () => {
    let settle!: () => void;
    const route = new Promise<{ kind: "applied" }>((resolve) => {
      settle = () => resolve({ kind: "applied" });
    });
    const setDraftId = vi.fn();
    await withReactRoot(
      <Harness onSetDraftId={setDraftId} openContextRoute={vi.fn(() => route)} />,
      async () => {
        let pending: Promise<void> | undefined;
        await act(async () => {
          pending = openReview?.(draft);
          setInline?.({ documentId: draft.documentId, draftId: draft.draftId });
        });
        expect(setDraftId).not.toHaveBeenCalled();
        settle();
        await act(async () => pending);
      },
    );
  });

  it("keeps an open review while its address resolves, then follows the decision", async () => {
    const exit = vi.fn();
    let resolveAddress!: (documentId: string) => void;
    function Resolving() {
      const [documentId, setDocumentId] = useState<string>();
      resolveAddress = setDocumentId;
      return (
        <Harness
          activePath="chapters/renamed.md"
          activeDocumentId={documentId}
          onSetDraftId={vi.fn()}
          exitInlineReview={exit}
          openContextRoute={vi.fn(async () => ({ kind: "applied" as const }))}
        />
      );
    }
    await withReactRoot(<Resolving />, async () => {
      await act(async () => setInline?.({ documentId: draft.documentId, draftId: draft.draftId }));
      expect(exit).not.toHaveBeenCalled();
      await act(async () => resolveAddress(draft.documentId));
      expect(exit).not.toHaveBeenCalled();
      await act(async () => resolveAddress("document-b"));
      expect(exit).toHaveBeenCalledOnce();
    });
  });
});

it.each([
  false,
  true,
])("dock admission and Back to live respect intrinsic draft-only=%s", async (draftOnly) => {
  const admit = vi.fn();
  const write = vi.fn();
  const route = vi.fn(async () => ({ kind: "applied" as const }));
  await withReactRoot(
    <Harness
      container="dock"
      draftOnly={draftOnly}
      activeScreen="chat"
      activeDocumentId={draft.documentId}
      requestedDraftId={draft.draftId}
      admit={admit}
      onSetDraftId={write}
      openContextRoute={route}
    />,
    async () => {
      expect(admit).toHaveBeenCalledWith(
        expect.objectContaining({ documentId: draft.documentId, draftId: draft.draftId }),
      );
      expect(route).not.toHaveBeenCalled();
      await act(async () => setInline?.({ documentId: draft.documentId, draftId: draft.draftId }));
      await act(async () => setInline?.(null));
      if (draftOnly) expect(write).not.toHaveBeenCalledWith(null);
      else expect(write).toHaveBeenLastCalledWith(null);
    },
  );
});
