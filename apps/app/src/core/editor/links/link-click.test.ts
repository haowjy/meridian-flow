// @vitest-environment jsdom
import { Editor } from "@tiptap/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createStandaloneEditorExtensions } from "../config";
import { getLinkSurface } from "./LinkSurfaceExtension";

let editor: Editor | null = null;
let openTab: ReturnType<typeof vi.fn>;

beforeEach(() => {
  openTab = vi.fn();
  vi.stubGlobal("open", openTab);
  // jsdom has no layout, so ProseMirror's own mousedown handler throws while
  // hit-testing. The link plugin never asks for coordinates; this only keeps
  // the surrounding editor quiet.
  document.elementFromPoint = () => null;
});

afterEach(() => {
  vi.unstubAllGlobals();
  editor?.destroy();
  editor = null;
});

function editorWith(content: string): Editor {
  editor = new Editor({ extensions: createStandaloneEditorExtensions(), content });
  return editor;
}

function anchorOf(target: Editor): HTMLElement {
  const link = target.view.dom.querySelector("a");
  if (!(link instanceof HTMLElement)) throw new Error("link was not rendered");
  return link;
}

function press(anchor: HTMLElement, options: { altKey?: boolean; travelPx?: number } = {}) {
  const travel = options.travelPx ?? 0;
  anchor.dispatchEvent(
    new MouseEvent("mousedown", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }),
  );
  const click = new MouseEvent("click", {
    bubbles: true,
    cancelable: true,
    clientX: 10 + travel,
    clientY: 10,
    altKey: options.altKey ?? false,
  });
  anchor.dispatchEvent(click);
  return click;
}

describe("clicking a link in the manuscript", () => {
  it("never lets the browser navigate away from the draft", () => {
    const target = editorWith('<p><a href="https://example.com">linked</a></p>');

    expect(press(anchorOf(target)).defaultPrevented).toBe(true);
  });

  it("follows an external link into a new tab", () => {
    const target = editorWith('<p><a href="https://example.com">linked</a></p>');

    press(anchorOf(target));

    expect(openTab).toHaveBeenCalledWith("https://example.com", "_blank", "noopener,noreferrer");
  });

  it("places the caret instead when Alt is held", () => {
    const target = editorWith('<p><a href="https://example.com">linked</a></p>');

    press(anchorOf(target), { altKey: true });

    expect(openTab).not.toHaveBeenCalled();
  });

  it("places the caret when the press travelled far enough to be a selection", () => {
    const target = editorWith('<p><a href="https://example.com">linked</a></p>');

    press(anchorOf(target), { travelPx: 40 });

    expect(openTab).not.toHaveBeenCalled();
  });

  it("leaves an internal link to the caret until a navigator is registered", () => {
    const target = editorWith('<p><a href="[[The Second Gate]]">the gate</a></p>');

    press(anchorOf(target));

    expect(openTab).not.toHaveBeenCalled();
  });

  it("navigates an internal link in-app once the app registers one", () => {
    const target = editorWith('<p><a href="[[The Second Gate]]">the gate</a></p>');
    const navigate = vi.fn();
    getLinkSurface(target)?.registerNavigator(navigate);

    press(anchorOf(target));

    expect(navigate).toHaveBeenCalledWith({ kind: "wikilink", name: "The Second Gate" });
    expect(openTab).not.toHaveBeenCalled();
  });
});
