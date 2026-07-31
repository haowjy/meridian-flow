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
import type { JSONContent } from "@tiptap/core";
import { act, type ReactNode, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getEditorChrome } from "@/core/editor/chrome";
import { createReactEditorFixture, type ReactEditorFixture } from "@/test-support/react-editor";

import { useChromeLayer } from "./chrome-layers";

let page: ReactEditorFixture;

beforeEach(() => {
  page = createReactEditorFixture({
    content: {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "before" }] }],
    } satisfies JSONContent,
  });
});

afterEach(() => {
  page.destroy();
});

function Layer({ id, close, children }: { id: string; close: () => void; children?: ReactNode }) {
  const layer = useChromeLayer(page.editor, { id, open: true, close });
  return <div data-layer={id}>{layer.scope(children)}</div>;
}

describe("nested layers", () => {
  it("treats the child as topmost when parent and child open together", () => {
    const closeDialog = vi.fn();
    const closeSource = vi.fn();

    page.render(
      <Layer id="diagram-dialog" close={closeDialog}>
        <Layer id="diagram-source" close={closeSource} />
      </Layer>,
    );

    const chrome = getEditorChrome(page.editor);
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

    page.render(<Dialog />);
    const chrome = getEditorChrome(page.editor);
    if (!chrome) throw new Error("kernel did not mount");

    act(() => {
      chrome.closeTopLayer();
    });
    expect(page.container.querySelector("[data-layer='diagram-source']")).toBeNull();
    expect(page.container.querySelector("[data-layer='diagram-dialog']")).not.toBeNull();

    act(() => {
      chrome.closeTopLayer();
    });
    expect(page.container.querySelector("[data-layer='diagram-dialog']")).toBeNull();
    expect(chrome.layers).toHaveLength(0);
  });

  it("lets a Radix parent dismiss itself only when the chain has reached it", () => {
    const closeDialog = vi.fn();
    const closeSource = vi.fn();

    function Nested() {
      const dialog = useChromeLayer(page.editor, {
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

    page.render(<Nested />);

    // Radix asks the dialog whether this Escape is its to take. It is not: the
    // source pane inside it is deeper, and answering yes would spend two steps
    // of the walk home on one key.
    const trigger = page.container.querySelector<HTMLButtonElement>(
      "[data-testid='dialog-escape']",
    );
    act(() => trigger?.click());

    expect(closeSource).toHaveBeenCalledOnce();
    expect(closeDialog).not.toHaveBeenCalled();
  });
});

describe("a layer's keys", () => {
  /**
   * Focus inside a dialog is focus outside the editor's DOM: Radix portals the
   * content to the body, and ProseMirror's `handleKeyDown` never runs for it.
   * The fixture presses the chord on an element outside the prose for exactly
   * that reason — it is the only place the shortcut is actually pressed.
   */
  function pressOutsideTheProse(key: string) {
    const outside = document.createElement("button");
    document.body.append(outside);
    outside.dispatchEvent(
      new KeyboardEvent("keydown", { key, ctrlKey: true, bubbles: true, cancelable: true }),
    );
    outside.remove();
  }

  it("shows up in the kernel's bindings while the surface is open", () => {
    function Dialog() {
      useChromeLayer(page.editor, {
        id: "object-lightbox",
        open: true,
        close: () => {},
        keys: { "Mod-Enter": () => true },
      });
      return null;
    }
    page.render(<Dialog />);

    const chrome = getEditorChrome(page.editor);
    if (!chrome) throw new Error("kernel did not mount");

    // Beside the editor's own lanes: object physics and the rest register too,
    // and the point is that a dialog's chord is one of the same kind of thing.
    const dialogKeys = () =>
      chrome.keymapContributions().filter((entry) => entry.id.startsWith("object-lightbox"));

    expect(dialogKeys()).toHaveLength(1);
    expect(dialogKeys()[0]?.scope).toBe("layer");
    expect(Object.keys(dialogKeys()[0]?.bindings ?? {})).toEqual(["Mod-Enter"]);

    page.render(null);
    expect(dialogKeys()).toHaveLength(0);
  });

  it("answers the chord while focus sits in portalled content", () => {
    const toggle = vi.fn(() => true);

    function Dialog() {
      useChromeLayer(page.editor, {
        id: "object-lightbox",
        open: true,
        close: () => {},
        keys: { "Mod-Enter": toggle },
      });
      return null;
    }
    page.render(<Dialog />);

    act(() => pressOutsideTheProse("Enter"));
    expect(toggle).toHaveBeenCalledOnce();

    // Closed means gone: the registration lives exactly as long as the surface.
    page.render(null);
    act(() => pressOutsideTheProse("Enter"));
    expect(toggle).toHaveBeenCalledOnce();
  });

  it("reads the handler live, so an inline declaration is not a stale closure", () => {
    const seen: number[] = [];

    function Dialog() {
      const [count, setCount] = useState(0);
      useChromeLayer(page.editor, {
        id: "object-lightbox",
        open: true,
        close: () => {},
        keys: {
          "Mod-Enter": () => {
            seen.push(count);
            setCount(count + 1);
            return true;
          },
        },
      });
      return null;
    }
    page.render(<Dialog />);

    act(() => pressOutsideTheProse("Enter"));
    act(() => pressOutsideTheProse("Enter"));

    expect(seen).toEqual([0, 1]);
  });
});

describe("handing the caret back", () => {
  /**
   * jsdom will not put `document.activeElement` on a contenteditable div, so
   * the observable end of "the caret went back to the prose" is ProseMirror's
   * own focus call rather than the browser's focus state.
   */
  function watchProseFocus() {
    return vi.spyOn(page.editor.view, "focus");
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
      binding = useChromeLayer(page.editor, { id: "menu", open: true, close: () => {} });
      return null;
    }
    page.render(<Only />);

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
      menu = useChromeLayer(page.editor, { id: "menu", open: true, close: () => {} });
      useChromeLayer(page.editor, { id: "link-form", open: true, close: () => {} });
      return null;
    }
    page.render(<MenuThenForm />);

    // "Edit link" closes the menu and opens the form in the same commit.
    // Handing the caret back here pulls focus out of the form on the frame it
    // appeared, and Radix reads that as an outside interaction and kills it.
    act(() => menu?.onCloseAutoFocus(new Event("close", { cancelable: true })));
    await settleFocus();

    expect(focus).not.toHaveBeenCalled();
  });
});

