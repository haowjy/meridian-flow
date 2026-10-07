// @vitest-environment jsdom
/**
 * The focused change's bar never covers manuscript text. With room in the right
 * margin it stands there beside the change's first line; without room it moves
 * into a block after the change's paragraph that the following text makes way
 * for. jsdom lays nothing out, so the boxes the surface measures are stubbed to
 * a 1280px window's: a 680px editor with 40px padding in a pane of `paneWidth`.
 */
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import type { Editor } from "@tiptap/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import { ChatThreadNavigationProvider } from "@/features/chat/ChatThreadNavigation";
import type { ReviewChange } from "@/features/draft-review/review-changes";
import {
  createReviewEditor,
  destroyReviewEditors,
  model,
  operation,
  posOf,
  setModel,
  span,
  textHunk,
} from "@/test-support/inline-review-editor";
import { ReviewChangeBarSurface } from "./ReviewChangeBarSurface";

// The desktop shell: the phone pins its own bar to the bottom of the screen.
vi.mock("@/hooks/use-phone-shell", () => ({ usePhoneShell: () => false }));

const change: ReviewChange = {
  classId: "c1",
  operations: [],
  operationIds: ["a1"],
  anchorOperationId: "a1",
  markKeys: ["a1"],
  actionable: true,
  tone: "ai",
  includesWriterEdits: false,
  merged: false,
  change: { removed: null, added: "one withered" },
  attribution: { kind: "ai" },
};
const view = {
  items: [{ change, failure: null }],
  focused: change,
  locked: false,
  canApply: true,
  apply: vi.fn(),
  discard: vi.fn(),
};
vi.mock("@/features/chat/DraftReviewProvider", () => ({
  useDraftReview: () => ({ controller: { marksVisible: true } }),
}));
vi.mock("@/features/draft-review/useReviewChanges", () => ({ useReviewChanges: () => view }));

const ANCHOR = { left: 140, top: 210, right: 300, bottom: 232 };
let paneWidth = 920;
let root: Root;
let container: HTMLElement;

const box = (l: number, t: number, r: number, b: number) =>
  ({ left: l, top: t, right: r, bottom: b, width: r - l, height: b - t, x: l, y: t }) as DOMRect;

function stubGeometry(editor: Editor) {
  const pane = editor.view.dom.closest<HTMLElement>("[data-stable-layout-scroll]");
  if (!pane) throw new Error("no pane");
  Object.defineProperty(pane, "clientWidth", { configurable: true, get: () => paneWidth });
  editor.view.dom.style.paddingRight = "40px";
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    if (this === pane) return box(0, 0, paneWidth, 600);
    if (this === editor.view.dom) return box(100, 139, 780, 1000);
    if (this.hasAttribute("data-review-operations"))
      return box(ANCHOR.left, ANCHOR.top, ANCHOR.right, ANCHOR.bottom);
    return box(0, 0, 0, 0);
  });
}

async function mount(editor: Editor) {
  i18n.loadAndActivate({ locale: "en", messages: {} });
  await act(async () => {
    root.render(
      <I18nProvider i18n={i18n}>
        <TooltipProvider>
          <ChatThreadNavigationProvider onOpenThread={vi.fn()}>
            <ReviewChangeBarSurface editor={editor} />
          </ChatThreadNavigationProvider>
        </TooltipProvider>
      </I18nProvider>,
    );
  });
  // The anchor lookup falls back to a 120ms retry when the first paint is late.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 150));
  });
}

function reviewedEditor() {
  const { editor } = createReviewEditor(["Elder Mo raised one withered hand.", "Next paragraph."]);
  const at = posOf(editor, "one withered");
  setModel(
    editor,
    model(
      [operation("a1", "agent")],
      [
        textHunk(
          editor,
          "h1",
          ["a1"],
          { from: at, to: at + 12 },
          { spans: [span(editor, "a1", at, at + 12)] },
        ),
      ],
    ),
  );
  editor.commands.setInlineReviewActiveOperation("a1");
  stubGeometry(editor);
  return editor;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
      unobserve() {}
    },
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  paneWidth = 920;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  destroyReviewEditors();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const bar = () => document.querySelector<HTMLElement>("[data-review-change-bar]");

describe("ReviewChangeBarSurface", () => {
  it("stands in the right margin, level with the change's first line and clear of the text", async () => {
    const editor = reviewedEditor();
    await mount(editor);
    const host = bar()?.parentElement;
    expect(host).not.toBeNull();
    // Outside the manuscript's own DOM, in the pane.
    expect(editor.view.dom.contains(host as Node)).toBe(false);
    expect(host?.closest("[data-stable-layout-scroll]")).not.toBeNull();
    // Right of the column (content ends at 740) and inside the pane.
    const left = Number.parseFloat(host?.style.left ?? "");
    const width = Number.parseFloat(host?.style.width ?? "");
    expect(left).toBeGreaterThanOrEqual(740);
    expect(left + width).toBeLessThanOrEqual(920);
    expect(Number.parseFloat(host?.style.top ?? "")).toBe(ANCHOR.top);
    // No block is opened in the text for it.
    expect(editor.view.dom.querySelector("[data-review-bar-slot]")).toBeNull();
  });

  it("moves below the change, in a block the text after it makes way for, when the margin is too narrow", async () => {
    paneWidth = 664;
    const editor = reviewedEditor();
    await mount(editor);
    const slot = editor.view.dom.querySelector("[data-review-bar-slot]");
    expect(slot).not.toBeNull();
    expect(slot?.contains(bar())).toBe(true);
    // In the flow between the change's paragraph and the next one: it pushes, never overlaps.
    const paragraphs = [...editor.view.dom.querySelectorAll("p")];
    expect(slot?.previousElementSibling).toBe(paragraphs[0]);
    expect(slot?.nextElementSibling).toBe(paragraphs[1]);
  });

  it("returns to the margin, and closes its block, when the pane widens", async () => {
    paneWidth = 664;
    const editor = reviewedEditor();
    await mount(editor);
    expect(editor.view.dom.querySelector("[data-review-bar-slot]")).not.toBeNull();
    paneWidth = 920;
    await act(async () => {
      window.dispatchEvent(new Event("resize"));
    });
    expect(editor.view.dom.querySelector("[data-review-bar-slot]")).toBeNull();
    expect(editor.view.dom.contains(bar())).toBe(false);
    expect(bar()).not.toBeNull();
  });

  it("keeps Discard and Apply reachable by keyboard in both places", async () => {
    for (const width of [920, 664]) {
      paneWidth = width;
      const editor = reviewedEditor();
      await mount(editor);
      const buttons = [...(bar()?.querySelectorAll("button") ?? [])];
      expect(buttons.map((b) => b.textContent?.trim())).toEqual(["Discard", "Apply"]);
      expect(buttons.every((b) => b.tabIndex >= 0 && !b.disabled)).toBe(true);
      buttons[1]?.click();
      expect(view.apply).toHaveBeenCalledWith(change);
      view.apply.mockClear();
      await act(async () => root.render(null));
      destroyReviewEditors();
      vi.restoreAllMocks();
    }
  });
});
