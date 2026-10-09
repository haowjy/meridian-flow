// @vitest-environment jsdom
/**
 * The phone's review chrome: the header (switcher, stepper, count), the
 * selected change's bar, this document's change-list sheet, and the way the editor keeps
 * its place in the tree through all of it. The controller and the changes are
 * stubbed; what is asserted is what the writer can do by touch.
 */
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, useEffect, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { failDraftCommand, resetDraftCommandRecords } from "@/client/query/draft-command-record";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { ReviewChange } from "@/features/draft-review/review-changes";
import type { ReviewFileTarget } from "@/features/draft-review/review-files";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { MobileDocumentReview } from "./MobileDocumentReview";

const draft = (documentId: string, name: string, isNewDocument = false) =>
  ({
    documentId,
    documentName: name,
    contextPath: `/${name}.md`,
    isNewDocument,
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
  }) as unknown as ReviewFileTarget;
const groups = [draft("doc-12", "Chapter 12"), draft("doc-13", "Chapter 13")];

const change = (classId: string, overrides: Partial<ReviewChange> = {}): ReviewChange =>
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
    change: { removed: "his", added: `edit ${classId}` },
    attribution: { kind: "ai" },
    threadIds: [],
    ...overrides,
  }) as ReviewChange;

const controller = vi.hoisted(() => ({
  projectId: "p",
  workId: "w",
  dispositionLocked: false,
  isApplying: false,
  canApplyReviewedDraft: true,
  inlineReview: null as null | {
    documentId: string;
    draftId: string;
    shown: boolean;
    completion?: { phase: "pending" | "closed"; documentName: string | null };
  },
  marksVisible: true,
  setMarksVisible: vi.fn(),
  exitInlineReview: vi.fn(),
  apply: vi.fn(async () => ({ kind: "applied" })),
  discard: vi.fn(async () => ({ kind: "discarded" })),
  disposeDrafts: vi.fn(async () => []),
  toast: null as null | { id: number; code: string; tone: string },
  dismissToast: vi.fn(),
}));
const view = vi.hoisted(() => ({
  documentId: "doc-12",
  draftId: "draft-doc-12",
  status: "ready",
  items: [] as { change: ReviewChange; failure: unknown }[],
  focused: null as ReviewChange | null,
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
const launcher = vi.hoisted(() => ({ openReviewFile: vi.fn(), openAiDraft: vi.fn() }));
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
  useDraftReview: () => ({
    controller,
    groups,
    groupForDocument: (documentId: string) =>
      groups.find((group) => group.documentId === documentId) ?? null,
  }),
}));
vi.mock("@/features/draft-review/useReviewChanges", () => ({ useReviewChanges: () => view }));
vi.mock("../dock/useAiDraftLauncher", () => ({ useAiDraftLauncher: () => launcher }));
vi.mock("@/client/query/useWorks", () => ({ useWorks: () => ({ works: works.list }) }));
vi.mock("../routing/ProjectNavigationContext", () => ({ useOpenWork: () => openWork }));

const all = [change("c1"), change("c2", { includesWriterEdits: true }), change("c3")];

beforeEach(() => {
  resetDraftCommandRecords();
  Object.assign(controller, {
    inlineReview: { documentId: "doc-12", draftId: "draft-doc-12", shown: true },
    dispositionLocked: false,
    marksVisible: true,
    toast: null,
  });
  Object.assign(view, {
    status: "ready",
    items: all.map((c) => ({ change: c, failure: null })),
    focused: null,
    focusedIndex: -1,
    canApply: true,
    locked: false,
    finished: false,
    unlisted: false,
    completing: null as null | "apply" | "discard",
  });
  for (const fn of [
    controller.setMarksVisible,
    controller.exitInlineReview,
    controller.apply,
    controller.discard,
    controller.disposeDrafts,
    controller.dismissToast,
    view.focus,
    view.step,
    view.apply,
    view.discard,
    launcher.openReviewFile,
    launcher.openAiDraft,
    openWork,
  ])
    fn.mockClear();
  works.list = [{ id: "w", name: "Arc One", isNoWork: false }];
});

/** The stubs are plain objects: a test changes one, then clicks `[data-flip]` to re-render over it. */
let mutation: (() => void) | null = null;
function Flip({ render: body }: { render: () => React.ReactNode }) {
  const [, bump] = useState(0);
  return (
    <>
      <button
        type="button"
        data-flip
        onClick={() => {
          mutation?.();
          bump((n) => n + 1);
        }}
      />
      {body()}
    </>
  );
}
const flip = (change: () => void) => {
  mutation = change;
  return act(async () => document.querySelector<HTMLElement>("[data-flip]")?.click());
};

