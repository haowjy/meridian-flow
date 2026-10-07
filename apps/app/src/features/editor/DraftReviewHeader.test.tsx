// @vitest-environment jsdom
/**
 * The one-row review header: breadcrumb, draft switcher, stepper, Show
 * changes, Discard draft and Apply draft. Whole-draft commands move straight to
 * the next draft in the switcher, or back to live when none is left.
 */
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import type { DockRow } from "@/features/chat/docked-drafts";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { DraftReviewHeader } from "./DraftReviewHeader";

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
  inlineReviewMessage: null as null | { code: string; tone: string },
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
  cleared: false,
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
  props: Partial<React.ComponentProps<typeof DraftReviewHeader>>,
  run: () => Promise<void>,
  documentId = "doc-12",
) {
  i18n.loadAndActivate({ locale: "en", messages: {} });
  return withReactRoot(
    <I18nProvider i18n={i18n}>
      <QueryClientProvider client={new QueryClient()}>
        <TooltipProvider>
          <DraftReviewHeader
            documentId={documentId}
            draftId={`draft-${documentId}`}
            onOpenDraft={vi.fn()}
            {...props}
          />
        </TooltipProvider>
      </QueryClientProvider>
    </I18nProvider>,
    run,
  );
}

const byText = (text: string) =>
  Array.from(document.querySelectorAll<HTMLElement>("button, [role=menuitem]")).find(
    (node) => node.textContent?.trim() === text,
  );

async function openSwitcher() {
  const trigger = document.querySelector<HTMLElement>("[data-slot=dropdown-menu-trigger]");
  await act(async () => {
    trigger?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
}

beforeEach(() => {
  Object.assign(controller, {
    dispositionLocked: false,
    inlineReviewMessage: null,
    marksVisible: true,
  });
  Object.assign(view, {
    status: "ready",
    items: [{}, {}, {}, {}, {}, {}],
    focusedIndex: 1,
    cleared: false,
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

describe("DraftReviewHeader", () => {
  it("is one row: breadcrumb, switcher, stepper, Show changes, Discard draft, Apply draft", async () => {
    await render({}, async () => {
      const text = document.body.textContent ?? "";
      expect(text).toContain("Manuscript /");
      expect(text).toContain("Chapter 12");
      expect(text).toContain("2 of 6");
      expect(text).toContain("Show changes");
      expect(byText("Discard draft")).toBeDefined();
      expect(byText("Apply draft")).toBeDefined();
      expect(document.querySelector("[aria-label='Next change']")).not.toBeNull();
    });
  });

  it("steps through the changes and toggles Show changes", async () => {
    await render({}, async () => {
      await act(async () =>
        document.querySelector<HTMLButtonElement>("[aria-label='Next change']")?.click(),
      );
      expect(view.step).toHaveBeenCalledWith(1);
      await act(async () => document.querySelector<HTMLButtonElement>("[role=switch]")?.click());
      expect(controller.setMarksVisible).toHaveBeenCalledWith(false);
    });
  });

  it("lists the Work's drafts with counts and a New document tag, checking the current one", async () => {
    await render({}, async () => {
      await openSwitcher();
      const menu = document.querySelector("[role=menu]")?.textContent ?? "";
      expect(menu).toContain("Chapter 13");
      expect(menu).toContain("11 changes");
      expect(menu).toContain("Interlude");
      expect(menu).toContain("New document");
      expect(menu).toContain("Show live version");
      expect(menu).toContain("Apply all 3 drafts");
      expect(menu).toContain("Discard all 3 drafts");
    });
  });

  it("opens another draft from the switcher through the launcher", async () => {
    const onOpenDraft = vi.fn();
    await render({ onOpenDraft }, async () => {
      await openSwitcher();
      await act(async () =>
        Array.from(document.querySelectorAll<HTMLElement>("[role=menuitem]"))
          .find((node) => node.textContent?.startsWith("Chapter 13"))
          ?.click(),
      );
      expect(onOpenDraft).toHaveBeenCalledOnce();
      expect((onOpenDraft.mock.calls[0][0] as DockRow).documentId).toBe("doc-13");
    });
  });

  it("applies or discards every draft of the Work from the switcher", async () => {
    await render({}, async () => {
      await openSwitcher();
      await act(async () => byText("Apply all 3 drafts")?.click());
      expect(controller.disposeDrafts).toHaveBeenCalledWith("apply", [
        { documentId: "doc-12", draftId: "draft-doc-12" },
        { documentId: "doc-13", draftId: "draft-doc-13" },
        { documentId: "doc-int", draftId: "draft-doc-int" },
      ]);
    });
    await render({}, async () => {
      await openSwitcher();
      await act(async () => byText("Discard all 3 drafts")?.click());
      expect(controller.disposeDrafts).toHaveBeenCalledWith("discard", expect.any(Array));
    });
  });

  it("shows the live version from the switcher, and closes review for a draft-only document", async () => {
    await render({}, async () => {
      await openSwitcher();
      await act(async () => byText("Show live version")?.click());
      expect(controller.exitInlineReview).toHaveBeenCalledOnce();
    });
    const close = vi.fn();
    controller.exitInlineReview.mockClear();
    await render(
      { onCloseDraftOnly: close },
      async () => {
        await openSwitcher();
        expect(byText("Show live version")).toBeUndefined();
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
    Object.assign(view, { items: [], cleared: true });
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

  it("shows a failed whole-draft command on the header", async () => {
    controller.inlineReviewMessage = { code: "apply-failed", tone: "error" };
    await render({}, async () => {
      expect(document.querySelector("[role=alert]")?.textContent).toContain("Couldn't apply");
    });
  });
});
