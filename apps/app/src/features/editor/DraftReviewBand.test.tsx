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