function render(
  run: () => Promise<void>,
  props: { onCloseDraftOnly?: () => void; editor?: React.ReactNode } = {},
) {
  i18n.loadAndActivate({ locale: "en", messages: {} });
  const { editor = <div data-editor />, ...rest } = props;
  return withReactRoot(
    <I18nProvider i18n={i18n}>
      <QueryClientProvider client={new QueryClient()}>
        <TooltipProvider>
          <Flip
            render={() => (
              <MobileDocumentReview documentId="doc-12" {...rest}>
                {editor}
              </MobileDocumentReview>
            )}
          />
        </TooltipProvider>
      </QueryClientProvider>
    </I18nProvider>,
    run,
  );
}

const named = (name: string) =>
  Array.from(
    document.querySelectorAll<HTMLElement>("button, [role=menuitem], [role=dialog] button"),
  ).find((node) => (node.getAttribute("aria-label") ?? node.textContent ?? "").trim() === name);
const header = () => document.querySelector("[data-phone-review-header]");
const bar = () => document.querySelector("[data-phone-change-bar]");
const sheet = () => document.querySelector("[data-phone-change-sheet]");

async function openSwitcher() {
  const trigger = document.querySelector<HTMLElement>("[data-slot=dropdown-menu-trigger]");
  await act(async () => {
    trigger?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
}
const menuItem = (text: string) =>
  Array.from(document.querySelectorAll<HTMLElement>("[role=menuitem]")).find((node) =>
    node.textContent?.includes(text),
  );

describe("the phone review header", () => {
  it("stays out of the way until the review is painted, and for another document", async () => {
    controller.inlineReview = { documentId: "doc-12", draftId: "draft-doc-12", shown: false };
    await render(async () => {
      expect(header()).toBeNull();
      expect(document.querySelector("[data-editor]")).not.toBeNull();
    });
    controller.inlineReview = { documentId: "doc-13", draftId: "draft-doc-13", shown: true };
    await render(async () => expect(header()).toBeNull());
  });

  it("offers the pending draft on the live document through the same version menu, and opens its review from it", async () => {
    controller.inlineReview = null;
    await render(async () => {
      const entry = document.querySelector("[data-phone-draft-entry]");
      expect(entry).not.toBeNull();
      expect(header()).toBeNull();
      const chip = entry?.querySelector<HTMLElement>("[data-draft-review-chip]");
      // The live document shows the same version chip and menu the review does.
      expect(chip?.textContent).toBe("Live");
      expect(chip?.getAttribute("aria-label")).toBe("Document version");
      await act(async () =>
        chip?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
      );
      const draftItem = Array.from(document.querySelectorAll<HTMLElement>("[role=menuitem]")).find(
        (node) => node.textContent === "Draft",
      );
      await act(async () => draftItem?.click());
      expect(launcher.openAiDraft).toHaveBeenCalledWith(
        expect.objectContaining({ workId: "w", documentId: "doc-12", draftId: "draft-doc-12" }),
      );
    });
  });

  it("applies the draft from the menu and moves on to the next draft at once", async () => {
    await render(async () => {
      await openSwitcher();
      await act(async () => menuItem("Apply draft")?.click());
      expect(controller.apply).toHaveBeenCalledWith("doc-12", "draft-doc-12");
      expect(launcher.openReviewFile).toHaveBeenCalledWith(
        expect.objectContaining({ documentId: "doc-13" }),
        "w",
      );
    });
    controller.apply.mockClear();
    launcher.openReviewFile.mockClear();
    await render(async () => {
      await openSwitcher();
      await act(async () => menuItem("Discard draft")?.click());
      expect(controller.discard).toHaveBeenCalledWith("doc-12", "draft-doc-12");
      expect(launcher.openReviewFile).toHaveBeenCalledOnce();
    });
  });

  it("closes a new document's review instead of returning to live", async () => {
    const onCloseDraftOnly = vi.fn();
    await render(
      async () => {
        await openSwitcher();
        expect(menuItem("Live version")).toBeUndefined();
        await act(async () => menuItem("Close review")?.click());
        expect(onCloseDraftOnly).toHaveBeenCalledOnce();
        expect(controller.exitInlineReview).not.toHaveBeenCalled();
      },
      { onCloseDraftOnly },
    );
  });

  it("shows a refused whole-draft command under the row, from the draft's own record", async () => {
    failDraftCommand(
      { projectId: "p", workId: "w", documentId: "doc-12", draftId: "draft-doc-12" },
      { code: "apply-offline" },
    );
    await render(async () => {
      expect(header()?.textContent).toContain("Couldn't apply");
    });
  });
});

describe("the selected change's bar", () => {
  it("appears only with a selected change, and acts on it", async () => {
    await render(async () => expect(bar()).toBeNull());
    view.focused = all[1];
    view.focusedIndex = 1;
    await render(async () => {
      expect(bar()?.textContent).toContain("Includes your edits");
      expect(bar()?.textContent).toContain("AI");
      await act(async () => named("Apply")?.click());
      expect(view.apply).toHaveBeenCalledWith(all[1]);
      await act(async () => named("Discard with your edits")?.click());
      expect(view.discard).toHaveBeenCalledWith(all[1]);
    });
  });

  it("hides Apply for a new document, disables while a command is in flight, and shows a refusal", async () => {
    view.focused = all[0];
    view.canApply = false;
    await render(async () => expect(named("Apply")).toBeUndefined());
    view.canApply = true;
    view.locked = true;
    await render(async () => {
      expect((named("Apply") as HTMLButtonElement).disabled).toBe(true);
    });
    view.locked = false;
    view.items = [{ change: all[0], failure: { phase: "failed", mode: "apply", code: "stale" } }];
    await render(async () => {
      expect(bar()?.textContent).toContain("This change was updated. Check it and apply again.");
    });
  });
});

describe("the change-list sheet", () => {
  it("opens from the count, lists every change, and a row closes it and jumps to the change", async () => {
    await render(async () => {
      expect(sheet()).toBeNull();
      await act(async () => named("Show the 3 changes")?.click());
      expect(sheet()).not.toBeNull();
      const rows = document.querySelectorAll("[data-review-change-row]");
      expect(rows).toHaveLength(3);
      await act(async () => (rows[1] as HTMLElement).click());
      expect(view.focus).toHaveBeenCalledWith(all[1], { scroll: true });
      expect(sheet()).toBeNull();
    });
  });

  it("applies and discards from a row without closing", async () => {
    await render(async () => {
      await act(async () => named("Show the 3 changes")?.click());
      const row = document.querySelector("[data-review-change-row]") as HTMLElement;
      await act(async () => (row.querySelector("[aria-label='Apply']") as HTMLElement).click());
      expect(view.apply).toHaveBeenCalledWith(all[0]);
      expect(sheet()).not.toBeNull();
    });
  });

  it("lists this document's changes only: no other draft, no Work-wide commands", async () => {
    await render(async () => {
      await act(async () => named("Show the 3 changes")?.click());
      const text = sheet()?.textContent ?? "";
      expect(document.querySelectorAll("[data-review-change-row]")).toHaveLength(3);
      for (const gone of [
        "Chapter 12",
        "Chapter 13",
        "drafts to review",
        "Apply all",
        "Discard all",
      ]) {
        expect(text).not.toContain(gone);
      }
      expect(named("All drafts")).toBeUndefined();
    });
  });

  it("ends in the way to the Work's Files tab, and closes as it goes", async () => {
    await render(async () => {
      await act(async () => named("Show the 3 changes")?.click());
      expect(sheet()?.textContent).toContain("All changes in Arc One");
      await act(async () => named("All changes in Arc One")?.click());
      // One transition to the Work's Files tab; the sheet gets out of the way.
      expect(openWork).toHaveBeenCalledExactlyOnceWith(
        { kind: "work-detail", workId: "w", view: "files" },
        { replace: false },
      );
      expect(sheet()).toBeNull();
    });
  });

  it("offers no link to a Work page in No Work", async () => {
    works.list = [];
    await render(async () => {
      await act(async () => named("Show the 3 changes")?.click());
      expect(sheet()).not.toBeNull();
      expect(sheet()?.textContent).not.toContain("All changes in");
    });
  });

  it("offers the next draft when this one is finished, and goes to it", async () => {
    Object.assign(view, { items: [], finished: true });
    await render(async () => {
      await act(async () => named("Show the changes list")?.click());
      expect(sheet()?.textContent).toContain("No changes left");
      const next = Array.from(sheet()?.querySelectorAll<HTMLElement>("button") ?? []).find(
        (node) => node.textContent === "Next draft",
      );
      await act(async () => next?.click());
      expect(launcher.openReviewFile).toHaveBeenCalledWith(
        expect.objectContaining({ documentId: "doc-13" }),
        "w",
      );
      expect(sheet()).toBeNull();
    });
  });

  it("shows the confirmation inside the sheet, where the scrim does not cover it", async () => {
    controller.toast = { id: 4, code: "applied", tone: "success" };
    await render(async () => {
      expect(document.querySelectorAll("[data-review-toast]")).toHaveLength(1);
      await act(async () => named("Show the 3 changes")?.click());
      const toasts = document.querySelectorAll("[data-review-toast]");
      expect(toasts).toHaveLength(1);
      expect(sheet()?.contains(toasts[0])).toBe(true);
    });
  });
});

describe("the editor's place", () => {
  it("is not remounted when the review opens or closes", async () => {
    const mounts = vi.fn();
    function Probe() {
      useEffect(() => {
        mounts();
      }, []);
      return <div data-editor />;
    }
    controller.inlineReview = null;
    await render(
      async () => {
        expect(header()).toBeNull();
        await flip(() => {
          controller.inlineReview = { documentId: "doc-12", draftId: "draft-doc-12", shown: true };
        });
        expect(header()).not.toBeNull();
        await flip(() => {
          controller.inlineReview = null;
        });
        expect(header()).toBeNull();
        expect(mounts).toHaveBeenCalledTimes(1);
      },
      { editor: <Probe /> },
    );
  });
});
