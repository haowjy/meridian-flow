// @vitest-environment jsdom
/**
 * The review controls in the identity row: the Draft chip with its menu,
 * stepper, Show changes, Discard and Apply. Whole-draft commands move straight
 * to the next draft in the menu, or back to live when none is left.
 */
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { failDraftCommand, resetDraftCommandRecords } from "@/client/query/draft-command-record";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { ReviewChange } from "@/features/draft-review/review-changes";
import type { ReviewFileTarget } from "@/features/draft-review/review-files";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { DraftReviewBand, DraftReviewFailureNotices } from "./DraftReviewBand";

const draft = (documentId: string, name: string, isNewDocument = false) =>
  ({
    documentId,
    documentName: name,
    contextPath: `/${name}.md`,
    draft: {
      draftId: `draft-${documentId}`,
      documentId,
      documentName: name,
      contextPath: `/${name}.md`,
      status: "active",
      lastActorTurnId: null,
      actorThreads: [],
      updatedAt: "2026-01-01T00:00:00Z",
      wordsAdded: 3,
      wordsRemoved: 0,
      isNewDocument,
    },
  }) as const;

const groups = [
  draft("doc-12", "Chapter 12"),
  draft("doc-13", "Chapter 13"),
  draft("doc-int", "Interlude", true),
];

const controller = vi.hoisted(() => ({
  projectId: "p",
  workId: "w",
  isDisposing: false,
  dispositionLocked: false,
  isApplying: false,
  canApplyReviewedDraft: true,
  inlineReview: null as null | {
    completion?: { phase: "pending" | "closed"; documentName: string | null };
  },
  marksVisible: true,
  setMarksVisible: vi.fn(),
  exitInlineReview: vi.fn(),
  apply: vi.fn(async () => ({ kind: "applied" })),
  discard: vi.fn(async () => ({ kind: "discarded" })),
  disposeDrafts: vi.fn(async () => []),
}));
const view = vi.hoisted(() => ({
  documentId: "doc-12",
  draftId: "draft-doc-12",
  status: "ready",
  items: [{}, {}, {}, {}, {}, {}] as unknown[],
  focused: null,
  focusedIndex: 1,
  canApply: true,
  locked: false,
  finished: false,
  unlisted: false,
  completing: null as null | "apply" | "discard",
  step: vi.fn(),
  focus: vi.fn(),
  apply: vi.fn(async () => {}),
  discard: vi.fn(async () => {}),
}));
const openWork = vi.hoisted(() => vi.fn(async () => undefined));
/** The project's Works: the document's own Work is "w"; No Work is not among them. */
const works = vi.hoisted(() => ({
  list: [{ id: "w", name: "Arc One", isNoWork: false }] as {
    id: string;
    name: string;
    isNoWork: boolean;
  }[],
}));
vi.mock("@/features/draft-review/DraftReviewProvider", () => ({
  useDraftReview: () => ({ controller, groups }),
}));
vi.mock("@/features/draft-review/useReviewChanges", () => ({ useReviewChanges: () => view }));
vi.mock("@/client/query/useWorks", () => ({ useWorks: () => ({ works: works.list }) }));
vi.mock("@/features/project/routing/ProjectNavigationContext", () => ({
  useOpenWork: () => openWork,
}));

function render(
  props: Partial<React.ComponentProps<typeof DraftReviewBand>>,
  run: () => Promise<void>,
  documentId = "doc-12",
) {
  i18n.loadAndActivate({ locale: "en", messages: {} });
  return withReactRoot(
    <I18nProvider i18n={i18n}>
      <QueryClientProvider client={new QueryClient()}>
        <TooltipProvider>
          <div className="flex">
            <DraftReviewBand
              documentId={documentId}
              draftId={`draft-${documentId}`}
              onOpenDraft={vi.fn()}
              {...props}
            />
          </div>
          <DraftReviewFailureNotices
            documentId={documentId}
            draftId={`draft-${documentId}`}
            onOpenDraft={props.onOpenDraft ?? vi.fn()}
          />
        </TooltipProvider>
      </QueryClientProvider>
    </I18nProvider>,
    run,
  );
}

const byText = (text: string) =>
  Array.from(document.querySelectorAll<HTMLElement>("button, [role=menuitem]")).find(
    (node) => (node.getAttribute("aria-label") ?? node.textContent)?.trim() === text,
  );

