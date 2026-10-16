// @vitest-environment jsdom
/**
 * Local Discard on a real review editor. It protects the ways a Discard can go wrong without an error:
 * eating the typing around it, taking a different change than the one clicked, and undoing a peer's work.
 */
import { classifyChanges, readRestorations, writeBlocks } from "@meridian/agent-edit/diff";
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import type { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { yUndoPluginKey } from "@tiptap/y-tiptap";
import { afterEach, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { draftInlineReviewPluginKey } from "@/core/editor/extensions/inline-review";
import { PROSEMIRROR_FRAGMENT_NAME } from "@/core/editor/schema";
import {
  blockForSelection,
  moveBlockStepTransaction,
} from "@/features/editor/surfaces/blocks/block-targets";
import {
  createReviewEditor,
  createRoomRuntime,
  destroyReviewEditors,
  posOf,
  seedReviewBase,
} from "@/test-support/inline-review-editor";
import { discardChange } from "./draft-discard";
import { projectRoom } from "./review-frame";
import { REVIEW_DEBOUNCE_MS, type ReviewRuntime, type ReviewSurface } from "./review-runtime";

afterEach(() => destroyReviewEditors());

/** An editor on the draft room; `shared` is another editor's room runtime, one runtime per room as in the app. */
function review(
  draft: string[],
  base: string[],
  shared?: { doc: Y.Doc; projector: ReviewRuntime },
  surface: ReviewSurface = "editor",
) {
  const { editor, doc, history } = createReviewEditor(draft, shared?.doc);
  if (!shared) seedReviewBase(doc, base);
  const projector = shared?.projector ?? createRoomRuntime(doc);
  const detach = projector.attachEditor(editor, surface);
  const handle = projector.editorHandle(editor) as NonNullable<
    ReturnType<ReviewRuntime["editorHandle"]>
  >;
  return { editor, doc, history, projector, handle, detach };
}

const paragraphs = (editor: Editor) => {
  const out: string[] = [];
  editor.state.doc.forEach((node) => {
    out.push(node.textContent);
  });
  return out;
};
const undo = (editor: Editor) => yUndoPluginKey.getState(editor.state)?.undoManager.undo();

/** A peer replica of the draft room: edit it, then hand its update to the editor like a server would. */
function peerOf(doc: Y.Doc) {
  const peer = new Y.Doc({ gc: false });
  Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
  const text = (paragraph: number) =>
    (peer.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME).get(paragraph) as Y.XmlElement).get(
      0,
    ) as Y.XmlText;
  return {
    peer,
    text,
    send: () => Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer, Y.encodeStateVector(doc)), "peer"),
  };
}

it("a Discard is one Ctrl+Z step, apart from the typing before and after it, even after the editor is rebuilt", () => {
  const {
    editor: first,
    doc,
    history,
    projector,
    handle,
  } = review(["The door was green.", "Keep me."], ["The door was red.", "Keep me."]);
  const shown = projector.projectNow();
  const id = shown?.groups[0]?.id as string;

  expect(discardChange(handle, shown as NonNullable<typeof shown>, id)).toBe("discarded");
  expect(paragraphs(first)).toEqual(["The door was red.", "Keep me."]);

  // Typing right after the Discard (inside the debounce window) is its own step.
  first.view.dispatch(first.state.tr.insertText("!", posOf(first, "Keep me.") + 8));
  expect(paragraphs(first)[1]).toBe("Keep me.!");

  // The document moves to the dock and back: the editor is rebuilt, the surface's history is not.
  first.destroy();
  const { editor } = createReviewEditor([], doc, history);
  expect(paragraphs(editor)).toEqual(["The door was red.", "Keep me.!"]);

  undo(editor);
  expect(paragraphs(editor)).toEqual(["The door was red.", "Keep me."]);
  undo(editor);
  expect(paragraphs(editor)).toEqual(["The door was green.", "Keep me."]);
});

