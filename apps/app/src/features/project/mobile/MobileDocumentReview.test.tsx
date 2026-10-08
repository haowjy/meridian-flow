// @vitest-environment jsdom
/**
 * The phone's review chrome: the header (switcher, stepper, count), the
 * selected change's bar, the change-list sheet, and the way the editor keeps
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
const launcher = vi.hoisted(() => ({ openDockRow: vi.fn(), openAiDraft: vi.fn() }));

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
    launcher.openDockRow,
    launcher.openAiDraft,
  ])
    fn.mockClear();
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
  it("shows the switcher, the stepper and the change count that opens the list", async () => {
    await render(async () => {
      expect(header()).not.toBeNull();
      expect(header()?.querySelector("[aria-label='Document version']")).not.toBeNull();
      expect(header()?.textContent).toContain("3 changes");
      expect(named("Show the 3 changes")?.textContent).toBe("3");
      await act(async () => named("Next change")?.click());
      expect(view.step).toHaveBeenCalledWith(1);
      await act(async () => named("Previous change")?.click());
      expect(view.step).toHaveBeenCalledWith(-1);
    });
  });

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

  it("shows no entry for a document with no pending draft, nor once its review has painted", async () => {
    controller.inlineReview = null;
    groups.splice(0, groups.length);
    try {
      await render(async () =>
        expect(document.querySelector("[data-phone-draft-entry]")).toBeNull(),
      );
    } finally {
      groups.push(draft("doc-12", "Chapter 12"), draft("doc-13", "Chapter 13"));
    }
    controller.inlineReview = { documentId: "doc-12", draftId: "draft-doc-12", shown: true };
    await render(async () => {
      expect(header()).not.toBeNull();
      expect(document.querySelector("[data-phone-draft-entry]")).toBeNull();
    });
  });

  it("keeps Apply draft, Discard draft, the live version and Hide changes in the Draft chip's menu", async () => {
    await render(async () => {
      await openSwitcher();
      expect(menuItem("Apply draft")).toBeDefined();
      expect(menuItem("Discard draft")).toBeDefined();
      expect(menuItem("Hide changes")).toBeDefined();
      // The menu is versions of this document: no other file, no Work-wide commands.
      expect(menuItem("Chapter 13")).toBeUndefined();
      expect(menuItem("Apply all")).toBeUndefined();
      await act(async () => menuItem("Live version")?.click());
      expect(controller.exitInlineReview).toHaveBeenCalledOnce();
    });
  });

  it("applies the draft from the menu and moves on to the next draft at once", async () => {
    await render(async () => {
      await openSwitcher();
      await act(async () => menuItem("Apply draft")?.click());
      expect(controller.apply).toHaveBeenCalledWith("doc-12", "draft-doc-12");
      expect(launcher.openDockRow).toHaveBeenCalledWith(
        expect.objectContaining({ documentId: "doc-13" }),
        "w",
      );
    });
    controller.apply.mockClear();
    launcher.openDockRow.mockClear();
    await render(async () => {
      await openSwitcher();
      await act(async () => menuItem("Discard draft")?.click());
      expect(controller.discard).toHaveBeenCalledWith("doc-12", "draft-doc-12");
      expect(launcher.openDockRow).toHaveBeenCalledOnce();
    });
  });

  it("lists every draft file once in the sheet, the open one expanded, and applies all from it", async () => {
    await render(async () => {
      await act(async () => named("Show the 3 changes")?.click());
      const sheetText = sheet()?.textContent ?? "";
      // The open file expands in place; the other is a row to open.
      expect(sheet()?.querySelector("[data-review-file-open]")?.textContent).toContain(
        "Chapter 12",
      );
      expect(sheetText).toContain("Chapter 13");
      expect(sheetText).toContain("2 drafts to review");
      await act(async () =>
        named("All drafts")?.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
        ),
      );
      await act(async () => menuItem("Apply all 2 drafts")?.click());
      expect(controller.disposeDrafts).toHaveBeenCalledWith("apply", [
        { documentId: "doc-12", draftId: "draft-doc-12" },
        { documentId: "doc-13", draftId: "draft-doc-13" },
      ]);
    });
  });

  it("opens another file from the sheet and closes the sheet", async () => {
    await render(async () => {
      await act(async () => named("Show the 3 changes")?.click());
      const row = Array.from(sheet()?.querySelectorAll<HTMLElement>("button") ?? []).find((node) =>
        node.textContent?.includes("Chapter 13"),
      );
      await act(async () => row?.click());
      expect(launcher.openDockRow).toHaveBeenCalledWith(
        expect.objectContaining({ documentId: "doc-13" }),
        "w",
      );
      expect(sheet()).toBeNull();
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

  it("says formatting remains, not No changes left, and keeps the draft commands", async () => {
    Object.assign(view, { items: [], unlisted: true });
    await render(async () => {
      expect(header()?.textContent).toContain("Formatting changes remain");
      expect(header()?.textContent).not.toContain("No changes left");
      await openSwitcher();
      expect(menuItem("Apply draft")).toBeDefined();
      expect(menuItem("Discard draft")).toBeDefined();
    });
  });

  it("says No changes left with Next draft, and offers no draft commands", async () => {
    Object.assign(view, { items: [], finished: true });
    await render(async () => {
      expect(header()?.textContent).toContain("No changes left");
      await openSwitcher();
      expect(menuItem("Apply draft")).toBeUndefined();
      await act(async () => named("Next draft")?.click());
      expect(launcher.openDockRow).toHaveBeenCalledWith(
        expect.objectContaining({ documentId: "doc-13" }),
        "w",
      );
    });
  });

  it("holds on No changes left after the server closed the draft and the list lost it", async () => {
    const closed = groups.splice(0, 1);
    Object.assign(view, { items: [], finished: true });
    controller.inlineReview = {
      documentId: "doc-12",
      draftId: "draft-doc-12",
      shown: true,
      completion: { phase: "closed", documentName: "Chapter 12" },
    };
    try {
      await render(async () => {
        expect(header()?.textContent).toContain("No changes left");
        expect(header()?.querySelector("[aria-label='Document version']")).not.toBeNull();
        expect(controller.exitInlineReview).not.toHaveBeenCalled();
        await act(async () => named("Next draft")?.click());
        expect(launcher.openDockRow).toHaveBeenCalledWith(
          expect.objectContaining({ documentId: "doc-13" }),
          "w",
        );
      });
    } finally {
      groups.unshift(...closed);
    }
  });

  it("offers the way back to live when no other draft is left", async () => {
    const all = groups.splice(0, groups.length);
    Object.assign(view, { items: [], finished: true });
    controller.inlineReview = {
      documentId: "doc-12",
      draftId: "draft-doc-12",
      shown: true,
      completion: { phase: "closed", documentName: "Chapter 12" },
    };
    try {
      await render(async () => {
        expect(header()?.textContent).toContain("No changes left");
        expect(named("Next draft")).toBeUndefined();
        await act(async () => named("Back to live")?.click());
        expect(controller.exitInlineReview).toHaveBeenCalledOnce();
      });
    } finally {
      groups.push(...all);
    }
  });

  it("says Applying, not No changes left, while the last change's command is in flight", async () => {
    Object.assign(view, { items: [], completing: "apply" });
    await render(async () => {
      expect(header()?.textContent).toContain("Applying");
      expect(header()?.textContent).not.toContain("No changes left");
      expect(named("Next draft")).toBeUndefined();
    });
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

  it("clears the home indicator and the on-screen keyboard", async () => {
    view.focused = all[0];
    await render(async () => {
      const style = (bar() as HTMLElement).style.paddingBottom;
      expect(style).toContain("safe-area-inset-bottom");
      expect(style).toContain("--mobile-keyboard-height");
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

  it("closes itself when the last change is handled", async () => {
    await render(async () => {
      await act(async () => named("Show the 3 changes")?.click());
      expect(sheet()).not.toBeNull();
      await flip(() => Object.assign(view, { items: [], finished: true }));
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
