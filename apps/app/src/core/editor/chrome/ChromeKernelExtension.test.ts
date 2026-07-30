// @vitest-environment jsdom
import { Editor, type JSONContent, Node } from "@tiptap/core";
import { NodeSelection } from "@tiptap/pm/state";
import { afterEach, describe, expect, it, vi } from "vitest";

import { installJsdomLayout } from "@/test-support/jsdom-layout";

import { createStandaloneEditorExtensions } from "../config";

import { editorChromeAttributes, getEditorChrome } from "./ChromeKernelExtension";

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

/**
 * A node view that swallows events the way TipTap's does.
 *
 * TipTap's `NodeView.stopEvent` returns false for `mousedown` on a selectable
 * node — which is why click-to-select works — and then falls through to
 * `return true` for everything else, `contextmenu` included. ProseMirror
 * consults `stopEvent` in `eventBelongsToView` BEFORE it runs any
 * `handleDOMEvents`, so a router that lives in that prop is invisible inside
 * every React node view in this editor: image, figure, jsx_leaf,
 * jsx_container. This fixture is that mechanism with no React in it.
 */
const SwallowingNodeView = Node.create({
  name: "swallowing_rule",
  group: "block",
  atom: true,
  selectable: true,
  parseHTML: () => [{ tag: "div[data-swallowing]" }],
  renderHTML: () => ["div", { "data-swallowing": "" }],
  addNodeView() {
    return () => {
      const dom = document.createElement("div");
      dom.dataset.swallowing = "";
      dom.append(document.createElement("img"));
      dom.append(document.createElementNS("http://www.w3.org/2000/svg", "svg"));
      return { dom, stopEvent: (event: Event) => event.type !== "mousedown" };
    };
  },
});

function mount(content: JSONContent[], extras: Node[] = []): Editor {
  const element = document.createElement("div");
  document.body.append(element);
  // jsdom has no layout, so ProseMirror's `posAtCoords` has nothing to hit
  // test against and its key handling throws where it measures a line. The
  // claim ladder's routing matrix is covered as data in
  // `context-claims.test.ts`; what this file proves is the wiring.
  installJsdomLayout();
  editor = new Editor({
    element,
    extensions: [...createStandaloneEditorExtensions(), ...extras],
    content: { type: "doc", content },
  });
  return editor;
}

/**
 * Escape, and what the editor did about it.
 *
 * NOT `defaultPrevented`: ProseMirror's own `captureKeyDown` calls
 * `preventDefault` on keyCode 27 whether or not anything handled the key, so
 * the flag reports ProseMirror rather than the chain. The kernel's answer is
 * the state it left behind, which is what these tests read.
 */
function pressEscape(instance: Editor): { owner: string; layers: number } {
  const event = new KeyboardEvent("keydown", {
    key: "Escape",
    keyCode: 27,
    bubbles: true,
    cancelable: true,
  });
  instance.view.dom.dispatchEvent(event);
  const chrome = getEditorChrome(instance);
  return { owner: chrome?.context.owner ?? "document", layers: chrome?.layers.length ?? 0 };
}

function press(instance: Editor, init: KeyboardEventInit): boolean {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  instance.view.dom.dispatchEvent(event);
  return event.defaultPrevented;
}

function rightClick(instance: Editor, init: MouseEventInit = {}): MouseEvent {
  const event = new MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
    button: 2,
    ...init,
  });
  instance.view.dom.dispatchEvent(event);
  return event;
}

/**
 * A press, and the two answers that decide who owns it: whether a plugin told
 * ProseMirror it was handled — which is what makes ProseMirror skip its own
 * mouse machinery for that event — and whether anything refused its default.
 */
