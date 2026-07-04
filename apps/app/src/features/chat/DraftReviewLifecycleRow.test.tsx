import type { ThreadDraftListItem } from "@meridian/contracts/drafts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { DraftReviewController } from "./useDraftReviewController";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("@/client/query/useDraftReviewMutations", () => ({
  useUndoDraftAccept: () => ({ isPending: false, mutate: vi.fn() }),
  useUndoDraftReject: () => ({ isPending: false, mutate: vi.fn() }),
}));

const { DraftReviewLifecycleRow } = await import("./DraftReviewLifecycleRow");

function draft(input: Partial<ThreadDraftListItem> = {}): ThreadDraftListItem {
  return {
    draftId: "draft-1",
    documentId: "doc-1",
    documentName: "Chapter 1",
    contextPath: "/chapter-1",
    status: "active",
    lastActorTurnId: "turn-1",
    updatedAt: "2026-07-03T00:00:00.000Z",
    appliedAt: null,
    discardedAt: null,
    ...input,
  };
}

const controller = {
  projectId: "project-1",
  workId: "work-1",
  isPending: false,
  isAccepting: false,
  accept: vi.fn(),
  reject: vi.fn(),
} as unknown as DraftReviewController;

function renderRow(rowDraft: ThreadDraftListItem): string {
  return renderToStaticMarkup(
    <DraftReviewLifecycleRow
      draft={rowDraft}
      documentId="doc-1"
      documentName="Chapter 1"
      activeCount={1}
      controller={controller}
      nowMs={Date.parse("2026-07-03T00:05:00.000Z")}
      activeMode="review-only"
      activeReviewLabel="Open AI draft"
      terminalCopy="draft"
      onReview={vi.fn()}
    />,
  );
}

describe("DraftReviewLifecycleRow", () => {
  it("renders a singular durable undo label for one active partial accept", () => {
    const html = renderRow(draft({ partialAcceptedOperationCount: 1, proposedOperationCount: 3 }));

    expect(html).toContain("Undo accepted proposal — Chapter 1");
    expect(html).toContain("Open AI draft");
  });

  it("renders a bulk durable undo label for multiple active partial accepts", () => {
    const html = renderRow(draft({ partialAcceptedOperationCount: 3, proposedOperationCount: 3 }));

    expect(html).toContain("Undo 3 accepted proposals — Chapter 1");
    expect(html).toContain("Open AI draft");
  });

  it("keeps applied draft undo wording unchanged", () => {
    const html = renderRow(
      draft({
        status: "applied",
        appliedAt: "2026-07-03T00:00:00.000Z",
        partialAcceptedOperationCount: null,
      }),
    );

    expect(html).toContain("Undo apply — Chapter 1");
    expect(html).not.toContain("accepted proposal");
  });
});
