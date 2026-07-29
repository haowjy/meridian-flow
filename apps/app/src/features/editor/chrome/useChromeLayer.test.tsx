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
