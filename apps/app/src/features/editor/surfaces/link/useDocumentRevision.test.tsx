// @vitest-environment jsdom
/** Selection and meta transactions must not re-register the document's link resolver. */
import { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import StarterKit from "@tiptap/starter-kit";
import { act } from "react";
import { expect, it, vi } from "vitest";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { useDocumentRevision } from "./useDocumentRevision";

it("moves once per edit burst, never for selection or link-answer metadata", async () => {
  vi.useFakeTimers();
  const editor = new Editor({ extensions: [StarterKit], content: "<p>Chapter six</p>" });
  const revisions: number[] = [];
  function Probe() {
    revisions.push(useDocumentRevision(editor));
    return null;
  }
  try {
    await withReactRoot(<Probe />, () => {
      const { view } = editor;
      act(() => view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 3))));
      act(() => view.dispatch(view.state.tr.setMeta("answered", true)));
      act(() => vi.advanceTimersByTime(400));
      expect(revisions).toEqual([0]);
      for (const letter of "abc") act(() => view.dispatch(view.state.tr.insertText(letter, 1)));
      expect(revisions).toEqual([0]);
      act(() => vi.advanceTimersByTime(400));
      expect(revisions).toEqual([0, 1]);
    });
  } finally {
    editor.destroy();
    vi.useRealTimers();
  }
});
