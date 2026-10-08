// @vitest-environment jsdom
/**
 * The dock's Changes tab: one line per change of the review open in the
 * Editor. The dock sits in the Chat's boundary, so the list must read the
 * Editor scope's controller; reading the ambient one showed no review at all.
 */
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

const chatController = {
  projectId: "p",
  workId: "w",
  inlineReview: null,
  dispositionLocked: false,
  disposeDrafts: vi.fn(async () => []),
  which: "chat",
};
const editorController = {
  projectId: "p",
  workId: "w",
  inlineReview: { kind: "inline", documentId: "doc-12", draftId: "draft-doc-12" },
  exitInlineReview: vi.fn(),
  dispositionLocked: false,
  disposeDrafts: vi.fn(async () => []),
  which: "editor",
};
const groups = [group("doc-12", "Chapter 12"), group("doc-13", "Chapter 13")];
/** The Chat's scope: the Editor's Work unless a test puts the chat in another one. */
const chatScope = { groups };
vi.mock("@/client/query/useWorks", () => ({
  useWorks: () => ({
    works: [
      { id: "w", name: "Book One" },
      { id: "w2", name: "Side Quest" },
    ],
    noWork: { id: "no-work", name: "No Work" },
  }),
}));
vi.mock("@/features/chat/DraftReviewProvider", () => ({
  useDraftReview: () => ({ controller: chatController, groups: chatScope.groups }),
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
  editorController.disposeDrafts.mockClear();
  chatController.disposeDrafts.mockClear();
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

  it("keeps one file order and expands the open file in place, whichever file is open", async () => {
    groups.push(group("doc-11", "Chapter 11"), group("doc-20", "Interlude"));
    const order = () =>
      Array.from(document.querySelectorAll<HTMLElement>("[data-review-files] > *"))
        .map((node) => node.querySelector(".truncate")?.textContent ?? "")
        .filter((text) => /^(Chapter|Interlude)/.test(text));
    try {
      await render(async () => {
        expect(order()).toEqual(["Chapter 11", "Chapter 12", "Chapter 13", "Interlude"]);
        expect(document.querySelector("[data-review-file-open]")?.getAttribute("aria-label")).toBe(
          "Changes in Chapter 12",
        );
      });
      // Opening another file moves the expansion, not the list.
      editorController.inlineReview = {
        kind: "inline",
        documentId: "doc-13",
        draftId: "draft-doc-13",
      };
      await render(async () => {
        expect(order()).toEqual(["Chapter 11", "Chapter 12", "Chapter 13", "Interlude"]);
        expect(document.querySelector("[data-review-file-open]")?.getAttribute("aria-label")).toBe(
          "Changes in Chapter 13",
        );
      });
    } finally {
      groups.splice(2, 2);
      editorController.inlineReview = {
        kind: "inline",
        documentId: "doc-12",
        draftId: "draft-doc-12",
      };
    }
  });

  it("applies or discards every draft of the Work from the list's menu", async () => {
    await render(async () => {
      await act(async () =>
        button("All drafts")?.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
        ),
      );
      const item = (text: string) =>
        Array.from(document.querySelectorAll<HTMLElement>("[role=menuitem]")).find((node) =>
          node.textContent?.includes(text),
        );
      await act(async () => item("Apply all 2 drafts")?.click());
      expect(editorController.disposeDrafts).toHaveBeenCalledWith("apply", [
        { documentId: "doc-12", draftId: "draft-doc-12" },
        { documentId: "doc-13", draftId: "draft-doc-13" },
      ]);
      expect(openAiDraft).not.toHaveBeenCalled();
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

  it("counts the drafts it acts on, not the finished review it still shows", async () => {
    const open = editorController.inlineReview;
    editorController.inlineReview = {
      kind: "inline",
      documentId: "doc-9",
      draftId: "draft-doc-9",
      completion: { phase: "closed", documentName: "Chapter 9" },
    } as typeof open;
    Object.assign(view, { items: [], finished: true });
    try {
      await render(async () => {
        // Both files are listed (the finished one keeps its place) ...
        expect(document.body.textContent).toContain("Chapter 9");
        expect(document.body.textContent).toContain("Chapter 13");
        // ... but Apply all and Discard all act on the two listed drafts, and say so.
        expect(document.body.textContent).toContain("2 drafts to review");
      });
    } finally {
      editorController.inlineReview = open;
    }
  });

  describe("when the chat's Work is not the Editor's", () => {
    beforeEach(() => {
      chatController.workId = "w2";
      chatScope.groups = [group("doc-30", "Side chapter")];
    });
    afterEach(() => {
      chatController.workId = "w";
      chatScope.groups = groups;
    });

    it("lists each Work's drafts under its own name, with its own Apply all and Discard all", async () => {
      await render(async () => {
        const sections = Array.from(document.querySelectorAll<HTMLElement>("[data-review-files]"));
        expect(sections.map((node) => node.getAttribute("aria-label"))).toEqual([
          "Book One",
          "Side Quest",
        ]);
        expect(sections[0].textContent).toContain("Chapter 13");
        expect(sections[0].textContent).not.toContain("Side chapter");
        expect(sections[1].textContent).toContain("Side chapter");
        expect(sections[0].textContent).toContain("2 drafts to review");
        expect(sections[1].textContent).toContain("1 draft to review");
      });
    });

    it("sends each menu only the drafts of its own Work", async () => {
      await render(async () => {
        const menus = Array.from(
          document.querySelectorAll<HTMLButtonElement>("button[aria-label^='All drafts']"),
        );
        expect(menus).toHaveLength(2);
        await act(async () =>
          menus[1].dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
        );
        const apply = Array.from(document.querySelectorAll<HTMLElement>("[role=menuitem]")).find(
          (node) => node.textContent?.includes("Apply all 1 draft"),
        );
        await act(async () => apply?.click());
        expect(chatController.disposeDrafts).toHaveBeenCalledWith("apply", [
          { documentId: "doc-30", draftId: "draft-doc-30" },
        ]);
        expect(editorController.disposeDrafts).not.toHaveBeenCalled();
      });
    });
  });
});