it("with two editors on one runtime, each Ctrl+Z undoes only its own typing and its own Discard", () => {
  const a = review(
    ["Door green.", "One.", "Keep.", "Two.", "Lamp lit."],
    ["Door red.", "One.", "Keep.", "Two.", "Lamp dim."],
  );
  const b = review([], [], a, "dock");
  // A header names its surface, not an editor: each lands in its own editor, never the longest-attached.
  expect(a.projector.editorHandle("editor")).toBe(a.handle);
  expect(a.projector.editorHandle("dock")).toBe(b.handle);

  // Two editors over one room hold equal text in different documents: both paint the room's frame.
  a.projector.projectNow();
  for (const { editor } of [a, b]) {
    expect(draftInlineReviewPluginKey.getState(editor.state)?.review?.doc).toBe(editor.state.doc);
    expect(editor.view.dom.querySelectorAll("[data-review-change]").length).toBeGreaterThan(0);
  }

  const typeAfter = (editor: Editor, text: string) =>
    editor.view.dispatch(editor.state.tr.insertText(text, posOf(editor, "Keep.") + 5));
  typeAfter(a.editor, "!");
  typeAfter(b.editor, "?");
  expect(paragraphs(a.editor)[2]).toBe("Keep.?!");

  const shownA = a.projector.projectNow() as NonNullable<ReturnType<typeof a.projector.projectNow>>;
  discardChange(a.handle, shownA, shownA.groups[0].id);
  const shownB = b.projector.projectNow() as NonNullable<ReturnType<typeof b.projector.projectNow>>;
  discardChange(b.handle, shownB, shownB.groups[shownB.groups.length - 1].id);
  expect(paragraphs(a.editor)).toEqual(["Door red.", "One.", "Keep.?!", "Two.", "Lamp dim."]);

  // A's history holds its Discard and its "!" only: B's Discard and "?" stay through both undos.
  undo(a.editor);
  expect(paragraphs(a.editor)).toEqual(["Door green.", "One.", "Keep.?!", "Two.", "Lamp dim."]);
  undo(a.editor);
  expect(paragraphs(a.editor)).toEqual(["Door green.", "One.", "Keep.?", "Two.", "Lamp dim."]);
  undo(a.editor);
  expect(paragraphs(a.editor)).toEqual(["Door green.", "One.", "Keep.?", "Two.", "Lamp dim."]);

  // Detaching B removes exactly B: A still has its handle and still discards into its own history.
  expect(a.projector).toBe(b.projector);
  b.detach();
  expect(a.projector.editorHandle(b.editor)).toBeNull();
  const again = a.projector.projectNow() as NonNullable<ReturnType<typeof a.projector.projectNow>>;
  expect(discardChange(a.handle, again, again.groups[0].id)).toBe("discarded");
  undo(a.editor);
  expect(paragraphs(a.editor)).toEqual(["Door green.", "One.", "Keep.?", "Two.", "Lamp dim."]);
});

it("a paragraph that arrives inside the debounce window does not change which change goes", () => {
  const { editor, doc, projector, handle } = review(
    ["Alpha green.", "Filler one.", "Filler two.", "Filler three.", "Omega green."],
    ["Alpha red.", "Filler one.", "Filler two.", "Filler three.", "Omega red."],
  );
  const stale = projector.projectNow() as NonNullable<ReturnType<typeof projector.projectNow>>;
  const omega = stale.groups[1].id;

  // The writer types (the debounce is pending), then the AI's paragraph lands above everything.
  editor.view.dispatch(editor.state.tr.insertText("x", posOf(editor, "Filler one") + 3));
  const { peer, send } = peerOf(doc);
  const fragment = peer.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME);
  const added = new Y.XmlElement("paragraph");
  const run = new Y.XmlText();
  added.insert(0, [run]);
  run.insert(0, "The AI's new paragraph.");
  fragment.insert(0, [added]);
  send();

  expect(discardChange(handle, stale, omega)).toBe("discarded");
  expect(paragraphs(editor)).toEqual([
    "The AI's new paragraph.",
    "Alpha green.",
    "Filxler one.",
    "Filler two.",
    "Filler three.",
    "Omega red.",
  ]);
});

