// @vitest-environment jsdom
/** Only a changed document moves the revision the link resolver registers on. */

import { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import StarterKit from "@tiptap/starter-kit";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { SETTLE_MS, useDocumentRevision } from "./useDocumentRevision";

const actGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };

let root: Root;
let host: HTMLDivElement;
let editor: Editor;
let revisions: number[];

function Probe() {
  revisions.push(useDocumentRevision(editor));
  return null;
}

beforeEach(() => {
  vi.useFakeTimers();
  actGlobal.IS_REACT_ACT_ENVIRONMENT = true;
  revisions = [];
  editor = new Editor({
    extensions: [StarterKit],
    content: "<p>Chapter six</p>",
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root.render(<Probe />));
});

afterEach(() => {
  vi.useRealTimers();
  act(() => root.unmount());
  editor.destroy();
  host.remove();
});

it("moves once per burst of edits, not on a selection change or a meta-only transaction", () => {
  const { view } = editor;
  act(() => view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 3))));
  act(() => view.dispatch(view.state.tr.setMeta("answered", true)));
  act(() => vi.advanceTimersByTime(SETTLE_MS));
  expect(revisions).toEqual([0]);

  for (const letter of "abc") act(() => view.dispatch(view.state.tr.insertText(letter, 1)));
  expect(revisions).toEqual([0]);
  act(() => vi.advanceTimersByTime(SETTLE_MS));
  expect(revisions).toEqual([0, 1]);
});
