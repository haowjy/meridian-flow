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

const LINK_AND_PROSE =
  '<p><a href="https://example.com">linked</a></p><p>the ledger kept its own accounts</p>';

function anchorOf(target: Editor): HTMLElement {
  const link = target.view.dom.querySelector("a");
  if (!(link instanceof HTMLElement)) throw new Error("link was not rendered");
  return link;
}

type Press = {
  altKey?: boolean;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  travelPx?: number;
  /** Runs between mousedown and the click, standing in for what a browser does. */
  during?: () => void;
};

function press(anchor: HTMLElement, options: Press = {}) {
  const travel = options.travelPx ?? 0;
  anchor.dispatchEvent(
    new MouseEvent("mousedown", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }),
  );
  options.during?.();
  const click = new MouseEvent("click", {
    bubbles: true,
    cancelable: true,
    clientX: 10 + travel,
    clientY: 10,
    altKey: options.altKey ?? false,
    shiftKey: options.shiftKey ?? false,
    ctrlKey: options.ctrlKey ?? false,
  });
  anchor.dispatchEvent(click);
  return click;
}

function middleClick(anchor: HTMLElement) {
  anchor.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 1 }));
  const auxclick = new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 });
  anchor.dispatchEvent(auxclick);
  return auxclick;
}

describe("clicking a link in the manuscript", () => {
  it("never lets the browser navigate away from the draft", () => {
    const target = editorWith('<p><a href="https://example.com">linked</a></p>');

    expect(press(anchorOf(target)).defaultPrevented).toBe(true);
  });

  it("follows an external link into a new tab", () => {
    const target = editorWith('<p><a href="https://example.com">linked</a></p>');

    press(anchorOf(target));

    expect(openTab).toHaveBeenCalledWith("https://example.com/", "_blank", "noopener,noreferrer");
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

    expect(navigate).toHaveBeenCalledWith({
      target: { kind: "wikilink", name: "The Second Gate" },
      disposition: "current",
    });
    expect(openTab).not.toHaveBeenCalled();
  });
});

/**
 * A click reads (law 1), and reading a link means going there. It does not
 * also move the writer's place in the manuscript: they come back from that new
 * tab to the sentence they left, not to the middle of the link they pressed.
 */
describe("a followed click leaves the caret alone", () => {
  it("puts the selection back where the press found it", () => {
    const target = editorWith(LINK_AND_PROSE);
    target.commands.setTextSelection(20);

    press(anchorOf(target), {
      // jsdom has no layout, so ProseMirror's own mousedown never places a
      // caret. This is the placement a browser would have made.
      during: () => target.commands.setTextSelection(4),
    });

    expect(openTab).toHaveBeenCalled();
    expect(target.state.selection.from).toBe(20);
  });

  it("keeps the caret the writer asked for with Alt", () => {
    const target = editorWith(LINK_AND_PROSE);
    target.commands.setTextSelection(20);

    press(anchorOf(target), { altKey: true, during: () => target.commands.setTextSelection(4) });

    expect(openTab).not.toHaveBeenCalled();
    expect(target.state.selection.from).toBe(4);
  });

  it("keeps a Shift+click's extended selection", () => {
    const target = editorWith(LINK_AND_PROSE);
    target.commands.setTextSelection(20);

    press(anchorOf(target), {
      shiftKey: true,
      during: () => target.commands.setTextSelection({ from: 2, to: 6 }),
    });

    expect(openTab).not.toHaveBeenCalled();
    expect(target.state.selection.from).toBe(2);
  });
});

/**
 * The middle button navigates through `auxclick`, which the click handler
 * never sees. Left unhandled it is the one path where a raw href in the
 * manuscript reaches the browser's own URL resolution.
 */
describe("the middle button", () => {
  it("never reaches the browser, and opens a new tab for an external link", () => {
    const target = editorWith('<p><a href="https://example.com">linked</a></p>');

    const auxclick = middleClick(anchorOf(target));

    expect(auxclick.defaultPrevented).toBe(true);
    expect(openTab).toHaveBeenCalledWith("https://example.com/", "_blank", "noopener,noreferrer");
  });

  it("cancels on an internal link even with nowhere to send it", () => {
    const target = editorWith('<p><a href="chapter-213.md">chapter 213</a></p>');

    const auxclick = middleClick(anchorOf(target));

    // A relative path handed to the browser resolves against the app's own
    // origin, which is a page that has nothing to do with the manuscript.
    expect(auxclick.defaultPrevented).toBe(true);
    expect(openTab).not.toHaveBeenCalled();
  });

  it("asks the navigator for a new tab when one is registered", () => {
    const target = editorWith('<p><a href="[[The Second Gate]]">the gate</a></p>');
    const navigate = vi.fn();
    getLinkSurface(target)?.registerNavigator(navigate);

    middleClick(anchorOf(target));

    expect(navigate).toHaveBeenCalledWith({
      target: { kind: "wikilink", name: "The Second Gate" },
      disposition: "new-tab",
    });
  });

  it("asks for a new tab on Ctrl+click too", () => {
    const target = editorWith('<p><a href="[[The Second Gate]]">the gate</a></p>');
    const navigate = vi.fn();
    getLinkSurface(target)?.registerNavigator(navigate);

    press(anchorOf(target), { ctrlKey: true });

    expect(navigate).toHaveBeenCalledWith({
      target: { kind: "wikilink", name: "The Second Gate" },
      disposition: "new-tab",
    });
  });
});
