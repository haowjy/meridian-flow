// @vitest-environment jsdom
/**
 * The caret is a presence publisher like any other.
 *
 * Every case here runs the real upstream lifecycle — TipTap's
 * CollaborationCaret and y-prosemirror's cursor plugin, writing `user` and
 * `cursor` through the provider they are configured with — rather than calling
 * `setField` by hand. That is the whole subject: those two publishers used to
 * hold the raw `Awareness`, so a write or a clear they made while the writer
 * was hidden behind inline review was dropped, and resume put back the caret
 * the destroyed editor had already taken away.
 */
import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";

import { createEditorConfig } from "./config";
import { createLocalPresence, type LocalPresence } from "./local-presence";

type CaretHarness = {
  editor: Editor;
  /** The wire: what a peer would see of this client. */
  published: () => Record<string, unknown> | null;
  presence: LocalPresence;
  destroyEditor: () => void;
};

let harness: CaretHarness | null = null;

afterEach(() => {
  harness?.destroyEditor();
  harness = null;
});

function mountCaretEditor(): CaretHarness {
  const document = new Y.Doc({ gc: false });
  const awareness = new Awareness(document);
  const presence = createLocalPresence(awareness);
  const element = window.document.createElement("div");
  window.document.body.append(element);
  const editor = new Editor({
    element,
    ...createEditorConfig({
      document,
      presence,
      user: { name: "Writer", color: "#2e7d6b" },
    }),
  });
  editor.commands.setContent("<p>the ninth peak</p>");
  // What `useMountedEditor` does right after construction, and what tells
  // y-prosemirror the binding is live enough to publish a caret.
  editor.setOptions({ editable: true });
  return {
    editor,
    published: () => awareness.getLocalState(),
    presence,
    destroyEditor: () => {
      if (!editor.isDestroyed) editor.destroy();
      element.remove();
      awareness.destroy();
      document.destroy();
    },
  };
}

/**
 * jsdom will not put `document.activeElement` on a contenteditable div, so the
 * prose gets a tabindex first. Everything after that is the real path: a focus
 * event reaching y-prosemirror's own `focusin` listener, which is the only
 * thing that ever writes a caret.
 */
function putTheCaretOnTheWire(editor: Editor): void {
  editor.view.dom.setAttribute("tabindex", "0");
  editor.view.dom.focus();
}

function cursorOf(state: Record<string, unknown> | null): unknown {
  return (state as { cursor?: unknown } | null)?.cursor ?? null;
}

describe("a caret written through the presence port", () => {
  it("reaches the wire on focus and moves with the selection", () => {
    harness = mountCaretEditor();
    putTheCaretOnTheWire(harness.editor);

    const atStart = cursorOf(harness.published());
    expect(atStart).not.toBeNull();
    expect(harness.published()).toMatchObject({ user: { name: "Writer" } });

    harness.editor.commands.setTextSelection(8);
    expect(cursorOf(harness.published())).not.toEqual(atStart);
  });

  it("stays where the writer moved it during a suspension, not where the review found it", () => {
    harness = mountCaretEditor();
    putTheCaretOnTheWire(harness.editor);
    const beforeReview = cursorOf(harness.published());

    harness.presence.suspend();
    harness.editor.commands.setTextSelection(11);
    harness.presence.resume();

    const afterReview = cursorOf(harness.published());
    expect(afterReview).not.toBeNull();
    expect(afterReview).not.toEqual(beforeReview);
  });

  it("stays cleared when the editor that owned it was destroyed during a suspension", () => {
    harness = mountCaretEditor();
    putTheCaretOnTheWire(harness.editor);
    expect(cursorOf(harness.published())).not.toBeNull();

    // The writer opened inline review, then closed the document behind it. The
    // live editor's cursor plugin clears the caret as it goes; nothing is on the
    // wire to clear, so the clear has to survive until presence comes back.
    harness.presence.suspend();
    harness.editor.destroy();
    harness.presence.resume();

    expect(cursorOf(harness.published())).toBeNull();
    expect(harness.published()).toMatchObject({ user: { name: "Writer" } });
  });

  it("stays cleared when the prose lost focus during a suspension", () => {
    harness = mountCaretEditor();
    putTheCaretOnTheWire(harness.editor);

    harness.presence.suspend();
    harness.editor.view.dom.blur();
    harness.presence.resume();

    expect(cursorOf(harness.published())).toBeNull();
  });

  it("publishes a user renamed during a suspension", () => {
    harness = mountCaretEditor();
    putTheCaretOnTheWire(harness.editor);

    harness.presence.suspend();
    harness.editor.commands.updateUser({ name: "Renamed", color: "#2e7d6b" });
    harness.presence.resume();

    expect(harness.published()).toMatchObject({ user: { name: "Renamed" } });
  });
});
