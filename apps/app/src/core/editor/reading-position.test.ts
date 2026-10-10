// @vitest-environment jsdom
/** Mount memory contracts: reload, shared panes, Yjs edits, and target precedence. */
import { Editor } from "@tiptap/core";
import { afterEach, expect, it, vi } from "vitest";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import { createEditorConfig } from "./config";
import { createLocalPresence } from "./local-presence";
import { captureReadingPosition, restoreReadingPosition } from "./reading-position";
import { claimDocumentTarget, mayRestoreReadingPosition } from "./reading-position-navigation";
import {
  READING_POSITION_LIMIT,
  READING_POSITION_STORAGE_KEY,
  ReadingPositionStore,
} from "./reading-position-store";
import { PROSEMIRROR_FRAGMENT_NAME } from "./schema";

const editors: Editor[] = [];
afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy();
  localStorage.clear();
  vi.restoreAllMocks();
});
function paragraph(text: string) {
  const block = new Y.XmlElement("paragraph");
  const content = new Y.XmlText();
  block.insert(0, [content]);
  content.insert(0, text);
  return block;
}
function view(doc: Y.Doc) {
  const editor = new Editor(
    createEditorConfig({
      document: doc,
      presence: createLocalPresence(new Awareness(doc)),
      showCollaborationDecorations: false,
    }),
  );
  editors.push(editor);
  const pane = document.createElement("div");
  document.body.append(pane);
  pane.append(editor.view.dom);
  vi.spyOn(pane, "getBoundingClientRect").mockReturnValue({
    top: 0,
    height: 100,
    width: 100,
    left: 0,
    right: 100,
    bottom: 100,
    x: 0,
    y: 0,
    toJSON() {},
  });
  // Geometry is the browser boundary; the real PM/Yjs binding owns all positions.
  vi.spyOn(editor.view, "nodeDOM").mockImplementation((pos) => {
    const node = document.createElement("p");
    node.getBoundingClientRect = () => ({
      top: pos < 10 ? -100 : -10,
      bottom: pos < 10 ? -60 : 30,
      height: 40,
      left: 0,
      right: 100,
      width: 100,
      x: 0,
      y: 0,
      toJSON() {},
    });
    return node;
  });
  vi.spyOn(editor.view, "posAtCoords").mockReturnValue(null);
  return { editor, pane };
}
it("restores scroll and a backwards selection on reload, reopen, and another pane without focus", () => {
  const doc = new Y.Doc();
  doc
    .getXmlFragment(PROSEMIRROR_FRAGMENT_NAME)
    .insert(0, [paragraph("first paragraph"), paragraph("remember these words")]);
  const main = view(doc);
  main.editor.commands.setTextSelection({ from: 24, to: 20 });
  const place = captureReadingPosition(main.editor, main.pane);
  expect(place).not.toBeNull();
  if (!place) throw new Error("Expected a captured place");
  new ReadingPositionStore("a").save("chapter", place, 1);
  const dock = view(doc);
  vi.spyOn(dock.editor.view, "nodeDOM").mockImplementation(() => {
    const node = document.createElement("p");
    node.getBoundingClientRect = () => ({
      top: 120,
      bottom: 200,
      height: 80,
      left: 0,
      right: 100,
      width: 100,
      x: 0,
      y: 120,
      toJSON() {},
    });
    return node;
  });
  const stored = new ReadingPositionStore("a").load("chapter");
  if (!stored) throw new Error("Expected a stored place");
  expect(restoreReadingPosition(dock.editor, dock.pane, stored)).toBe(true);
  expect(dock.editor.state.selection.anchor).toBe(24);
  expect(dock.editor.state.selection.head).toBe(20);
  expect(dock.pane.scrollTop).toBe(140); // resized block: top 120 + quarter of height 80
  expect(dock.editor.isFocused).toBe(false);
});
it("keeps the same text after a peer inserts above and safely falls back when that text is deleted", () => {
  const doc = new Y.Doc();
  const fragment = doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME);
  fragment.insert(0, [paragraph("first paragraph"), paragraph("remember these words")]);
  const main = view(doc);
  main.editor.commands.setTextSelection(22);
  vi.spyOn(main.editor.view, "posAtCoords").mockReturnValue({ pos: 22, inside: 17 });
  vi.spyOn(main.editor.view, "coordsAtPos").mockReturnValue({
    top: -5,
    bottom: 15,
    left: 0,
    right: 0,
  });
  const place = captureReadingPosition(main.editor, main.pane);
  if (!place) throw new Error("Expected a captured place");
  const peer = new Y.Doc();
  Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
  peer.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME).insert(0, [paragraph("inserted above")]);
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer));
  const reopened = view(doc);
  vi.spyOn(reopened.editor.view, "coordsAtPos").mockReturnValue({
    top: 240,
    bottom: 280,
    left: 0,
    right: 0,
  });
  expect(restoreReadingPosition(reopened.editor, reopened.pane, place)).toBe(true);
  expect(
    reopened.editor.state.doc.textBetween(
      reopened.editor.state.selection.from,
      reopened.editor.state.selection.from + 5,
    ),
  ).toBe("mber ");
  expect(reopened.pane.scrollTop).toBe(250); // same text, different line height
  fragment.delete(2, 1);
  expect(() => restoreReadingPosition(reopened.editor, reopened.pane, place)).not.toThrow();
  expect(reopened.editor.state.selection.from).toBeLessThanOrEqual(
    reopened.editor.state.doc.content.size,
  );
});
it("lets pending Changes, heading/position and review targets win over mount memory", () => {
  const doc = new Y.Doc();
  doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME).insert(0, [paragraph("target passage")]);
  const { editor } = view(doc);
  const address = "https://app.localhost/projects/p/editor";
  expect(mayRestoreReadingPosition(editor, "chapter", false, address)).toBe(true);
  const release = claimDocumentTarget("chapter");
  expect(mayRestoreReadingPosition(editor, "chapter", false, address)).toBe(false);
  release();
  expect(mayRestoreReadingPosition(editor, "chapter", false, `${address}#heading`)).toBe(false);
  expect(mayRestoreReadingPosition(editor, "chapter", false, `${address}?draft=d`)).toBe(false);
  expect(mayRestoreReadingPosition(editor, "chapter", true, address)).toBe(false);
  editor.commands.showPassageMatches([{ from: 1, to: 3 }]);
  expect(mayRestoreReadingPosition(editor, "chapter", false, address)).toBe(false);
});
it("bounds device memory, rejects foreign/malformed accounts, and preserves the last pane's gesture", () => {
  const doc = new Y.Doc();
  doc
    .getXmlFragment(PROSEMIRROR_FRAGMENT_NAME)
    .insert(0, [paragraph("first paragraph"), paragraph("remember these words")]);
  const { editor, pane } = view(doc);
  const place = captureReadingPosition(editor, pane);
  if (!place) throw new Error("Expected a captured place");
  const store = new ReadingPositionStore("a");
  for (let i = 0; i <= READING_POSITION_LIMIT; i++) store.save(`d${i}`, place, i);
  expect(store.load("d0")).toBeNull();
  expect(store.load("d1")).toEqual(place);
  store.save("new", place, 500);
  store.save("new", { ...place, viewport: { ...place.viewport, offset: 0.9 } }, 400);
  expect(store.load("new")).toEqual(place);
  expect(new ReadingPositionStore("b").load("new")).toBeNull();
  localStorage.setItem(
    `${READING_POSITION_STORAGE_KEY}:a`,
    JSON.stringify({ version: 1, accountId: "b", entries: [] }),
  );
  expect(store.load("new")).toBeNull();
  localStorage.setItem(`${READING_POSITION_STORAGE_KEY}:a`, "{");
  expect(store.load("new")).toBeNull();
  const unavailable = new ReadingPositionStore("a", () => {
    throw new Error("denied");
  });
  expect(() => unavailable.save("chapter", place, 1)).not.toThrow();
  expect(unavailable.load("chapter")).toBeNull();
});
