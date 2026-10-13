// @vitest-environment jsdom
/** Real editor transactions protect draft authorship boundaries before Yjs allocation. */
import { afterEach, expect, it, vi } from "vitest";
import {
  createReviewEditor,
  destroyReviewEditors,
  model,
  operation,
  posOf,
  setModel,
  textHunk,
} from "@/test-support/inline-review-editor";

afterEach(() => {
  destroyReviewEditors();
  vi.unstubAllGlobals();
});

it("rotates across changes and disjoint untouched places, not pauses or same-change caret moves", () => {
  vi.stubGlobal("requestAnimationFrame", () => 1);
  const { editor, doc } = createReviewEditor([
    "The green serpent waits quietly.",
    "An untouched paragraph remains.",
    "Another untouched paragraph remains.",
  ]);
  const start = posOf(editor, "green");
  const end = posOf(editor, "quietly") + 7;
  setModel(
    editor,
    model([operation("ai", "agent")], [textHunk(editor, "ai", ["ai"], { from: start, to: end })]),
  );
  const first = doc.clientID;
  editor.commands.insertContentAt(start + 2, "WRITERBIT");
  expect(doc.clientID).toBe(first);
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
  editor.commands.setTextSelection(posOf(editor, "serpent") + 2);
  editor.commands.insertContent("X");
  expect(doc.clientID).toBe(first);
  editor.commands.setInlineReviewMarksVisible(false);
  editor.commands.insertContentAt(posOf(editor, "An untouched") + 5, "GOLDPLAIN");
  const second = doc.clientID;
  expect(second).not.toBe(first);
  editor.commands.insertContent("Y");
  expect(doc.clientID).toBe(second);
  editor.commands.insertContentAt(posOf(editor, "Another untouched") + 5, "ELSEWHERE");
  expect(doc.clientID).not.toBe(second);
  editor.commands.undo();
  expect(editor.getText()).not.toContain("ELSEWHERE");
});

it("rotates between AI classes, and between disjoint places in one untouched paragraph", () => {
  vi.stubGlobal("requestAnimationFrame", () => 1);
  const { editor, doc } = createReviewEditor([
    "First green sentence. Second green sentence.",
    "Untouched alpha and untouched omega.",
  ]);
  const first = posOf(editor, "First green");
  const second = posOf(editor, "Second green");
  setModel(
    editor,
    model(
      [operation("a", "agent"), operation("b", "agent")],
      [
        textHunk(editor, "a", ["a"], { from: first, to: first + 20 }),
        textHunk(editor, "b", ["b"], { from: second, to: second + 21 }),
      ],
    ),
  );
  editor.commands.insertContentAt(first + 5, "A");
  const a = doc.clientID;
  editor.commands.insertContentAt(posOf(editor, "Second green") + 5, "B");
  const b = doc.clientID;
  expect(b).not.toBe(a);
  editor.commands.insertContentAt(posOf(editor, "alpha") + 2, "C");
  const c = doc.clientID;
  expect(c).not.toBe(b);
  editor.commands.insertContentAt(posOf(editor, "omega") + 2, "D");
  expect(doc.clientID).not.toBe(c);
});

it("does not let a remote whole-document rebuild expand the last typing site", async () => {
  vi.stubGlobal("requestAnimationFrame", () => 1);
  const { editor, doc } = createReviewEditor([
    "Alpha untouched paragraph.",
    "Beta untouched paragraph.",
  ]);
  editor.commands.insertContentAt(posOf(editor, "Alpha") + 3, "WRITERBIT");
  const before = doc.clientID;
  const Y = await import("yjs");
  const peer = new Y.Doc({ gc: false });
  Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
  const fragment = peer.getXmlFragment("prosemirror");
  const paragraph = fragment.get(1) as import("yjs").XmlElement;
  const text = paragraph.get(0) as import("yjs").XmlText;
  let update: Uint8Array | null = null;
  peer.on("update", (delta: Uint8Array) => {
    update = delta;
  });
  text.insert(text.length, " Remote.");
  if (!update) throw new Error("missing remote update");
  Y.applyUpdate(doc, update, "remote");
  editor.commands.insertContentAt(posOf(editor, "WRITERBIT") + 9, "MORE");
  expect(doc.clientID).toBe(before);
  editor.commands.insertContentAt(posOf(editor, "Beta") + 3, "GOLDPLAIN");
  expect(doc.clientID).not.toBe(before);
  peer.destroy();
});
