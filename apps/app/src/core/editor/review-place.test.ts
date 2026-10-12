// @vitest-environment jsdom
/**
 * Where the reader of a paint cover lands in the editor that replaces it. The
 * cover is a copy of the old review's DOM, stamped with the blocks' Yjs
 * identities at capture; the successor is another Y.Doc that kept the surviving
 * items and gained the originals a Discard restores. Geometry is the browser's;
 * the real editors, Yjs binding and DOM walk are under test.
 */
import { Editor } from "@tiptap/core";
import { afterEach, expect, it } from "vitest";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import { createEditorConfig } from "./config";
import { createLocalPresence } from "./local-presence";
import {
  annotateCoverBlocks,
  captureReviewPlace,
  readCoverView,
  restoreReviewPlace,
} from "./review-place";
import { PROSEMIRROR_FRAGMENT_NAME } from "./schema";

const BLOCK = 60;
const editors: Editor[] = [];
afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy();
  document.body.replaceChildren();
});

function paragraph(text: string) {
  const block = new Y.XmlElement("paragraph");
  if (text) {
    const content = new Y.XmlText();
    block.insert(0, [content]);
    content.insert(0, text);
  }
  return block;
}

function mount(doc: Y.Doc) {
  const editor = new Editor(
    createEditorConfig({
      document: doc,
      presence: createLocalPresence(new Awareness(doc)),
      showCollaborationDecorations: false,
    }),
  );
  editors.push(editor);
  const pane = document.createElement("div");
  pane.className = "meridian-editor";
  Object.defineProperty(pane, "clientHeight", { value: 300 });
  pane.append(editor.view.dom);
  document.body.append(pane);
  return { editor, pane };
}

/** Lay out `prose`'s children top to bottom under a pane scrolled by `scrollTop`. */
function layout(pane: HTMLElement, heights: number[], scrollTop: number) {
  const rect = (top: number, height: number) =>
    ({
      top,
      bottom: top + height,
      height,
      left: 0,
      right: 100,
      width: 100,
      x: 0,
      y: top,
    }) as DOMRect;
  pane.getBoundingClientRect = () => rect(0, 300);
  let top = -scrollTop;
  for (const [index, child] of Array.from(
    pane.querySelector(".ProseMirror")?.children ?? [],
  ).entries()) {
    const height = heights[index] ?? BLOCK;
    const at = top;
    (child as HTMLElement).getBoundingClientRect = () => rect(at, height);
    // A removal widget: a button, then its paragraphs.
    let inside = at;
    for (const part of Array.from(child.children)) {
      const partHeight = part.tagName === "P" ? BLOCK : 30;
      const partTop = inside;
      (part as HTMLElement).getBoundingClientRect = () => rect(partTop, partHeight);
      inside += partHeight;
    }
    top += height;
  }
}

function widget(paragraphs: string[], { open = true, folded = false } = {}) {
  const root = document.createElement("div");
  root.className = "meridian-review-removal meridian-review-removal-block meridian-review-restored";
  root.setAttribute("data-review-removed-blocks", String(paragraphs.length));
  if (open || folded)
    root.append(Object.assign(document.createElement("button"), { type: "button" }));
  if (!folded)
    for (const text of paragraphs)
      root.append(Object.assign(document.createElement("p"), { textContent: text }));
  return root;
}

/**
 * The old review (blocks `before`, with `widgets` drawn among them) read at
 * `scrollTop`, and its successor: the same items plus `restored` paragraphs at
 * `at`. Returns the block the successor scrolls to, by the text at the pane's top.
 */