async function openSwitcher() {
  const trigger = document.querySelector<HTMLElement>("[data-slot=dropdown-menu-trigger]");
  await act(async () => {
    trigger?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
}

beforeEach(() => {
  resetDraftCommandRecords();
  Object.assign(controller, {
    dispositionLocked: false,
    inlineReview: null,
    marksVisible: true,
  });
  Object.assign(view, {
    status: "ready",
    items: [{}, {}, {}, {}, {}, {}],
    focusedIndex: 1,
    finished: false,
    unlisted: false,
    completing: null as null | "apply" | "discard",
    locked: false,
  });
  for (const fn of [
    controller.apply,
    controller.discard,
    controller.disposeDrafts,
    controller.exitInlineReview,
    controller.setMarksVisible,
    view.step,
    view.focus,
    view.apply,
    view.discard,
    openWork,
  ]) {
    fn.mockClear();
  }
  works.list = [{ id: "w", name: "Arc One", isNoWork: false }];
});

describe("DraftReviewBand", () => {
  it("is the Draft chip, stepper, Show changes, Discard draft and Apply draft, under their full names", async () => {
    await render({}, async () => {
      const text = document.body.textContent ?? "";
      // The document's name is the breadcrumb's; the chip says only what this is.
      expect(text).not.toContain("Chapter 12");
      expect(byText("Document version")?.textContent).toBe("Draft");
      expect(text).toContain("2 of 6");
      expect(document.querySelector("[role=switch]")?.getAttribute("aria-label")).toBe(
        "Show changes",
      );
      // Whole-draft commands name their scope; only the narrowest row shortens them.
      const labels = (name: string) =>
        [...(byText(name)?.querySelectorAll("span") ?? [])].map((span) => span.textContent);
      expect(labels("Discard draft")).toEqual(["Discard draft", "Discard"]);
      expect(labels("Apply draft")).toEqual(["Apply draft", "Apply"]);
      expect(document.querySelector("[aria-label='Next change']")).not.toBeNull();
    });
  });

  it("carries Rename in the chip's menu only when the document can be renamed", async () => {
    const onRename = vi.fn();
    await render({ onRename }, async () => {
      await openSwitcher();
      await act(async () => byText("Rename")?.click());
      // Rename runs from the menu's close-focus callback, after Radix finishes closing.
      await vi.waitFor(() => expect(onRename).toHaveBeenCalledOnce());
    });
    await render({}, async () => {
      await openSwitcher();
      expect(byText("Rename")).toBeUndefined();
    });
  });

  it("steps through the changes and toggles Show changes", async () => {
    await render({}, async () => {
      await act(async () =>
        document.querySelector<HTMLButtonElement>("[aria-label='Next change']")?.click(),
      );
      expect(view.step).toHaveBeenCalledWith(1);
      const toggle = document.querySelector<HTMLButtonElement>("[role=switch]");
      expect(toggle?.getAttribute("aria-checked")).toBe("true");
      await act(async () => toggle?.click());
      expect(controller.setMarksVisible).toHaveBeenCalledWith(false);
    });
  });

  it("lists this document's versions only: live and its draft, with no other file", async () => {
    await render({}, async () => {
      await openSwitcher();
      const menu = document.querySelector("[role=menu]")?.textContent ?? "";
      expect(menu).toContain("Live version");
      expect(menu).toContain("Draft");
      for (const gone of [
        "Chapter 13",
        "Interlude",
        "11 changes",
        "New document",
        "Apply all",
        "Discard all",
      ]) {
        expect(menu).not.toContain(gone);
      }
    });
  });

  it("shows the live version from the menu, and closes review for a draft-only document", async () => {
    await render({}, async () => {
      await openSwitcher();
      await act(async () => byText("Live version")?.click());
      expect(controller.exitInlineReview).toHaveBeenCalledOnce();
    });
    const close = vi.fn();
    controller.exitInlineReview.mockClear();
    await render(
      { onCloseDraftOnly: close },
      async () => {
        await openSwitcher();
        expect(byText("Live version")).toBeUndefined();
        await act(async () => byText("Close review")?.click());
        expect(close).toHaveBeenCalledOnce();
        expect(controller.exitInlineReview).not.toHaveBeenCalled();
      },
      "doc-int",
    );
  });

  it("Apply draft goes on to the next draft in the switcher at once", async () => {
    const onOpenDraft = vi.fn();
    await render({ onOpenDraft }, async () => {
      await act(async () => byText("Apply draft")?.click());
      expect(controller.apply).toHaveBeenCalledWith("doc-12", "draft-doc-12");
      expect((onOpenDraft.mock.calls[0][0] as ReviewFileTarget).documentId).toBe("doc-13");
    });
  });

  it("Discard draft does the same", async () => {
    const onOpenDraft = vi.fn();
    await render({ onOpenDraft }, async () => {
      await act(async () => byText("Discard draft")?.click());
      expect(controller.discard).toHaveBeenCalledWith("doc-12", "draft-doc-12");
      expect(onOpenDraft).toHaveBeenCalledOnce();
    });
  });

  it("with no other draft left, Apply draft opens nothing: the review returns to live by itself", async () => {
    groups.splice(1, 2);
    try {
      const onOpenDraft = vi.fn();
      await render({ onOpenDraft }, async () => {
        await act(async () => byText("Apply draft")?.click());
        expect(controller.apply).toHaveBeenCalledOnce();
        expect(onOpenDraft).not.toHaveBeenCalled();
      });
    } finally {
      groups.push(draft("doc-13", "Chapter 13"), draft("doc-int", "Interlude", true));
    }
  });

  it("disables the commands while one is in flight, and sends nothing", async () => {
    controller.dispositionLocked = true;
    const onOpenDraft = vi.fn();
    await render({ onOpenDraft }, async () => {
      expect((byText("Apply draft") as HTMLButtonElement).disabled).toBe(true);
      expect((byText("Discard draft") as HTMLButtonElement).disabled).toBe(true);
      await act(async () => byText("Apply draft")?.click());
      expect(controller.apply).not.toHaveBeenCalled();
      expect(onOpenDraft).not.toHaveBeenCalled();
    });
  });

  it("when the last change is handled, says so and offers the next draft without jumping", async () => {
    Object.assign(view, { items: [], finished: true });
    const onOpenDraft = vi.fn();
    await render({ onOpenDraft }, async () => {
      expect(document.body.textContent).toContain("No changes left");
      expect(onOpenDraft).not.toHaveBeenCalled();
      await act(async () => byText("Next draft")?.click());
      expect((onOpenDraft.mock.calls[0][0] as ReviewFileTarget).documentId).toBe("doc-13");
      // Nothing is left to publish: the draft's own commands go with the changes.
      expect(byText("Apply draft")).toBeUndefined();
      expect(byText("Discard draft")).toBeUndefined();
      // The stepper has nothing to step through.
      expect(document.querySelector("[aria-label='Next change']")).toBeNull();
    });
  });

  it("says formatting remains, not No changes left, and keeps Apply draft and Discard draft", async () => {
    Object.assign(view, { items: [], unlisted: true });
    const onOpenDraft = vi.fn();
    await render({ onOpenDraft }, async () => {
      expect(document.body.textContent).toContain("Formatting changes remain");
      expect(document.body.textContent).not.toContain("No changes left");
      expect(byText("Next draft")).toBeUndefined();
      await act(async () => byText("Discard draft")?.click());
      expect(controller.discard).toHaveBeenCalledWith("doc-12", "draft-doc-12");
      expect(onOpenDraft).toHaveBeenCalled();
    });
  });

  it("holds on No changes left after the server closed the draft and the list lost it", async () => {
    // The closed draft is no longer among the Work's drafts; the review itself says it finished.
    const closed = groups.splice(0, 1);
    Object.assign(view, { items: [], finished: true });
    controller.inlineReview = { completion: { phase: "closed", documentName: "Chapter 12" } };
    const onOpenDraft = vi.fn();
    try {
      await render({ onOpenDraft }, async () => {
        expect(document.body.textContent).toContain("No changes left");
        expect(controller.exitInlineReview).not.toHaveBeenCalled();
        await act(async () => byText("Next draft")?.click());
        expect((onOpenDraft.mock.calls[0][0] as ReviewFileTarget).documentId).toBe("doc-13");
      });
    } finally {
      groups.unshift(...closed);
    }
  });

  it("Next draft follows the file order from where the closed draft stood, not from the top", async () => {
    // Chapter 13's draft is gone from the list: the next file after it is Interlude, not Chapter 12.
    const closed = groups.splice(1, 1);
    Object.assign(view, { items: [], finished: true });
    controller.inlineReview = { completion: { phase: "closed", documentName: "Chapter 13" } };
    const onOpenDraft = vi.fn();
    try {
      await render(
        { onOpenDraft },
        async () => {
          await act(async () => byText("Next draft")?.click());
          expect((onOpenDraft.mock.calls[0][0] as ReviewFileTarget).documentId).toBe("doc-int");
        },
        "doc-13",
      );
    } finally {
      groups.splice(1, 0, ...closed);
    }
  });

  it("offers the way back to live when no other draft is left", async () => {
    const all = groups.splice(0, groups.length);
    Object.assign(view, { items: [], finished: true });
    controller.inlineReview = { completion: { phase: "closed", documentName: "Chapter 12" } };
    try {
      await render({}, async () => {
        expect(document.body.textContent).toContain("No changes left");
        expect(byText("Next draft")).toBeUndefined();
        await act(async () => byText("Back to live")?.click());
        expect(controller.exitInlineReview).toHaveBeenCalledOnce();
      });
    } finally {
      groups.push(...all);
    }
  });

  it("shows a failed whole-draft command on the header, from the draft's own record", async () => {
    failDraftCommand(
      { projectId: "p", workId: "w", documentId: "doc-12", draftId: "draft-doc-12" },
      { code: "apply-offline" },
    );
    await render({}, async () => {
      expect(document.querySelector("[role=alert]")?.textContent).toContain("Couldn't apply");
    });
  });

  it("says Applying, not No changes left, while the last change's command is in flight", async () => {
    Object.assign(view, { items: [], completing: "apply" });
    controller.dispositionLocked = true;
    await render({}, async () => {
      const text = document.body.textContent ?? "";
      expect(text).toContain("Applying");
      expect(text).not.toContain("No changes left");
      expect(byText("Next draft")).toBeUndefined();
      // Not finished: the draft's own commands stay, held by the lock.
      expect((byText("Apply draft") as HTMLButtonElement).disabled).toBe(true);
    });
  });

  it("says Discarding while the last Discard is in flight", async () => {
    Object.assign(view, { items: [], completing: "discard" });
    await render({}, async () => {
      expect(document.body.textContent).toContain("Discarding");
      expect(document.body.textContent).not.toContain("No changes left");
    });
  });

  it("says which other draft did not apply, on the header the writer was moved to, and opens it on request", async () => {
    failDraftCommand(
      { projectId: "p", workId: "w", documentId: "doc-13", draftId: "draft-doc-13" },
      { code: "apply-offline" },
    );
    const onOpenDraft = vi.fn();
    await render({ onOpenDraft }, async () => {
      const alert = document.querySelector("[role=alert]");
      expect(alert?.textContent).toContain("Chapter 13");
      expect(alert?.textContent).toContain("Couldn't apply. Check your connection and try again.");
      // Nothing navigates back by itself; the writer chooses to.
      expect(onOpenDraft).not.toHaveBeenCalled();
      await act(async () => byText("Open")?.click());
      expect(onOpenDraft).toHaveBeenCalledWith(expect.objectContaining({ documentId: "doc-13" }));
    });
  });
});

const change = (classId: string, overrides: Partial<ReviewChange> = {}) =>
  ({
    classId,
    operations: [],
    operationIds: [classId],
    anchorOperationId: classId,
    markKeys: [classId],
    actionable: true,
    tone: "ai",
    includesWriterEdits: false,
    merged: false,
    change: { removed: null, added: `edit ${classId}` },
    attribution: { kind: "ai" },
    threadIds: [],
    ...overrides,
  }) as ReviewChange;
const changes = [change("c1"), change("c2"), change("c3")];
const withChanges = () => {
  Object.assign(view, {
    items: changes.map((item) => ({ change: item, failure: null })),
    focusedIndex: 0,
  });
};

const listButton = () =>
  document.querySelector<HTMLButtonElement>(
    "[data-draft-review-controls] [data-slot=popover-trigger]",
  );
const list = () => document.querySelector<HTMLElement>("[data-draft-change-list]");
const openList = () => act(async () => listButton()?.click());
const rowButton = (classId: string) =>
  document.querySelector<HTMLElement>(`[data-review-change-row="${classId}"] button`);

describe("the document's change list", () => {
  const states: [string, Record<string, unknown>][] = [
    ["ready", { items: changes.map((item) => ({ change: item, failure: null })) }],
    ["loading", { status: "loading", items: [] }],
    ["formatting only", { items: [], unlisted: true }],
    ["finished", { items: [], finished: true }],
    ["applying the last change", { items: [], completing: "apply" }],
  ];
  for (const [name, state] of states) {
    it(`has its button when the review is ${name}, which the stepper needs a change to have`, async () => {
      Object.assign(view, state);
      await render({}, async () => {
        expect(listButton()).not.toBeNull();
        expect(list()).toBeNull();
        await openList();
        expect(list()).not.toBeNull();
      });
    });
  }

  it("has its button, and opens, while the changes are hidden in the text", async () => {
    controller.marksVisible = false;
    withChanges();
    await render({}, async () => {
      // The stepper has nothing to step through; the list does not depend on the marks.
      expect(
        document.querySelector<HTMLButtonElement>("[aria-label='Next change']")?.disabled,
      ).toBe(true);
      expect(listButton()?.disabled).toBe(false);
      await openList();
      expect(list()?.querySelectorAll("[data-review-change-row]")).toHaveLength(3);
    });
  });

  it("is named by what it lists: the count, or the list itself", async () => {
    await render({}, async () => {
      expect(listButton()?.getAttribute("aria-label")).toBe("Show the 6 changes");
    });
    Object.assign(view, { items: [], finished: true });
    await render({}, async () => {
      expect(listButton()?.getAttribute("aria-label")).toBe("Show the changes list");
    });
  });

  it("lists this document's changes with the way to the Work's files at its foot", async () => {
    withChanges();
    await render({}, async () => {
      await openList();
      expect(list()?.querySelectorAll("[data-review-change-row]")).toHaveLength(3);
      const text = list()?.textContent ?? "";
      expect(text).toContain("All changes in Arc One");
      // Only this document: no other file, no Work-wide command.
      for (const gone of ["Chapter 13", "Interlude", "Apply all", "Discard all"]) {
        expect(text).not.toContain(gone);
      }
    });
  });

  it("says what stands in for the changes: finished, formatting only", async () => {
    Object.assign(view, { items: [], finished: true });
    await render({}, async () => {
      await openList();
      expect(list()?.textContent).toContain("No changes left");
      expect(list()?.textContent).toContain("All changes in Arc One");
    });
    Object.assign(view, { items: [], finished: false, unlisted: true });
    await render({}, async () => {
      await openList();
      expect(list()?.textContent).toContain("Formatting changes remain");
    });
  });

  it("focuses the change and closes when a row is chosen", async () => {
    withChanges();
    await render({}, async () => {
      await openList();
      await act(async () => rowButton("c2")?.click());
      expect(view.focus).toHaveBeenCalledWith(changes[1], { scroll: true });
      expect(list()).toBeNull();
    });
  });

  it("applies and discards from a row and stays open", async () => {
    withChanges();
    await render({}, async () => {
      await openList();
      const row = document.querySelector<HTMLElement>('[data-review-change-row="c1"]');
      await act(async () => row?.querySelector<HTMLElement>("[aria-label='Apply']")?.click());
      expect(view.apply).toHaveBeenCalledWith(changes[0]);
      await act(async () => row?.querySelector<HTMLElement>("[aria-label='Discard']")?.click());
      expect(view.discard).toHaveBeenCalledWith(changes[0]);
      expect(list()).not.toBeNull();
      expect(view.focus).not.toHaveBeenCalled();
    });
  });

  it("goes to the Work's Files tab in one transition from the foot, and closes", async () => {
    withChanges();
    await render({}, async () => {
      await openList();
      await act(async () => byText("All changes in Arc One")?.click());
      expect(openWork).toHaveBeenCalledExactlyOnceWith(
        { kind: "work-detail", workId: "w", view: "files" },
        { replace: false },
      );
      expect(list()).toBeNull();
    });
  });

  it("has no foot link in No Work, which has no Work page", async () => {
    works.list = [];
    withChanges();
    await render({}, async () => {
      await openList();
      expect(list()?.querySelectorAll("[data-review-change-row]")).toHaveLength(3);
      expect(list()?.textContent).not.toContain("All changes in");
    });
  });

  it("opens the next draft from its finished state and closes", async () => {
    Object.assign(view, { items: [], finished: true });
    const onOpenDraft = vi.fn();
    await render({ onOpenDraft }, async () => {
      await openList();
      const next = Array.from(list()?.querySelectorAll<HTMLElement>("button") ?? []).find(
        (node) => node.textContent === "Next draft",
      );
      await act(async () => next?.click());
      expect((onOpenDraft.mock.calls[0][0] as ReviewFileTarget).documentId).toBe("doc-13");
      expect(list()).toBeNull();
    });
  });
});
