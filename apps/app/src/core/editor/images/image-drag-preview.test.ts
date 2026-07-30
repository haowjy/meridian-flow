// @vitest-environment jsdom
import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";

import { createStandaloneEditorExtensions } from "../config";
import { DRAG_PREVIEW_MAX_EDGE, dragPreviewBox } from "./image-drag-preview";

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
 * A real editor, because the whole point of this plugin is WHERE it listens: on
 * `window`, so it has the last word over the drag image TipTap's node view sets
 * from React. The node view's two elements are built by hand in the shape TipTap
 * and ProseMirror produce — jsdom lays nothing out, so the picture's box is
 * stubbed — and the event is really dispatched, so it really has to bubble all
 * the way up to be heard.
 */
describe("a dragstart over a picture", () => {
  let editor: Editor | null = null;

  afterEach(() => {
    editor?.destroy();
    editor = null;
    for (const stray of window.document.body.querySelectorAll("div, span")) stray.remove();
  });

  function mount(): Editor {
    const element = window.document.createElement("div");
    window.document.body.append(element);
    editor = new Editor({ element, extensions: createStandaloneEditorExtensions() });
    return editor;
  }

  /** An image node view, as ProseMirror and TipTap build it, inside the editor. */
  function nodeViewIn(instance: Editor, options: { picture?: boolean } = {}): HTMLElement {
    const outer = window.document.createElement("span");
    outer.className = "react-renderer node-image";
    const body = window.document.createElement("span");
    body.className = "meridian-image-node";
    body.dataset.type = "image";
    if (options.picture !== false) {
      const picture = window.document.createElement("img");
      Object.defineProperty(picture, "complete", { value: true });
      picture.getBoundingClientRect = () =>
        ({ left: 100, top: 50, width: 600, height: 375 }) as DOMRect;
      body.append(picture);
    }
    outer.append(body);
    instance.view.dom.append(outer);
    return outer;
  }

  function dragstartOn(source: Element, at: { clientX: number; clientY: number }) {
    const named: { element: Element; x: number; y: number }[] = [];
    const event = new window.Event("dragstart", { bubbles: true, cancelable: true });
    Object.defineProperties(event, {
      // Enough of a DataTransfer for ProseMirror's own dragstart handler to run
      // to the end on the way past, which is the point: the gesture it starts is
      // what carries the picture.
      dataTransfer: {
        value: {
          files: [],
          clearData: () => undefined,
          setData: () => undefined,
          effectAllowed: "",
          setDragImage: (element: Element, x: number, y: number) => named.push({ element, x, y }),
        },
      },
      clientX: { value: at.clientX },
      clientY: { value: at.clientY },
    });
    source.dispatchEvent(event);
    return { event, named };
  }

  it("names a capped drag image and lets the gesture continue", () => {
    const outer = nodeViewIn(mount());

    const { event, named } = dragstartOn(outer, { clientX: 400, clientY: 200 });

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

  it("hears a drag that started on the picture itself, not the node view", () => {
    const picture = nodeViewIn(mount()).querySelector("img");
    if (!picture) throw new Error("no picture");

    const { named } = dragstartOn(picture, { clientX: 400, clientY: 200 });

    expect(named).toHaveLength(1);
  });

  it("names nothing for a drag that did not start on a picture", () => {
    const instance = mount();
    nodeViewIn(instance);
    const prose = window.document.createElement("p");
    instance.view.dom.append(prose);

    const { named } = dragstartOn(prose, { clientX: 10, clientY: 10 });

    expect(named).toEqual([]);
  });

  it("leaves a slot with no picture yet to the browser's own preview", () => {
    const outer = nodeViewIn(mount(), { picture: false });

    const { named } = dragstartOn(outer, { clientX: 400, clientY: 200 });

    expect(named).toEqual([]);
  });

  it("ignores a picture outside its own editor, and stops listening when destroyed", () => {
    const instance = mount();
    const outer = nodeViewIn(instance);
    window.document.body.append(outer);

    expect(dragstartOn(outer, { clientX: 400, clientY: 200 }).named).toEqual([]);

    instance.view.dom.append(outer);
    expect(dragstartOn(outer, { clientX: 400, clientY: 200 }).named).toHaveLength(1);

    const orphan = instance.view.dom;
    instance.destroy();
    editor = null;
    orphan.append(outer);
    expect(dragstartOn(outer, { clientX: 400, clientY: 200 }).named).toEqual([]);
  });
});