it("with two identical changes, a peer's identical change above never turns the click into the first one", () => {
  const filler = ["m1 a", "m2 b", "m3 c", "m4 d"];
  const base = ["one x two", ...filler, "one x two", ...filler, "one x two"];
  const draft = ["one x two", ...filler, "one y two", ...filler, "one y two"];
  const { editor, doc, projector, handle } = review(draft, base);
  const stale = projector.projectNow() as NonNullable<ReturnType<typeof projector.projectNow>>;
  expect(stale.groups.map((group) => group.id.split("~")[0])).toHaveLength(2);
  expect(new Set(stale.groups.map((group) => group.id.split("~")[0])).size).toBe(1);
  const lastClicked = stale.groups[1].id;

  // The same edit appears earlier in the document before the click lands: ranks shift by one.
  const { text, send } = peerOf(doc);
  const first = text(0);
  first.delete(4, 1);
  first.insert(4, "y");
  send();

  expect(discardChange(handle, stale, lastClicked)).toBe("discarded");
  const out = paragraphs(editor);
  expect(out[0]).toBe("one y two");
  expect(out[5]).toBe("one y two");
  expect(out[10]).toBe("one x two");
});

it("a change the click no longer names is left alone", () => {
  const { editor, doc, projector, handle } = review(
    ["Alpha green.", "Omega green."],
    ["Alpha red.", "Omega red."],
  );
  const stale = projector.projectNow() as NonNullable<ReturnType<typeof projector.projectNow>>;
  const id = stale.groups[0].id;
  // The AI rewrote the clicked change after the writer saw it: its hash is no longer the one clicked.
  const { text, send } = peerOf(doc);
  text(0).insert(0, "Extended ");
  send();
  expect(discardChange(handle, stale, id)).toBe("stale");
  expect(paragraphs(editor)).toEqual(["Extended Alpha green.", "Omega green."]);
});

it("an AI deletion in the same paragraph survives the Discard of a neighbouring change", () => {
  const base = ["alpha beta gamma delta epsilon zeta eta theta iota kappa"];
  const draft = ["ALPHA beta gamma delta epsilon zeta eta theta iota KAPPA"];
  const { editor, doc, projector, handle } = review(draft, base);
  const shown = projector.projectNow() as NonNullable<ReturnType<typeof projector.projectNow>>;
  expect(shown.groups).toHaveLength(2);

  // The AI deletes "epsilon " from the middle of the paragraph, more than a margin from both changes.
  const { text, send } = peerOf(doc);
  const at = text(0).toString().indexOf("epsilon ");
  text(0).delete(at, 8);
  send();

  expect(discardChange(handle, shown, shown.groups[0].id)).toBe("discarded");
  expect(paragraphs(editor)).toEqual(["alpha beta gamma delta zeta eta theta iota KAPPA"]);
});

it("a typing frame reaches the painter before the runtime derives state or wakes a reader", async () => {
  vi.useFakeTimers();
  try {
    const { editor, projector } = review(["The door was green."], ["The door was red."]);
    const first = projector.projectNow();
    const order: string[] = [];
    projector.subscribe(() => order.push("reader"));
    editor.commands.insertContentAt(posOf(editor, "door"), "x");
    // From here the typing transaction is behind us: what dispatches next is the painter's frame.
    editor.on("transaction", ({ transaction }) => {
      if (!transaction.docChanged)
        order.push(`paint:${projector.state().frame === first ? "ahead" : "settled"}`);
    });
    vi.advanceTimersByTime(REVIEW_DEBOUNCE_MS);
    expect(order).not.toContain("reader");
    expect(order[0]).toBe("paint:ahead");
    await Promise.resolve();
    expect(order.filter((entry) => entry === "reader")).toHaveLength(1);
    expect(projector.state().frame).not.toBe(first);
  } finally {
    vi.useRealTimers();
  }
});

