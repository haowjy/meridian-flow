// @vitest-environment jsdom
/** Address ownership keeps inline review and Editor history on one document. */
import { act, useEffect, useMemo, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DraftReviewContextValue } from "@/features/chat/DraftReviewProvider";
import { withReactRoot } from "@/test-support/react-dom-harness";
import type { OpenContextRoute } from "../routing/ProjectNavigationContext";
import { EditorReviewAddressOwner } from "./EditorReviewAddressOwner";
import {
  type AiDraftLaunchTarget,
  EditorReviewHandoffProvider,
  useOpenEditorReview,
} from "./editor-review-handoff";

const draft: AiDraftLaunchTarget = {
  workId: "work-1",
  documentId: "document-a",
  draftId: "draft-a",
  contextPath: "chapters/a.md",
};
let openReview: ((target: AiDraftLaunchTarget) => Promise<void>) | null = null;
let setInline: ((inline: { documentId: string; draftId: string } | null) => void) | null = null;

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
}: {
  requestedDraftId?: string;
  activeScreen?: "chat" | "work" | "context";
  activeScheme?: "manuscript" | null;
  activePath?: string | null;
  activeDocumentId?: string;
  onSetDraftId: (draftId: string | null) => void;
  exitInlineReview?: () => void;
  openContextRoute: OpenContextRoute;
}) {
  const [inline, updateInline] = useState<{ documentId: string; draftId: string } | null>(null);
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
        groups: [
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
        groupForDocument: (documentId: string | null | undefined) =>
          documentId === draft.documentId
            ? {
                documentId: draft.documentId,
                documentName: "A",
                contextPath: draft.contextPath,
                draft: { draftId: draft.draftId },
              }
            : null,
      }) as unknown as DraftReviewContextValue,
    [exitInlineReview, inline],
  );
  return (
    <EditorReviewHandoffProvider projectId="project-1" openContextRoute={openContextRoute}>
      <CommandCapture />
      <EditorReviewAddressOwner
        review={review}
        requestedDraftId={requestedDraftId}
        activeScreen={activeScreen}
        activeScheme={activeScheme}
        activePath={activePath}
        activeDocumentId={activeDocumentId}
        onSetDraftId={onSetDraftId}
      />
    </EditorReviewHandoffProvider>
  );
}

describe("EditorReviewAddressOwner", () => {
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