function mousePress(
  instance: Editor,
  button: number,
): { handledByPlugin: boolean; prevented: boolean } {
  const event = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button });
  const handled = instance.view.someProp("handleDOMEvents", (handlers) =>
    handlers.mousedown?.(instance.view, event),
  );
  return { handledByPlugin: handled === true, prevented: event.defaultPrevented };
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

    // One: the menu. The object is still selected under it.
    expect(pressEscape(instance)).toEqual({ owner: "object", layers: 0 });
    expect(close).toHaveBeenCalledOnce();
    layer.release();

    // Two: the object.
    expect(pressEscape(instance)).toEqual({ owner: "document", layers: 0 });
    const home = instance.state.selection;

    // Three: home leaves everything exactly where it was, which is the whole
    // content of "the editor gave the key back".
    expect(pressEscape(instance)).toEqual({ owner: "document", layers: 0 });
    expect(instance.state.selection.eq(home)).toBe(true);
  });

  it("walks home off a selected plain fence", () => {
    const instance = mount([
      paragraph("before"),
      { type: "code_block", attrs: { language: "ts" }, content: [{ type: "text", text: "x" }] },
      paragraph("after"),
    ]);
    let fencePos = 0;
    instance.state.doc.descendants((node, pos) => {
      if (node.type.name === "code_block") fencePos = pos;
    });
    instance.view.dispatch(
      instance.state.tr.setSelection(NodeSelection.create(instance.state.doc, fencePos)),
    );

    expect(pressEscape(instance)).toEqual({ owner: "document", layers: 0 });
    expect(instance.state.selection.$head.parent.textContent).toBe("after");
  });

  it("keeps a non-primary press out of ProseMirror's click machinery", () => {
    // ProseMirror arms that machinery on ANY button and runs the whole click
    // path on the matching release: `handleClickOn`, then its own
    // `selectClickedLeaf`. On a right-click the release lands after the claim
    // ladder has already opened the menu, and selecting a node there syncs the
    // selection back into the editor, taking focus out of the menu and
    // dismissing it — which is how a quick right-click on a diagram came to
    // show nothing while a held one worked.
    const instance = mount([paragraph("before"), figure]);

    expect(mousePress(instance, 2).handledByPlugin).toBe(true);
  });

  it("refuses no default on that press, so the menu still comes (ruling 11)", () => {
    // `contextmenu` is raised from the press on Linux and macOS and from the
    // release on Windows. Refusing either default is how a claim ladder ends
    // up with no event to route and a writer with no menu at all.
    const instance = mount([paragraph("before"), figure]);

    expect(mousePress(instance, 2).prevented).toBe(false);
  });

  it("leaves the primary press to the document", () => {
    // Caret placement, drag-selection, and the sweep the surfaces stand down
    // for are all ProseMirror's on the primary button.
    const instance = mount([paragraph("before"), figure]);

    expect(mousePress(instance, 0).handledByPlugin).toBe(false);
  });

  it("leaves a right-click to the browser when no lane took its rung", () => {
    const instance = mount([paragraph("The thrid gate opened.")]);
    expect(rightClick(instance).defaultPrevented).toBe(false);
  });

  it("hands Shift+right-click to the browser, where spellcheck lives", () => {
    const instance = mount([paragraph("The thrid gate opened.")]);
    const chrome = getEditorChrome(instance);
    if (!chrome) throw new Error("kernel did not mount");

    const claim = vi.fn(() => true);
    chrome.registerContextClaim({ id: "caret", claim });

    expect(rightClick(instance, { shiftKey: true }).defaultPrevented).toBe(false);
    expect(claim).not.toHaveBeenCalled();
    // The same pointer without the modifier is the editor's.
    expect(rightClick(instance).defaultPrevented).toBe(true);
  });

  it("routes a right-click inside a node view that swallows events", () => {
    const instance = mount(
      [paragraph("before"), { type: "swallowing_rule" }],
      [SwallowingNodeView],
    );
    const chrome = getEditorChrome(instance);
    if (!chrome) throw new Error("kernel did not mount");

    const claim = vi.fn(() => true);
    chrome.registerContextClaim({ id: "object", claim });

    // The pointer is on the node view's own DOM, which is where a writer
    // right-clicks an image or a figure — the two object types ruling 11 and
    // §5.2 are actually about.
    const inside = instance.view.dom.querySelector("img");
    if (!inside) throw new Error("node view did not render");
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 });
    inside.dispatchEvent(event);

    expect(claim).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);
  });

  it("gives portalled chrome to its own editor and to no other", () => {
    const first = mount([paragraph("first document")]);
    const firstChrome = getEditorChrome(first);
    if (!firstChrome) throw new Error("kernel did not mount");

    // A second document open in the next pane, with its own kernel listening
    // on the same document.
    const secondElement = document.createElement("div");
    document.body.append(secondElement);
    const second = new Editor({
      element: secondElement,
      extensions: createStandaloneEditorExtensions(),
      content: { type: "doc", content: [paragraph("second document")] },
    });
    const secondChrome = getEditorChrome(second);
    if (!secondChrome) throw new Error("second kernel did not mount");

    const firstClaim = vi.fn(() => true);
    const secondClaim = vi.fn(() => true);
    firstChrome.registerContextClaim({ id: "object", claim: firstClaim });
    secondChrome.registerContextClaim({ id: "object", claim: secondClaim });

    // An overlay row belonging to the first editor, portalled to the body.
    const row = document.createElement("div");
    for (const [name, value] of Object.entries(editorChromeAttributes(firstChrome))) {
      row.setAttribute(name, value);
    }
    document.body.append(row);
    row.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 }),
    );

    expect(firstClaim).toHaveBeenCalledOnce();
    expect(secondClaim).not.toHaveBeenCalled();

    second.destroy();
    row.remove();
    secondElement.remove();
  });

  it("routes a right-click on an SVG target", () => {
    const instance = mount(
      [paragraph("before"), { type: "swallowing_rule" }],
      [SwallowingNodeView],
    );
    const chrome = getEditorChrome(instance);
    if (!chrome) throw new Error("kernel did not mount");

    const claim = vi.fn(() => true);
    chrome.registerContextClaim({ id: "object", claim });

    // A mermaid diagram is SVG, and so is every icon in an overlay row. A
    // router that only knows HTMLElement hands both to the browser.
    const svg = instance.view.dom.querySelector("svg");
    if (!svg) throw new Error("node view did not render");
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 });
    svg.dispatchEvent(event);

    expect(claim).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);
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

  it("rejects an Escape binding at registration, and later lanes still land", () => {
    const instance = mount([paragraph("before")]);
    const chrome = getEditorChrome(instance);
    if (!chrome) throw new Error("kernel did not mount");

    const registeredBefore = chrome.keymapContributions().length;

    expect(() =>
      chrome.registerKeymap({
        id: "greedy-lane",
        scope: "layer",
        layer: null,
        bindings: { Escape: () => true, "Alt-ArrowUp": () => true },
      }),
    ).toThrow(/Esc chain owns it/);

    // The refusal has to leave the registry usable. A guard against silent
    // rejection that drops every later lane's keys is a worse silent
    // rejection than the one it was written to prevent.
    expect(chrome.keymapContributions()).toHaveLength(registeredBefore);

    const laterLane = vi.fn(() => true);
    chrome.registerKeymap({
      id: "block-movement",
      scope: "document",
      bindings: { "Alt-ArrowDown": laterLane },
    });

    press(instance, { key: "ArrowDown", altKey: true });
    expect(laterLane).toHaveBeenCalledOnce();
  });

  it("holds a scoped binding back until its context is the one under the caret", () => {
    const instance = mount([
      paragraph("plain prose"),
      {
        type: "table",
        content: [
          {
            type: "table_row",
            content: [
              { type: "table_header", content: [paragraph("Rank")] },
              { type: "table_header", content: [paragraph("Skill")] },
            ],
          },
        ],
      },
    ]);
    const chrome = getEditorChrome(instance);
    if (!chrome) throw new Error("kernel did not mount");

    const moveRow = vi.fn(() => true);
    chrome.registerKeymap({
      id: "table-chrome",
      scope: "table",
      bindings: { "Alt-ArrowUp": moveRow },
    });

    // The caret is in a paragraph. A row move has nothing to move, and the
    // scope is what says so — otherwise every lane has to rediscover its own
    // guard and one missed check shadows an outer verb document-wide.
    instance.commands.setTextSelection(3);
    expect(press(instance, { key: "ArrowUp", altKey: true })).toBe(false);
    expect(moveRow).not.toHaveBeenCalled();

    let cellPos = 0;
    instance.state.doc.descendants((node, pos) => {
      if (!cellPos && node.type.name === "table_header") cellPos = pos + 2;
    });
    instance.commands.setTextSelection(cellPos);
    expect(press(instance, { key: "ArrowUp", altKey: true })).toBe(true);
    expect(moveRow).toHaveBeenCalledOnce();
  });

  it("holds a layer-scoped binding back until a surface is open", () => {
    const instance = mount([paragraph("before")]);
    const chrome = getEditorChrome(instance);
    if (!chrome) throw new Error("kernel did not mount");

    // The slash menu's own case: its trigger registers the arrow keys before
    // React opens the popover that becomes their layer, so they name none.
    const menuArrow = vi.fn(() => true);
    chrome.registerKeymap({
      id: "slash-menu",
      scope: "layer",
      layer: null,
      bindings: { ArrowDown: menuArrow },
    });

    press(instance, { key: "ArrowDown" });
    expect(menuArrow).not.toHaveBeenCalled();

    chrome.openLayer({ id: "slash", close: () => {} });
    press(instance, { key: "ArrowDown" });
    expect(menuArrow).toHaveBeenCalledOnce();
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

describe("who owns the key", () => {
  /** An element outside the prose, which is where portalled chrome puts focus. */
  function pressOutsideTheProse(init: KeyboardEventInit): KeyboardEvent {
    const outside = document.createElement("button");
    document.body.append(outside);
    const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
    outside.dispatchEvent(event);
    outside.remove();
    return event;
  }

  it("gives a chord to the deepest open layer, not the first one that registered", () => {
    const instance = mount([paragraph("before")]);
    const chrome = getEditorChrome(instance);
    if (!chrome) throw new Error("kernel did not mount");

    // The order a writer produces: the dialog opens and registers its chord,
    // and the pane it opens INSIDE itself comes second. Arrival order says the
    // dialog; depth says the pane, and depth is the design (law 4).
    const openPane = vi.fn(() => true);
    const closePane = vi.fn(() => true);
    const dialog = chrome.openLayer({ id: "diagram-dialog", close: () => {} });
    chrome.registerKeymap({
      id: "diagram-dialog",
      scope: "layer",
      layer: dialog.layer,
      bindings: { "Mod-Enter": openPane },
    });
    const pane = chrome.openLayer({
      id: "diagram-source",
      parentId: dialog.id,
      close: () => {},
    });
    chrome.registerKeymap({
      id: "diagram-source",
      scope: "layer",
      layer: pane.layer,
      bindings: { "Mod-Enter": closePane },
    });

    expect(press(instance, { key: "Enter", ctrlKey: true })).toBe(true);
    expect(closePane).toHaveBeenCalledOnce();
    expect(openPane).not.toHaveBeenCalled();
  });

  it("stops offering a layer's keys the moment that layer closes", () => {
    const instance = mount([paragraph("before")]);
    const chrome = getEditorChrome(instance);
    if (!chrome) throw new Error("kernel did not mount");

    const paneKey = vi.fn(() => true);
    const dialog = chrome.openLayer({ id: "diagram-dialog", close: () => {} });
    const pane = chrome.openLayer({ id: "diagram-source", parentId: dialog.id, close: () => {} });
    chrome.registerKeymap({
      id: "diagram-source",
      scope: "layer",
      layer: pane.layer,
      bindings: { "Mod-Enter": paneKey },
    });

    // The pane released; the dialog around it is still open, so layer scope is
    // still live. The pane's keys are not. (The chord itself stays handled —
    // Ctrl+Enter is TipTap's hard break once no surface wants it — so what the
    // assertion reads is the binding, not the key.)
    pane.release();
    press(instance, { key: "Enter", ctrlKey: true });
    expect(paneKey).not.toHaveBeenCalled();
  });

  it("cancels an in-flight gesture on an Escape pressed outside the prose", () => {
    const instance = mount([paragraph("before")]);
    const chrome = getEditorChrome(instance);
    if (!chrome) throw new Error("kernel did not mount");

    const cancelDrag = vi.fn();
    chrome.beginDrag(cancelDrag);
    expect(chrome.gesture).toBe("drag");

    // A drag started from the margin handle leaves focus on portalled chrome,
    // where ProseMirror hears nothing: the kernel's document route is the only
    // one left, and the gesture is the deepest rung of the walk home (§5.8).
    const event = pressOutsideTheProse({ key: "Escape" });

    expect(cancelDrag).toHaveBeenCalledOnce();
    expect(chrome.gesture).toBe("idle");
    expect(event.defaultPrevented).toBe(true);
  });

  it("leaves the selection alone for an Escape pressed outside the prose", () => {
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

    // Nothing is open and no gesture is running, so the next step home moves
    // the caret — and the writer's hands are in the chat composer. Escape is
    // theirs there, not the manuscript's.
    const event = pressOutsideTheProse({ key: "Escape" });

    expect(chrome.context.owner).toBe("object");
    expect(event.defaultPrevented).toBe(false);
  });
});