it("move, cut across a paragraph break, paste and Undo keep the chat, atomically through GC reload", () => {
  const doc = new Y.Doc({ gc: true });
  const schema = buildDocumentSchema();
  const p = (text: string) => schema.nodes.paragraph.create(null, schema.text(text));
  doc.clientID = 1;
  writeBlocks(doc.getXmlFragment("prosemirror"), schema, [
    p("The red gate."),
    p("Beyond the river waits a guard."),
  ]);
  seedReviewBase(doc, ["The red gate.", "Beyond the river waits a guard."]);
  doc.clientID = 77;
  const t = (doc.getXmlFragment("prosemirror").get(0) as Y.XmlElement).get(0) as Y.XmlText;
  t.delete(4, 3);
  t.insert(4, "blue");
  const part = { threadId: "chat", turnId: "turn", inserted: [[77, 0, 4]] as const, deleted: [] };
  doc.clientID = 99;
  const { editor, history } = createReviewEditor([], doc);
  const original = editor.getJSON();
  const classification = (read: Y.Doc) => [
    ...classifyChanges(read, projectRoom(read), {
      userId: "u",
      parts: [part],
      snapshot: Y.snapshot(read),
    }).values(),
  ];
  const check = () => {
    const reload = new Y.Doc({ gc: true });
    Y.applyUpdate(reload, Y.encodeStateAsUpdate(doc));
    for (const read of [doc, reload]) {
      expect(classification(read).map((c) => c.byline)).toEqual([
        [{ kind: "thread", threadId: "chat", turnId: "turn" }],
      ]);
      expect(classification(read).map((c) => c.members)).toEqual([[0]]);
    }
    reload.destroy();
  };
  const frames: Uint8Array[] = [];
  doc.on("update", (update: Uint8Array) => frames.push(update));
  const undoStep = () => {
    const remote = new Y.Doc({ gc: true });
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(doc));
    frames.length = 0;
    history.undoManager.undo();
    expect(frames).toHaveLength(1);
    Y.applyUpdate(remote, frames[0]);
    expect(readRestorations(remote)).toEqual(readRestorations(doc));
    expect(classification(remote)).toEqual(classification(doc));
    remote.destroy();
  };
  editor.commands.setTextSelection(1);
  const source = blockForSelection(editor.state);
  const move = source && moveBlockStepTransaction(editor.state, source, "down");
  expect(move).toBeTruthy();
  editor.view.dispatch(move as NonNullable<typeof move>);
  history.undoManager.stopCapturing();
  expect(classification(doc).flatMap((c) => c.byline)).toContainEqual({
    kind: "user",
    userId: "u",
  });
  undoStep();
  expect(editor.getJSON()).toEqual(original);
  check();
  const end = editor.state.doc.firstChild?.nodeSize as number;
  const slice = editor.state.doc.slice(1, end + 1);
  editor.view.dispatch(
    editor.state.tr
      .setSelection(TextSelection.create(editor.state.doc, 1, end + 1))
      .deleteSelection(),
  );
  history.undoManager.stopCapturing();
  const at = posOf(editor, "river");
  editor.view.dispatch(
    editor.state.tr
      .setSelection(TextSelection.create(editor.state.doc, at))
      .replaceSelection(slice),
  );
  history.undoManager.stopCapturing();
  expect(classification(doc).flatMap((c) => c.byline)).toContainEqual({
    kind: "user",
    userId: "u",
  });
  undoStep();
  undoStep();
  expect(editor.getJSON()).toEqual(original);
  expect(readRestorations(doc).links.length).toBeGreaterThan(0);
  check();
  // Exercise Redo too: the wrapper must keep Yjs's direction flags through transaction cleanup.
  history.undoManager.redo();
  undoStep();
  check();
  editor.destroy();
  history.undoManager.destroy();
  doc.destroy();
});
