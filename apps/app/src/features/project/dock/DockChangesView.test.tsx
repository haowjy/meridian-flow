// @vitest-environment jsdom
/**
 * The dock's Changes tab: one line per change of the review open in the
 * Editor. The dock sits in the Chat's boundary, so the list must read the
 * Editor scope's controller; reading the ambient one showed no review at all.
 */
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import type { ReviewChange } from "@/features/draft-review/review-changes";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { DockChangesView } from "./DockChangesView";

const group = (documentId: string, name: string) => ({
  documentId,
  documentName: name,
  contextPath: `/${name}.md`,
  draft: {
    draftId: `draft-${documentId}`,
    documentId,
    documentName: name,
    contextPath: `/${name}.md`,
    status: "active" as const,
    lastActorTurnId: null,
    updatedAt: "2026-01-01T00:00:00Z",
    wordsAdded: 4,
    wordsRemoved: 0,
  },
});

const chatController = { projectId: "p", workId: "w", inlineReview: null, which: "chat" };
const editorController = {
  projectId: "p",
  workId: "w",
  inlineReview: { kind: "inline", documentId: "doc-12", draftId: "draft-doc-12" },
  exitInlineReview: vi.fn(),
  which: "editor",
};
const groups = [group("doc-12", "Chapter 12"), group("doc-13", "Chapter 13")];
vi.mock("@/features/chat/DraftReviewProvider", () => ({
  useDraftReview: () => ({ controller: chatController, groups }),
  useEditorDraftReview: () => ({ controller: editorController, groups }),
}));
vi.mock("@/client/query/draft-command-record", () => ({
  clearDraftCommandFailure: vi.fn(),
  draftCommandFailure: () => null,
  useDraftCommandRecords: () => ({}),
}));
const openAiDraft = vi.hoisted(() => vi.fn(async () => undefined));
// The launcher is real; the route-owned handoff behind it is what a Review entry calls.
vi.mock("./editor-review-handoff", () => ({ useOpenEditorReview: () => openAiDraft }));

const change = (
  classId: string,
  added: string,
  overrides: Partial<ReviewChange> = {},
): ReviewChange => ({
  classId,
  operations: [],
  operationIds: [classId],
  anchorOperationId: classId,
  markKeys: [classId],
  actionable: true,
  tone: "ai",
  includesWriterEdits: false,
  merged: false,
  change: { removed: null, added },
  attribution: { kind: "ai" },
  ...overrides,
});

const seen = vi.hoisted(() => ({ controllers: [] as unknown[] }));
const view = vi.hoisted(() => ({
  documentId: "doc-12",
  draftId: "draft-doc-12",
  status: "ready",
  items: [] as unknown[],
  focused: null as unknown,
  focusedIndex: -1,
  canApply: true,
  locked: false,
  finished: false,
  unlisted: false,
  completing: null as null | "apply" | "discard",
  focus: vi.fn(),
  step: vi.fn(),
  apply: vi.fn(async () => {}),
  discard: vi.fn(async () => {}),
}));
vi.mock("@/features/draft-review/useReviewChanges", () => ({
  useReviewChanges: (controller: unknown) => {
    seen.controllers.push(controller);
    return view;
  },
}));

function render(run: () => Promise<void>) {
  i18n.loadAndActivate({ locale: "en", messages: {} });
  return withReactRoot(
    <I18nProvider i18n={i18n}>
      <TooltipProvider>
        <DockChangesView />
      </TooltipProvider>
    </I18nProvider>,
    run,
  );
}

const button = (name: string) =>
  Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
    (candidate) => (candidate.getAttribute("aria-label") ?? candidate.textContent)?.trim() === name,
  );

beforeEach(() => {
  seen.controllers = [];
  openAiDraft.mockClear();
  for (const fn of [view.focus, view.apply, view.discard]) fn.mockClear();
  Object.assign(view, {
    status: "ready",
    items: [
      { change: change("c1", "one withered"), failure: null },
      { change: change("c2", "fell back", { includesWriterEdits: true }), failure: null },
    ],
    focused: null,
    finished: false,
    unlisted: false,
    completing: null as null | "apply" | "discard",
    locked: false,
  });
});

