// @vitest-environment jsdom
import { Editor } from "@tiptap/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import { createEditorConfig } from "../config";
import { relativePositionForEditorIndex } from "./LiveRangeNavigationExtension";

let editor: Editor;

beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  HTMLElement.prototype.scrollIntoView = vi.fn();
  const doc = new Y.Doc({ gc: false });
  editor = new Editor({
    element: document.createElement("div"),
    ...createEditorConfig({ document: doc, awareness: new Awareness(doc) }),
  });
  editor.commands.setContent({
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text: "hello" }] }],
  });
});

afterEach(() => {
  editor.destroy();
  vi.unstubAllGlobals();
});

describe("LiveRangeNavigationExtension", () => {
  it("maps a relative range and highlights its live text", () => {
    const start = relativePositionForEditorIndex(editor, 1);
    const end = relativePositionForEditorIndex(editor, 6);
    expect(start && end && editor.commands.showLiveRange({ start, end })).toBe(true);
    expect(editor.view.dom.querySelector('[data-live-range-navigation="range"]')?.textContent).toBe(
      "hello",
    );
  });

  it("renders a zero-width deletion boundary without fabricating a range", () => {
    const position = relativePositionForEditorIndex(editor, 3);
    expect(position && editor.commands.showLivePosition(position)).toBe(true);
    expect(editor.view.dom.querySelector('[data-live-range-navigation="boundary"]')).not.toBeNull();
    expect(editor.view.dom.querySelector('[data-live-range-navigation="range"]')).toBeNull();
  });
});
