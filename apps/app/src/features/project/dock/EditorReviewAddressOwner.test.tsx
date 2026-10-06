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

  it("restores a valid draft from a matching Editor address", async () => {
    const navigate = vi.fn(async () => ({ kind: "applied" as const }));
    await withReactRoot(
      <Harness
        requestedDraftId={draft.draftId}
        onSetDraftId={vi.fn()}
        openContextRoute={navigate}
      />,
      async () => {
        await act(async () => undefined);
        expect(navigate).toHaveBeenCalledWith(
          expect.objectContaining({ documentId: draft.documentId }),
          expect.objectContaining({ draftId: draft.draftId, replaceIfSameDocument: true }),
        );
      },
    );
  });

  it("clears a stale draft identity", async () => {
    const setDraftId = vi.fn();
    await withReactRoot(
      <Harness
        requestedDraftId="stale"
        onSetDraftId={setDraftId}
        openContextRoute={vi.fn(async () => ({ kind: "applied" as const }))}
      />,
      async () => expect(setDraftId).toHaveBeenCalledWith(null),
    );
  });

  it("exits inline review after navigating to another document", async () => {
    const exit = vi.fn();
    const setDraftId = vi.fn();
    await withReactRoot(
      <Harness
        activePath="chapters/b.md"
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

  it("keeps an open review and its draft identity when its document is renamed", async () => {
    const exit = vi.fn();
    const setDraftId = vi.fn();
    await withReactRoot(
      <Harness
        requestedDraftId={draft.draftId}
        activePath="chapters/renamed.md"
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
        expect(setDraftId).not.toHaveBeenCalled();
      },
    );
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
});
