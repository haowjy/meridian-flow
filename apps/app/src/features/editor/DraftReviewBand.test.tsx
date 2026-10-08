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
import type { DockRow } from "@/features/chat/docked-drafts";
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
  status: "ready",
  items: [{}, {}, {}, {}, {}, {}] as unknown[],
  focusedIndex: 1,
  finished: false,
  unlisted: false,
  completing: null as null | "apply" | "discard",
  step: vi.fn(),
}));
vi.mock("@/features/chat/DraftReviewProvider", () => ({
  useDraftReview: () => ({ controller, groups }),
}));
vi.mock("@/features/draft-review/useReviewChanges", () => ({ useReviewChanges: () => view }));
vi.mock("@/features/draft-review/useDraftChangeCounts", () => ({
  useDraftChangeCounts: () => new Map([["doc-13", 11]]),
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
  });
  for (const fn of [
    controller.apply,
    controller.discard,
    controller.disposeDrafts,
    controller.exitInlineReview,
    controller.setMarksVisible,
    view.step,
  ]) {
    fn.mockClear();
  }
});

describe("DraftReviewBand", () => {
  it("is the Draft chip, stepper, Show changes, Discard and Apply, under their full names", async () => {
    await render({}, async () => {
      const text = document.body.textContent ?? "";
      // The document's name is the breadcrumb's; the chip says only what this is.
      expect(text).not.toContain("Chapter 12");
      expect(byText("Draft version")?.textContent).toBe("Draft");
      expect(text).toContain("2 of 6");
      expect(document.querySelector("[role=switch]")?.getAttribute("aria-label")).toBe(
        "Show changes",
      );
      expect(byText("Discard draft")?.textContent).toBe("Discard");
      expect(byText("Apply draft")?.textContent).toBe("Apply");
      expect(document.querySelector("[aria-label='Next change']")).not.toBeNull();
    });
  });

  it("carries Rename in the chip's menu only when the document can be renamed", async () => {
    const onRename = vi.fn();
    await render({ onRename }, async () => {
      await openSwitcher();
      await act(async () => byText("Rename")?.click());
      expect(onRename).toHaveBeenCalledOnce();
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
      expect((onOpenDraft.mock.calls[0][0] as DockRow).documentId).toBe("doc-13");
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
      expect((onOpenDraft.mock.calls[0][0] as DockRow).documentId).toBe("doc-13");
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
        expect((onOpenDraft.mock.calls[0][0] as DockRow).documentId).toBe("doc-13");
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
          expect((onOpenDraft.mock.calls[0][0] as DockRow).documentId).toBe("doc-int");
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
