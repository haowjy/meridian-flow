// @vitest-environment jsdom
/**
 * Where the reader of a paint cover lands in the editor that replaces it. The
 * cover is a copy of the old review's DOM, stamped with the blocks' Yjs
 * identities at capture; the successor is another Y.Doc that kept the surviving
 * items and gained the originals a Discard restores. Geometry is the browser's;
 * the real editors, Yjs binding and DOM walk are under test.
 */
import { getBlockItemId } from "@meridian/agent-edit";
import { blockItemKey } from "@meridian/contracts/drafts";
import { Editor } from "@tiptap/core";
import { afterEach, expect, it } from "vitest";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import { model, operation, span, textHunk } from "../../test-support/inline-review-editor";
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

function mount(doc: Y.Doc, enableDraftInlineReview = false) {
  const editor = new Editor(
    createEditorConfig({
      document: doc,
      enableDraftInlineReview,
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

/** The removal a cover draws for restored paragraphs: a button (hidden when restored), then one paragraph per block. */
function widget(paragraphs: string[], ids: (string | null)[]) {
  const root = document.createElement("div");
  root.className = "meridian-review-removal meridian-review-removal-block meridian-review-restored";
  root.setAttribute("data-review-removed-blocks", String(paragraphs.length));
  root.append(Object.assign(document.createElement("button"), { type: "button" }));
  for (const [index, text] of paragraphs.entries()) {
    const element = Object.assign(document.createElement("p"), { textContent: text });
    const id = ids[index];
    if (id) element.setAttribute("data-review-block-id", id);
    root.append(element);
  }
  return root;
}

const keyOf = (doc: Y.Doc, index: number) =>
  blockItemKey(
    getBlockItemId(doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME).get(index) as Y.XmlElement),
  );

/**
 * A Discard of a removal, as the draft's re-fork does it. LIVE holds `blocks`; the
 * old draft deleted the `restored` ones (at `at`, as a widget in the cover); the
 * successor is LIVE again, plus whatever `peers` inserted since. The reader of the
 * cover is at `scrollTop`. Returns the text of the block the successor scrolls to,
 * and the scroll.
 */
function landing(options: {
  blocks: string[];
  at: number;
  restored: number;
  scrollTop: number;
  /** Whether the removal's paragraphs name their live blocks (they do when the server gave them). */
  named?: boolean;
  /** Whether the cover's real blocks carry their items (they do when the binding lived at capture). */
  stamp?: boolean;
  /** Blocks that arrived in the successor, by the index they sit at there. */
  peers?: { index: number; text: string }[];
}): { text: string; scrolled: number } | null {
  const liveDoc = new Y.Doc();
  liveDoc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME).insert(0, options.blocks.map(paragraph));
  const ids = Array.from({ length: options.restored }, (_, i) => keyOf(liveDoc, options.at + i));
  const names = options.blocks.slice(options.at, options.at + options.restored);

  const oldDoc = new Y.Doc();
  Y.applyUpdate(oldDoc, Y.encodeStateAsUpdate(liveDoc));
  oldDoc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME).delete(options.at, options.restored);
  const old = mount(oldDoc);
  const removal = widget(names, options.named === false ? [] : ids);
  old.editor.view.dom.children[options.at - 1]?.after(removal);
  const heights = Array.from(old.editor.view.dom.children).map((child) =>
    child === removal ? BLOCK * options.restored + 30 : BLOCK,
  );
  const copyPane = old.pane.cloneNode(true) as HTMLElement;
  if (options.stamp !== false) annotateCoverBlocks(old.pane, copyPane);
  const cover = document.createElement("div");
  cover.append(copyPane);
  document.body.append(cover);
  layout(copyPane, heights, options.scrollTop);
  const view = readCoverView(cover);
  if (!view) return null;

  const nextDoc = new Y.Doc();
  Y.applyUpdate(nextDoc, Y.encodeStateAsUpdate(liveDoc));
  for (const peer of options.peers ?? [])
    nextDoc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME).insert(peer.index, [paragraph(peer.text)]);
  const successor = mount(nextDoc);
  let scrolled = 0;
  Object.defineProperty(successor.pane, "scrollTop", {
    get: () => scrolled,
    set: (value: number) => {
      scrolled = value;
    },
  });
  const { doc } = successor.editor.state;
  const texts = Array.from({ length: doc.childCount }, (_, i) => doc.child(i).textContent);
  const starts: number[] = [];
  doc.forEach((_node, offset) => {
    starts.push(offset);
  });
  successor.editor.view.nodeDOM = ((pos: number) => {
    const index = starts.indexOf(pos);
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
  captureReviewPlace("draft", old.editor, false);
  // The reader scrolled the cover, so the capsule's viewport is not the place: the cover's view is.
  restoreReviewPlace("draft", successor.editor, view);
  return { text: texts[Math.round((scrolled + view.offset) / BLOCK)] ?? "", scrolled };
}

// Cover: Opening 0..60, the removal 60..(60 + 60 per block + a 30px button), then the rest.
const BLOCKS = ["Opening line.", "The elder bowed.", "The hall fell silent.", "Yes.", "No."];

it("restores below an open removal to the block the reader saw, not the one its button shifted it to", () => {
  const found = landing({ blocks: BLOCKS, at: 1, restored: 2, scrollTop: 210 });
  expect(found?.text).toBe("Yes.");
});

it("restores the first of two restored paragraphs that begin alike, not the second", () => {
  const same = "The same paragraph beginning that repeats beyond forty-eight characters: ";
  const found = landing({
    blocks: ["Opening line.", `${same}FIRST`, `${same}SECOND`, "Yes."],
    at: 1,
    restored: 2,
    // The reader's top edge is at the removal's first paragraph, below its button.
    scrollTop: 90,
  });
  expect(found?.text).toBe(`${same}FIRST`);
});

it("lands on the restored paragraph when a block arrived between it and its neighbour", () => {
  // Cover: Opening, [Restored], Survivor, Tail. The successor has a block between Restored and Survivor.
  const blocks = ["Opening", "Restored", "Survivor", "Tail"];
  const found = landing({
    blocks,
    at: 1,
    restored: 1,
    scrollTop: 90,
    peers: [{ index: 2, text: "Peer inserted between" }],
  });
  expect(found?.text).toBe("Restored");
});

it("lands on the restored paragraph when blocks arrived above the group and inside it", () => {
  const found = landing({
    blocks: ["Opening", "Restored one", "Restored two", "Survivor"],
    at: 1,
    restored: 2,
    // The reader is at the first restored paragraph (60, then the 30px button).
    scrollTop: 90,
    peers: [
      { index: 0, text: "Typed meanwhile" },
      { index: 3, text: "Peer between the restored" },
    ],
  });
  expect(found?.text).toBe("Restored one");
});

it("tells repeated scene breaks apart by the item each one is", () => {
  const found = landing({
    blocks: [
      "Opening line.",
      "Restored one.",
      "Restored two.",
      "* * *",
      "* * *",
      "* * *",
      "Last line.",
    ],
    at: 1,
    restored: 2,
    // Cover: Opening 0..60, removal 60..210, breaks at 210, 270, 330. Top edge on the second.
    scrollTop: 270,
    // The writer's unsent line arrived above everything: a count would be off by one, the item is not.
    peers: [{ index: 0, text: "Typed meanwhile." }],
  });
  // Block 5 of the successor (typed, Opening, two restored, first break, the second).
  expect(found).toEqual({ text: "* * *", scrolled: 5 * BLOCK });
});

it("is approximate, and says so, when the removal does not name its blocks", () => {
  // Nothing names the restored paragraphs: the nearest stamped block and the distance to it decide.
  const found = landing({ blocks: BLOCKS, at: 1, restored: 2, scrollTop: 90, named: false });
  expect(found?.text).toBe("The elder bowed.");
});

it("counts the view among the blocks when the cover holds no items at all", () => {
  const found = landing({
    blocks: BLOCKS,
    at: 1,
    restored: 2,
    scrollTop: 210,
    stamp: false,
    named: false,
  });
  expect(found?.text).toBe("Yes.");
});

it("keeps native typing's latest caret through review projection and a generation swap", async () => {
  const doc = new Y.Doc();
  doc
    .getXmlFragment(PROSEMIRROR_FRAGMENT_NAME)
    .insert(0, [paragraph("Heading"), paragraph("Writer paragraph")]);
  const old = mount(doc, true);
  old.editor.commands.setInlineReviewModel(
    model(
      [operation("a1", "agent")],
      [
        textHunk(
          old.editor,
          "h1",
          ["a1"],
          { from: 1, to: 8 },
          { spans: [span(old.editor, "a1", 1, 8)] },
        ),
      ],
    ),
  );
  old.editor.view.focus();
  // Browser input can precede the observer's delivery while React projects the command.
  const text = old.editor.view.dom.lastElementChild?.firstChild as Text;
  text.appendData(" typed");
  const selection = window.getSelection();
  selection?.setBaseAndExtent(text, text.length, text, text.length);
  old.editor.view.dom.dispatchEvent(
    new InputEvent("input", { bubbles: true, inputType: "insertText", data: " typed" }),
  );
  old.editor.commands.setInlineReviewMarksVisible(false);
  await new Promise((resolve) => setTimeout(resolve, 30));
  captureReviewPlace("typing", old.editor, true);
  const nextDoc = new Y.Doc();
  Y.applyUpdate(nextDoc, Y.encodeStateAsUpdate(doc));
  nextDoc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME).insert(0, [paragraph("Peer block")]);
  const next = mount(nextDoc);
  restoreReviewPlace("typing", next.editor);
  expect(next.editor.state.selection.$head.parent.textContent).toBe("Writer paragraph typed");
  expect(next.editor.state.selection.$head.parentOffset).toBe("Writer paragraph typed".length);
});

it("falls back within the same surviving block when a caret's text type is absent in the refork", () => {
  const doc = new Y.Doc({ gc: false });
  doc
    .getXmlFragment(PROSEMIRROR_FRAGMENT_NAME)
    .insert(0, [paragraph("Heading"), paragraph("Writer paragraph")]);
  const nextDoc = new Y.Doc({ gc: false });
  Y.applyUpdate(nextDoc, Y.encodeStateAsUpdate(doc));
  const block = doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME).get(1) as Y.XmlElement;
  // The old generation acquired a text type that the successor does not have.
  const run = new Y.XmlText();
  block.insert(1, [run]);
  run.insert(0, " pending");
  const old = mount(doc);
  old.editor.commands.setTextSelection(old.editor.state.doc.content.size - 1);
  captureReviewPlace("missing-text", old.editor, false);
  nextDoc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME).insert(0, [paragraph("Peer block")]);
  const nextBlock = nextDoc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME).get(2) as Y.XmlElement;
  (nextBlock.get(0) as Y.XmlText).insert(0, "A peer inserted this long prefix. ");
  const next = mount(nextDoc);
  restoreReviewPlace("missing-text", next.editor);
  expect(next.editor.state.selection.$head.parent.textContent).toBe(
    "A peer inserted this long prefix. Writer paragraph",
  );
  expect(next.editor.state.selection.$head.parentOffset).toBe(
    "A peer inserted this long prefix. Writer paragraph".length,
  );
});