describe("one transient surface at a time", () => {
  it("closes the open surface when a rival is summoned", () => {
    const closeSlash = vi.fn();

    function SlashThenForm({ formOpen }: { formOpen: boolean }) {
      useChromeLayer(page.editor, { id: "slash-menu", open: true, close: closeSlash });
      useChromeLayer(page.editor, { id: "link-form", open: formOpen, close: () => {} });
      return null;
    }

    page.render(<SlashThenForm formOpen={false} />);
    expect(closeSlash).not.toHaveBeenCalled();

    // Ctrl+K while the slash menu is up. Both staying open leaves two inputs
    // reading the same keystrokes.
    page.render(<SlashThenForm formOpen={true} />);
    expect(closeSlash).toHaveBeenCalledOnce();
  });

  it("does not mistake a surface's own child for a rival", () => {
    const closeMenu = vi.fn();

    function MenuWithSubmenu() {
      const menu = useChromeLayer(page.editor, { id: "block-menu", open: true, close: closeMenu });
      return menu.scope(<Layer id="turn-into" close={() => {}} />);
    }

    page.render(<MenuWithSubmenu />);

    const chrome = getEditorChrome(page.editor);
    expect(closeMenu).not.toHaveBeenCalled();
    expect(chrome?.layers).toHaveLength(2);
  });
});

describe("a layer whose close does not land", () => {
  it("stops consuming Escape instead of trapping the writer", () => {
    // A surface whose dismissal fails, or whose owner unmounted mid-animation.
    page.render(<Layer id="stuck" close={() => {}} />);

    const chrome = getEditorChrome(page.editor);
    if (!chrome) throw new Error("kernel did not mount");

    expect(chrome.closeTopLayer()).toBe(true);
    // Asked once and it did not go. The chain must not keep offering it the
    // key: "nobody is ever trapped" outranks not over-stepping an animation.
    expect(chrome.closeTopLayer()).toBe(false);
  });
});
