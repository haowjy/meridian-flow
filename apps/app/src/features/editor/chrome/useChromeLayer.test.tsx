// @vitest-environment jsdom
/**
 * Nested layers and the walk home, through React.
 *
 * The mechanism under test is not "does a layer register" but WHICH layer the
 * chain calls topmost when a parent and a child open on the same render.
 * React runs child effects before parent effects, so registration order is the
 * reverse of visual depth — the case the design's own new-empty-diagram path
 * hits every time (the dialog opens with its source pane already open).
 */
import { Editor, type JSONContent } from "@tiptap/core";
import { act, type ReactNode, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getEditorChrome } from "@/core/editor/chrome";
import { createStandaloneEditorExtensions } from "@/core/editor/config";

import { useChromeLayer } from "./chrome-layers";

let editor: Editor | null = null;
let root: Root | null = null;
let container: HTMLElement | null = null;

beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);

  const element = document.createElement("div");
  document.body.append(element);
  editor = new Editor({
    element,
    extensions: createStandaloneEditorExtensions(),
    content: {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "before" }] }],
    } satisfies JSONContent,
  });
  // Returning the caret scrolls it into view, and ProseMirror measures the
  // selection to do that. jsdom has no layout to measure — the same gap
  // `elementFromPoint` fills for the context-menu router's tests.
  vi.spyOn(editor.view, "coordsAtPos").mockReturnValue({
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
  });
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  editor?.destroy();
  editor = null;
  root = null;
  container = null;
});

function Layer({ id, close, children }: { id: string; close: () => void; children?: ReactNode }) {
  const layer = useChromeLayer(editor, { id, open: true, close });
  return <div data-layer={id}>{layer.scope(children)}</div>;
}

describe("nested layers", () => {
  it("treats the child as topmost when parent and child open together", () => {
    const closeDialog = vi.fn();
    const closeSource = vi.fn();

    act(() => {
      root?.render(
        <Layer id="diagram-dialog" close={closeDialog}>
          <Layer id="diagram-source" close={closeSource} />
        </Layer>,
      );
    });

    const chrome = getEditorChrome(editor);
    if (!chrome) throw new Error("kernel did not mount");

    expect(chrome.closeTopLayer()).toBe(true);
    expect(closeSource).toHaveBeenCalledOnce();
    expect(closeDialog).not.toHaveBeenCalled();
  });

  it("walks out of the child before the parent, one step each", () => {
    function Dialog() {
      const [sourceOpen, setSourceOpen] = useState(true);
      const [open, setOpen] = useState(true);
      if (!open) return null;
      return (
        <Layer id="diagram-dialog" close={() => setOpen(false)}>
          {sourceOpen ? <Layer id="diagram-source" close={() => setSourceOpen(false)} /> : null}
        </Layer>
      );
    }

    act(() => root?.render(<Dialog />));
    const chrome = getEditorChrome(editor);
    if (!chrome) throw new Error("kernel did not mount");

    act(() => {
      chrome.closeTopLayer();
    });
    expect(container?.querySelector("[data-layer='diagram-source']")).toBeNull();
    expect(container?.querySelector("[data-layer='diagram-dialog']")).not.toBeNull();

    act(() => {
      chrome.closeTopLayer();
    });
    expect(container?.querySelector("[data-layer='diagram-dialog']")).toBeNull();
    expect(chrome.layers).toHaveLength(0);
  });

  it("lets a Radix parent dismiss itself only when the chain has reached it", () => {
    const closeDialog = vi.fn();
    const closeSource = vi.fn();

    function Nested() {
      const dialog = useChromeLayer(editor, {
        id: "diagram-dialog",
        open: true,
        close: closeDialog,
        dismissal: "self",
      });
      return dialog.scope(
        <div>
          <Layer id="diagram-source" close={closeSource} />
          <button
            type="button"
            data-testid="dialog-escape"
            onClick={() => dialog.onEscapeKeyDown({ preventDefault: () => {} })}
          />
        </div>,
      );
    }

    act(() => root?.render(<Nested />));

    // Radix asks the dialog whether this Escape is its to take. It is not: the
    // source pane inside it is deeper, and answering yes would spend two steps
    // of the walk home on one key.
    const trigger = container?.querySelector<HTMLButtonElement>("[data-testid='dialog-escape']");
    act(() => trigger?.click());

    expect(closeSource).toHaveBeenCalledOnce();
    expect(closeDialog).not.toHaveBeenCalled();
  });
});

describe("handing the caret back", () => {
  /**
   * jsdom will not put `document.activeElement` on a contenteditable div, so
   * the observable end of "the caret went back to the prose" is ProseMirror's
   * own focus call rather than the browser's focus state.
   */
  function watchProseFocus() {
    if (!editor) throw new Error("no editor");
    return vi.spyOn(editor.view, "focus");
  }

  /** TipTap defers `focus()` a frame, so the assertion has to wait for it. */
  const settleFocus = () =>
    act(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    });

  it("returns the caret to the prose when the last surface closes", async () => {
    const focus = watchProseFocus();
    let binding: { onCloseAutoFocus: (event: Event) => void } | null = null;

    function Only() {
      binding = useChromeLayer(editor, { id: "menu", open: true, close: () => {} });
      return null;
    }
    act(() => root?.render(<Only />));

    // Cancelable, or `preventDefault` is a no-op and the assertion below
    // would be measuring the fixture rather than the handler.
    const event = new Event("close", { cancelable: true });
    act(() => binding?.onCloseAutoFocus(event));

    // Radix's own restore is refused, and the caret goes to the prose instead.
    await settleFocus();

    expect(event.defaultPrevented).toBe(true);
    expect(focus).toHaveBeenCalled();
  });

  it("leaves focus alone when the closing surface opened another one", async () => {
    const focus = watchProseFocus();
    let menu: { onCloseAutoFocus: (event: Event) => void } | null = null;

    function MenuThenForm() {
      menu = useChromeLayer(editor, { id: "menu", open: true, close: () => {} });
      useChromeLayer(editor, { id: "link-form", open: true, close: () => {} });
      return null;
    }
    act(() => root?.render(<MenuThenForm />));

    // "Edit link" closes the menu and opens the form in the same commit.
    // Handing the caret back here pulls focus out of the form on the frame it
    // appeared, and Radix reads that as an outside interaction and kills it.
    act(() => menu?.onCloseAutoFocus(new Event("close", { cancelable: true })));
    await settleFocus();

    expect(focus).not.toHaveBeenCalled();
  });
});

describe("a layer whose close does not land", () => {
  it("stops consuming Escape instead of trapping the writer", () => {
    // A surface whose dismissal fails, or whose owner unmounted mid-animation.
    act(() => root?.render(<Layer id="stuck" close={() => {}} />));

    const chrome = getEditorChrome(editor);
    if (!chrome) throw new Error("kernel did not mount");

    expect(chrome.closeTopLayer()).toBe(true);
    // Asked once and it did not go. The chain must not keep offering it the
    // key: "nobody is ever trapped" outranks not over-stepping an animation.
    expect(chrome.closeTopLayer()).toBe(false);
  });
});
