// @vitest-environment jsdom
import { Editor } from "@tiptap/core";
import type { EditorView } from "@tiptap/pm/view";
import { afterEach, describe, expect, it } from "vitest";

import { createStandaloneEditorExtensions } from "../config";
import {
  DRAG_PREVIEW_MAX_EDGE,
  dragPreviewBox,
  imageDragPreviewPlugin,
} from "./image-drag-preview";

describe("the ghost's box", () => {
  it("shrinks a screenshot to the cap and keeps its proportions", () => {
    const box = dragPreviewBox(3200, 2000);

    expect(Math.max(box.width, box.height)).toBe(DRAG_PREVIEW_MAX_EDGE);
    expect(box.width / box.height).toBeCloseTo(3200 / 2000, 2);
  });

  it("caps a portrait picture on its own long edge", () => {
    const box = dragPreviewBox(1000, 3000);

    expect(box.height).toBe(DRAG_PREVIEW_MAX_EDGE);
    expect(box.width).toBe(80);
  });

  it("leaves a picture already smaller than the cap alone", () => {
    expect(dragPreviewBox(180, 120)).toEqual({ width: 180, height: 120, scale: 1 });
  });

  it("never rounds an edge away to nothing", () => {
    expect(dragPreviewBox(0.2, 0.2).width).toBe(1);
  });
});

/**
 * jsdom lays nothing out, so the picture's box is stubbed and the node view's
 * two elements are built by hand in the shape TipTap and ProseMirror produce:
 * an outer element the browser starts the drag from, with the picture's own body
 * as its single child. The handler reads nothing else.
 */
describe("a dragstart over a picture", () => {
  const plugin = imageDragPreviewPlugin();
  const handler = plugin.props.handleDOMEvents?.dragstart;
  if (!handler) throw new Error("the plugin names no dragstart handler");
  const view = {} as EditorView;
  const dragstart = (event: DragEvent) => handler.call(plugin, view, event);

  afterEach(() => {
    for (const stray of window.document.body.querySelectorAll("div")) stray.remove();
  });

  function nodeViewWithPicture(): HTMLElement {
    const outer = window.document.createElement("span");
    const body = window.document.createElement("span");
    body.className = "meridian-image-node";
    body.dataset.type = "image";
    const picture = window.document.createElement("img");
    Object.defineProperty(picture, "complete", { value: true });
    picture.getBoundingClientRect = () =>
      ({ left: 100, top: 50, width: 600, height: 375 }) as DOMRect;
    body.append(picture);
    outer.append(body);
    window.document.body.append(outer);
    return outer;
  }

  function dragstartOn(source: Element, at: { clientX: number; clientY: number }) {
    const named: { element: Element; x: number; y: number }[] = [];
    const event = new window.Event("dragstart", { bubbles: true, cancelable: true });
    Object.defineProperties(event, {
      target: { value: source },
      dataTransfer: {
        value: {
          setDragImage: (element: Element, x: number, y: number) => named.push({ element, x, y }),
        },
      },
      clientX: { value: at.clientX },
      clientY: { value: at.clientY },
    });
    return { event: event as DragEvent, named };
  }

  it("names a capped drag image and lets the gesture continue", () => {
    const outer = nodeViewWithPicture();
    const { event, named } = dragstartOn(outer, { clientX: 400, clientY: 200 });

    expect(dragstart(event)).toBe(false);
    expect(event.defaultPrevented).toBe(false);
    const ghost = named[0]?.element;
    if (!(ghost instanceof HTMLElement)) throw new Error("no drag image was named");
    expect(ghost.style.width).toBe("240px");
    expect(ghost.style.height).toBe("150px");
    expect(ghost.querySelector("img")).not.toBeNull();
    // The grip travels with the picture: 300px across a 600px picture is halfway
    // across a 240px ghost.
    expect(named[0]?.x).toBe(120);
    expect(named[0]?.y).toBe(60);
  });

  it("takes the body itself as the source, wherever `draggable` ended up", () => {
    const body = nodeViewWithPicture().firstElementChild;
    if (!body) throw new Error("no body");
    const { event, named } = dragstartOn(body, { clientX: 100, clientY: 50 });

    dragstart(event);

    expect(named).toHaveLength(1);
  });

  it("names nothing for a drag that did not start on a picture", () => {
    const prose = window.document.createElement("div");
    window.document.body.append(prose);
    const { event, named } = dragstartOn(prose, { clientX: 10, clientY: 10 });

    expect(dragstart(event)).toBe(false);
    expect(named).toEqual([]);
  });

  it("leaves a slot with no picture yet to the browser's own preview", () => {
    const outer = nodeViewWithPicture();
    outer.querySelector("img")?.remove();
    const { event, named } = dragstartOn(outer, { clientX: 400, clientY: 200 });

    expect(dragstart(event)).toBe(false);
    expect(named).toEqual([]);
  });
});

describe("the editor", () => {
  let editor: Editor | null = null;

  afterEach(() => {
    editor?.destroy();
    editor = null;
  });

  it("installs the preview plugin with the image node", () => {
    editor = new Editor({ extensions: createStandaloneEditorExtensions() });

    expect(
      editor.state.plugins.filter((plugin) => plugin.props.handleDOMEvents?.dragstart),
    ).toHaveLength(1);
  });
});
