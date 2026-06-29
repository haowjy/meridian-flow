/**
 * @vitest-environment jsdom
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { acceptMutation, rejectMutation, draftPreview } = vi.hoisted(() => ({
  acceptMutation: { isPending: false, mutate: vi.fn() },
  rejectMutation: { isPending: false, mutate: vi.fn() },
  draftPreview: {
    live: "Original passage",
    previewMarkdown: "Revised passage",
    isFetching: false,
    isError: false,
  },
}));

vi.mock("@/client/query/useDraftReviewMutations", () => ({
  useAcceptDraft: () => acceptMutation,
  useRejectDraft: () => rejectMutation,
}));

vi.mock("@/client/query/useDraftPreview", () => ({
  useDraftPreview: () => draftPreview,
}));

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce(
      (result, part, index) =>
        `${result}${part}${index < values.length ? String(values[index]) : ""}`,
      "",
    ),
}));

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));

// React 19 requires this flag when using react-dom/test-utils-style act() directly.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

import type { ThreadDraftGroup } from "@/client/query/useThreadDrafts";
import { DraftPreviewOverlay } from "./DraftPreviewOverlay";
import { DraftReviewCard } from "./DraftReviewCard";

describe("draft review copy", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    acceptMutation.isPending = false;
    acceptMutation.mutate.mockReset();
    rejectMutation.isPending = false;
    rejectMutation.mutate.mockReset();
    draftPreview.live = "Original passage";
    draftPreview.previewMarkdown = "Revised passage";
    draftPreview.isFetching = false;
    draftPreview.isError = false;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("uses manuscript copy on the draft review card accept action", () => {
    act(() => {
      root.render(
        <DraftReviewCard threadId="thread-1" group={draftGroup()} onReview={() => undefined} />,
      );
    });

    expect(button("Apply to chapter")).toBeDefined();
    expect(container.textContent).toContain("Your live document is untouched until you accept.");
  });

  it("uses manuscript copy in the overlap preview affordance", () => {
    act(() => {
      root.render(
        <DraftPreviewOverlay
          threadId="thread-1"
          documentId="doc-1"
          documentName="Chapter 1"
          requireOverlapConfirm={true}
          onClose={() => undefined}
        />,
      );
    });

    expect(button("Apply to chapter")).toBeDefined();
    expect(container.textContent).toContain("you and the AI both edited this passage");
  });

  function button(name: string): HTMLButtonElement {
    const found = Array.from(container.querySelectorAll("button")).find(
      (candidate) => candidate.textContent?.trim() === name,
    );
    if (!(found instanceof HTMLButtonElement)) throw new Error(`Button not found: ${name}`);
    return found;
  }
});

function draftGroup(): ThreadDraftGroup {
  return {
    documentId: "doc-1",
    documentName: "Chapter 1",
    drafts: [
      {
        draftId: "draft-1",
        documentId: "doc-1",
        documentName: "Chapter 1",
        status: "active",
        lastActorTurnId: "turn-1",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  };
}