describe("DockChangesView", () => {
  it("lists the changes of the review open in the Editor, reading the Editor scope's controller", async () => {
    await render(async () => {
      expect(seen.controllers.every((controller) => controller === editorController)).toBe(true);
      expect(document.querySelectorAll("[data-review-change-row]")).toHaveLength(2);
      expect(document.body.textContent).toContain("2 changes");
      expect(document.body.textContent).toContain("Chapter 12");
    });
  });

  it("lists the Work's other drafts to open, and not the reviewed document again", async () => {
    await render(async () => {
      const rows = Array.from(document.querySelectorAll("button")).filter((node) =>
        node.textContent?.includes("Chapter 1"),
      );
      expect(rows.map((node) => node.textContent)).toEqual([expect.stringContaining("Chapter 13")]);
      await act(async () => rows[0].click());
      expect(openAiDraft).toHaveBeenCalledWith(
        expect.objectContaining({ documentId: "doc-13", draftId: "draft-doc-13" }),
      );
    });
  });

  it("focuses a change from its row, and acts on it from the row's two buttons", async () => {
    await render(async () => {
      const first = document.querySelector<HTMLElement>("[data-review-change-row='c1']");
      await act(async () => first?.click());
      expect(view.focus).toHaveBeenCalledWith(expect.objectContaining({ classId: "c1" }), {
        scroll: true,
      });
      await act(async () =>
        first?.querySelector<HTMLButtonElement>("[aria-label='Apply']")?.click(),
      );
      expect(view.apply).toHaveBeenCalledWith(expect.objectContaining({ classId: "c1" }));
      const second = document.querySelector<HTMLElement>("[data-review-change-row='c2']");
      await act(async () =>
        second?.querySelector<HTMLButtonElement>("[aria-label='Discard with your edits']")?.click(),
      );
      expect(view.discard).toHaveBeenCalledWith(expect.objectContaining({ classId: "c2" }));
    });
  });

  it("disables every row's commands together while one is in flight", async () => {
    view.locked = true;
    await render(async () => {
      const buttons = Array.from(
        document.querySelectorAll<HTMLButtonElement>("[data-review-change-row] button[aria-label]"),
      );
      expect(buttons.length).toBeGreaterThan(0);
      expect(buttons.every((node) => node.disabled)).toBe(true);
    });
  });

  it("says Applying, not No changes left, while the last change's command is in flight", async () => {
    Object.assign(view, { items: [], completing: "apply" });
    await render(async () => {
      expect(document.body.textContent).toContain("Applying");
      expect(document.body.textContent).not.toContain("No changes left");
      expect(button("Next draft")).toBeUndefined();
      expect(document.body.textContent).not.toContain("1 change");
    });
  });

  it("says Discarding while the last Discard is in flight", async () => {
    Object.assign(view, { items: [], completing: "discard" });
    await render(async () => {
      expect(document.body.textContent).toContain("Discarding");
    });
  });

  it("says formatting remains, not No changes left, when the draft is open and lists no change", async () => {
    Object.assign(view, { items: [], unlisted: true });
    await render(async () => {
      expect(document.body.textContent).toContain("Formatting changes remain");
      expect(document.body.textContent).not.toContain("No changes left");
      expect(button("Next draft")).toBeUndefined();
      expect(document.body.textContent).not.toContain("0 changes");
    });
  });

  it("when the last change is handled, says so and offers the next draft", async () => {
    Object.assign(view, { items: [], finished: true });
    await render(async () => {
      expect(document.body.textContent).toContain("No changes left");
      await act(async () => button("Next draft")?.click());
      expect(openAiDraft).toHaveBeenCalledWith(expect.objectContaining({ documentId: "doc-13" }));
    });
  });
});
