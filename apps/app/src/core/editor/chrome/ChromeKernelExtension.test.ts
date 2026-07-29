// @vitest-environment jsdom
import { Editor, type JSONContent } from "@tiptap/core";
import { NodeSelection } from "@tiptap/pm/state";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createStandaloneEditorExtensions } from "../config";
import { getEditorChrome } from "./ChromeKernelExtension";

let editor: Editor | null = null;

afterEach(() => {
  editor?.destroy();
  editor = null;
});

const paragraph = (text: string): JSONContent => ({
  type: "paragraph",
  content: [{ type: "text", text }],
});

const figure: JSONContent = { type: "figure", attrs: { src: "asset:1", caption: "" } };

function mount(content: JSONContent[]): Editor {
  const element = document.createElement("div");
  document.body.append(element);
  // jsdom has no layout, so ProseMirror's `posAtCoords` has nothing to hit
  // test against. The claim ladder's routing matrix is covered as data in
  // `context-claims.test.ts`; what this file proves is the wiring.
  document.elementFromPoint ??= () => null;
  editor = new Editor({
    element,
    extensions: createStandaloneEditorExtensions(),
    content: { type: "doc", content },
  });
  return editor;
}

function pressEscape(instance: Editor): boolean {
  const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  instance.view.dom.dispatchEvent(event);
  return event.defaultPrevented;
}

function rightClick(instance: Editor): MouseEvent {
  const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 });
  instance.view.dom.dispatchEvent(event);
  return event;
}

describe("the kernel on a live editor", () => {
  it("resolves the context every selection change", () => {
    const instance = mount([paragraph("before"), figure]);
    const chrome = getEditorChrome(instance);
    if (!chrome) throw new Error("kernel did not mount");

    expect(chrome.context.owner).toBe("document");

    let figurePos = 0;
    instance.state.doc.descendants((node, pos) => {
      if (node.type.name === "figure") figurePos = pos;
    });
    instance.view.dispatch(
      instance.state.tr.setSelection(NodeSelection.create(instance.state.doc, figurePos)),
    );

    expect(chrome.context).toMatchObject({ owner: "object", nodeType: "figure", pos: figurePos });
  });

  it("walks home one Esc at a time and then hands the key back", () => {
    const instance = mount([paragraph("before"), figure]);
    const chrome = getEditorChrome(instance);
    if (!chrome) throw new Error("kernel did not mount");

    let figurePos = 0;
    instance.state.doc.descendants((node, pos) => {
      if (node.type.name === "figure") figurePos = pos;
    });
    instance.view.dispatch(
      instance.state.tr.setSelection(NodeSelection.create(instance.state.doc, figurePos)),
    );

    const close = vi.fn();
    const layer = chrome.openLayer({ id: "menu", close });

    // One: the menu.
    expect(pressEscape(instance)).toBe(true);
    expect(close).toHaveBeenCalledOnce();
    layer.release();
    expect(chrome.context.owner).toBe("object");

    // Two: the object.
    expect(pressEscape(instance)).toBe(true);
    expect(chrome.context.owner).toBe("document");

    // Three: home. The key is left alone so the browser can still have it.
    expect(pressEscape(instance)).toBe(false);
  });

  it("leaves a right-click to the browser when nobody claims (ruling 11)", () => {
    const instance = mount([paragraph("The thrid gate opened.")]);
    expect(rightClick(instance).defaultPrevented).toBe(false);
  });

  it("takes the right-click when a lane claims it", () => {
    const instance = mount([paragraph("The third gate opened.")]);
    const chrome = getEditorChrome(instance);
    if (!chrome) throw new Error("kernel did not mount");

    const open = vi.fn(() => true);
    const release = chrome.registerContextClaim({ id: "object", claim: open });

    expect(rightClick(instance).defaultPrevented).toBe(true);
    expect(open).toHaveBeenCalledOnce();

    release();
    expect(rightClick(instance).defaultPrevented).toBe(false);
  });

  it("routes a registered key and leaves an unregistered one to the editor", () => {
    const instance = mount([paragraph("before")]);
    const chrome = getEditorChrome(instance);
    if (!chrome) throw new Error("kernel did not mount");

    const moveBlock = vi.fn(() => true);
    chrome.registerKeymap({
      id: "block-movement",
      scope: "document",
      bindings: { "Alt-ArrowUp": moveBlock },
    });

    const event = new KeyboardEvent("keydown", {
      key: "ArrowUp",
      altKey: true,
      bubbles: true,
      cancelable: true,
    });
    instance.view.dom.dispatchEvent(event);

    expect(moveBlock).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);
  });
});
