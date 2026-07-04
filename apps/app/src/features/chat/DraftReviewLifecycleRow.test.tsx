import { createRequire } from "node:module";
import type { ThreadDraftListItem } from "@meridian/contracts/drafts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DraftReviewController } from "./useDraftReviewController";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const { undoAcceptMutate } = vi.hoisted(() => ({ undoAcceptMutate: vi.fn() }));

vi.mock("@/client/query/useDraftReviewMutations", () => ({
  useUndoDraftAccept: () => ({ isPending: false, mutate: undoAcceptMutate }),
  useUndoDraftReject: () => ({ isPending: false, mutate: vi.fn() }),
}));

const require = createRequire(import.meta.url);
const { JSDOM } = require("jsdom") as {
  JSDOM: new (
    html: string,
  ) => {
    window: Window & typeof globalThis & { close: () => void };
  };
};

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
  threadId: "thread-1",
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
  beforeEach(() => {
    undoAcceptMutate.mockClear();
  });

  it("passes the controller's threadId when undoing an applied draft", () => {
    const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
    const previousWindow = globalThis.window;
    const previousDocument = globalThis.document;
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    try {
      const rootNode = dom.window.document.getElementById("root");
      if (!rootNode) throw new Error("missing root");
      const root = createRoot(rootNode);
      act(() => {
        root.render(
          <DraftReviewLifecycleRow
            draft={draft({ status: "applied", appliedAt: "2026-07-03T00:00:00.000Z" })}
            documentId="doc-1"
            documentName="Chapter 1"
            activeCount={0}
            controller={controller}
            nowMs={Date.parse("2026-07-03T00:05:00.000Z")}
            activeMode="review-only"
            activeReviewLabel="Open AI draft"
            terminalCopy="draft"
            onReview={vi.fn()}
          />,
        );
      });

      const undoButton = Array.from(rootNode.querySelectorAll("button")).find((button) =>
        button.getAttribute("aria-label")?.startsWith("Undo apply"),
      );
      expect(undoButton).toBeDefined();
      act(() => {
        undoButton?.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
      });

      expect(undoAcceptMutate).toHaveBeenCalledTimes(1);
      expect(undoAcceptMutate.mock.calls[0]?.[0]).toMatchObject({
        projectId: "project-1",
        workId: "work-1",
        threadId: "thread-1",
        documentId: "doc-1",
        draftId: "draft-1",
      });
      act(() => root.unmount());
    } finally {
      globalThis.window = previousWindow;
      globalThis.document = previousDocument;
      dom.window.close();
    }
  });

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