function landing(options: {
  before: string[];
  widgetAt: number;
  widgetElement: HTMLElement;
  widgetBlocks: number;
  restored: string[];
  scrollTop: number;
  stamp?: boolean;
  /** A block that arrived in the successor above everything (a peer's, the writer's unsent). */
  peerAbove?: string;
}): { text: string; offset: number } | null {
  const old = new Y.Doc();
  old.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME).insert(0, options.before.map(paragraph));
  const live = mount(old);
  const children = live.editor.view.dom.children;
  children[options.widgetAt - 1]?.after(options.widgetElement);
  const heights = Array.from(live.editor.view.dom.children).map((child) =>
    child === options.widgetElement
      ? BLOCK * options.widgetBlocks + (options.widgetElement.querySelector("button") ? 30 : 0)
      : BLOCK,
  );
  const cover = document.createElement("div");
  const copyPane = live.pane.cloneNode(true) as HTMLElement;
  if (options.stamp !== false) annotateCoverBlocks(live.pane, copyPane);
  else
    for (const node of copyPane.querySelectorAll("[data-review-block-anchor]"))
      node.removeAttribute("data-review-block-anchor");
  cover.append(copyPane);
  document.body.append(cover);
  layout(copyPane, heights, options.scrollTop);
  const view = readCoverView(cover);
  if (!view) return null;

  const next = new Y.Doc();
  Y.applyUpdate(next, Y.encodeStateAsUpdate(old));
  next
    .getXmlFragment(PROSEMIRROR_FRAGMENT_NAME)
    .insert(options.widgetAt, options.restored.map(paragraph));
  if (options.peerAbove)
    next.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME).insert(0, [paragraph(options.peerAbove)]);
  const successor = mount(next);
  let scrolled = 0;
  Object.defineProperty(successor.pane, "scrollTop", {
    get: () => scrolled,
    set: (value: number) => {
      scrolled = value;
    },
  });
  const texts = Array.from(
    { length: next.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME).length },
    (_, i) => successor.editor.state.doc.child(i).textContent,
  );
  const { doc } = successor.editor.state;
  let position = 0;
  const starts = texts.map((_, i) => {
    const at = position;
    position += doc.child(i).nodeSize;
    return at;
  });
  const placed = (pos: number) => starts.indexOf(pos);
  successor.editor.view.nodeDOM = ((pos: number) => {
    const index = placed(pos);
    if (index < 0) return null;
    const element = document.createElement("p");
    element.getBoundingClientRect = () =>
      ({
        top: index * BLOCK - scrolled,
        bottom: (index + 1) * BLOCK - scrolled,
        height: BLOCK,
      }) as DOMRect;
    return element;
  }) as typeof successor.editor.view.nodeDOM;
  captureReviewPlace("draft", live.editor, false);
  // The reader scrolled the cover, so the capsule's viewport is not the place: the cover's view is.
  restoreReviewPlace("draft", successor.editor, view);
  const index = Math.round((scrolled + view.offset) / BLOCK);
  return { text: texts[index] ?? "", offset: scrolled };
}

it("restores below an expanded removal to the block the reader saw, not the one the button shifted it to", () => {
  const found = landing({
    before: ["Opening line.", "Yes.", "No."],
    widgetAt: 1,
    // An open fold: a toggle button, then the two original paragraphs.
    widgetElement: widget(["The elder bowed.", "The hall fell silent."]),
    widgetBlocks: 2,
    restored: ["The elder bowed.", "The hall fell silent."],
    // Cover: Opening 0..60, widget 60..210, Yes. 210..270. The reader's top edge is at "Yes.".
    scrollTop: 210,
  });
  expect(found?.text).toBe("Yes.");
});

it("restores the first of two restored paragraphs that begin alike, not the second", () => {
  const same = "The same paragraph beginning that repeats beyond forty-eight characters: ";
  const found = landing({
    before: ["Opening line.", "Yes."],
    widgetAt: 1,
    widgetElement: widget([`${same}FIRST`, `${same}SECOND`]),
    widgetBlocks: 2,
    restored: [`${same}FIRST`, `${same}SECOND`],
    // The reader's top edge is at the widget's first paragraph (below its button).
    scrollTop: 90,
  });
  expect(found?.text).toBe(`${same}FIRST`);
});

it("counts a folded removal as the blocks it stands for", () => {
  const found = landing({
    before: ["Opening line.", "Yes.", "No."],
    widgetAt: 1,
    widgetElement: widget(["one", "two", "three"], { folded: true }),
    widgetBlocks: 1,
    restored: ["one", "two", "three"],
    // Cover: Opening 0..60, the fold 60..150 (button), Yes. 150..210.
    scrollTop: 150,
  });
  expect(found?.text).toBe("Yes.");
});

it("tells repeated scene breaks apart by the item each one is", () => {
  const found = landing({
    before: ["Opening line.", "* * *", "* * *", "* * *", "Last line."],
    widgetAt: 1,
    widgetElement: widget(["Restored one.", "Restored two."]),
    widgetBlocks: 2,
    restored: ["Restored one.", "Restored two."],
    // Cover: Opening 0..60, widget 60..210 (button), breaks at 210, 270, 330. Top edge on the second.
    scrollTop: 270,
    // The writer's unsent line arrived above everything: the count is off by one, the identity is not.
    peerAbove: "Typed meanwhile.",
  });
  // Block 5 of the successor (typed, Opening, two restored, first break, the second).
  expect(found).toEqual({ text: "* * *", offset: 5 * BLOCK });
});

it("counts the view among the blocks when the cover holds no identities", () => {
  const found = landing({
    before: ["Opening line.", "Yes.", "No."],
    widgetAt: 1,
    widgetElement: widget(["The elder bowed.", "The hall fell silent."]),
    widgetBlocks: 2,
    restored: ["The elder bowed.", "The hall fell silent."],
    scrollTop: 210,
    stamp: false,
  });
  expect(found?.text).toBe("Yes.");
});
