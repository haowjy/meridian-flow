import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DraftReviewContextValue } from "./DraftReviewProvider";
import type { DraftReviewController } from "./useDraftReviewController";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@lingui/core/macro", () => ({ t: (strings: TemplateStringsArray) => strings[0] }));

const { contextRef } = vi.hoisted(() => ({
  contextRef: { current: null as DraftReviewContextValue | null },
}));

vi.mock("./DraftReviewProvider", () => ({
  useDraftReview: () => {
    if (!contextRef.current) throw new Error("missing draft review context");
    return contextRef.current;
  },
}));
vi.mock("./useAiDraftLauncher", () => ({
  useAiDraftLauncher: () => ({ openAiDraft: vi.fn() }),
}));
vi.mock("@/client/query/useDraftPreview", () => ({
  useDraftPreview: () => ({
    preview: {
      status: "active",
      operations: [{ operationId: "op-1" }, { operationId: "op-2" }],
      hunks: [{ hunkId: "h1" }],
    },
  }),
}));

const { DraftReviewBar } = await import("./DraftReviewBar");

function controller(overrides: Partial<DraftReviewController> = {}): DraftReviewController {
  return {
    projectId: "project-1",
    workId: "work-1",
    threadId: "thread-1",
    inlineReview: { documentId: "doc-1", draftId: "draft-1" },
    overlap: null,
    staleDraft: null,
    staleDraftMessage: null,
    cannotPlaceDraft: null,
    isAccepting: false,
    isRejecting: false,
    isPending: false,
    isInlineDiscardPending: false,
    pendingInlineDiscardIds: () => new Set(),
    cannotPlaceInlineOperationIds: () => new Set(),
    confirmingAcceptOperationId: null,
    confirmingDiscardOperationId: null,
    inlineReviewMessage: null,
    inlineDiscardError: null,
    isOperationAccepting: false,
    isOperationUndoing: false,
    enterInlineReview: vi.fn(),
    exitInlineReview: vi.fn(),
    exitReview: vi.fn(),
    inlineReviewModelAvailable: vi.fn(),
    setInlineReviewRuntime: vi.fn(),
    confirmAcceptOperation: vi.fn(),
    cancelAcceptOperation: vi.fn(),
    acceptOperation: vi.fn(),
    undoAcceptOperation: vi.fn(),
    confirmDiscardOperation: vi.fn(),
    cancelDiscardOperation: vi.fn(),
    discardOperation: vi.fn(),
    accept: vi.fn(),
    reject: vi.fn(),
    ...overrides,
  };
}

function setContext(reviewController: DraftReviewController) {
  const draft = {
    draftId: "draft-1",
    documentId: "doc-1",
    documentName: "Chapter 1",
    contextPath: "/chapter-1",
    status: "active" as const,
    lastActorTurnId: "turn-1",
    updatedAt: "2026-07-04T00:00:00.000Z",
    appliedAt: null,
    discardedAt: null,
  };
  const group = {
    documentId: "doc-1",
    documentName: "Chapter 1",
    contextPath: "/chapter-1",
    drafts: [draft],
  };
  contextRef.current = {
    controller: reviewController,
    groups: [group],
    drafts: { status: "ready", groups: [group] },
    groupForDocument: () => group,
    reviewableDraftsForDocument: () => ({ visible: [draft], active: [draft] }),
    reviewableDraftsForGroup: () => ({ visible: [draft], active: [draft] }),
    nowMs: Date.parse("2026-07-04T00:01:00.000Z"),
    activeEditorDocumentId: "doc-1",
    setActiveEditorDocumentId: vi.fn(),
  } as unknown as DraftReviewContextValue;
}

describe("DraftReviewBar", () => {
  beforeEach(() => {
    contextRef.current = null;
  });

  it("removes Apply all and shows terminal guidance for active cannot_place drafts", () => {
    setContext(controller({ cannotPlaceDraft: { documentId: "doc-1", draftId: "draft-1" } }));

    const html = renderToStaticMarkup(<DraftReviewBar documentId="doc-1" />);

    expect(html).toContain("This draft can’t be placed automatically");
    expect(html).not.toContain("Apply all");
  });
});
