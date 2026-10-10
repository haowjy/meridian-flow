// @vitest-environment jsdom
/** View-lifetime persistence: capture before debounce, flush only the last interacting pane. */
import { Editor } from "@tiptap/core";
import { act, useRef } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import { createEditorConfig } from "./config";
import { createLocalPresence } from "./local-presence";
import { ReadingPositionStore } from "./reading-position-store";
import { useReadingPosition } from "./use-reading-position";

it("flushes the last selection on pagehide, restores on a new view, and leaves warm DOM alone", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const doc = new Y.Doc();
  const awareness = new Awareness(doc);
  const editor = new Editor(
    createEditorConfig({
      document: doc,
      presence: createLocalPresence(awareness),
      showCollaborationDecorations: false,
    }),
  );
  editor.commands.insertContent("A chapter remembers its place.");
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const signal = new AbortController().signal;
  // jsdom cannot measure layout. All editor, Yjs, events and browser storage are real.
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(100);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    top: 0,
    height: 100,
    width: 100,
    bottom: 100,
    left: 0,
    right: 100,
    x: 0,
    y: 0,
    toJSON() {},
  });
  vi.spyOn(editor.view, "posAtCoords").mockReturnValue(null);
  vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => {
    fn(0);
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  function Surface({ active }: { active: boolean }) {
    const pane = useRef<HTMLDivElement>(null);
    useReadingPosition({
      editor,
      pane,
      accountId: "writer",
      documentId: "chapter",
      active,
      review: false,
      signal,
    });
    return <div ref={pane} />;
  }
  try {
    await act(async () => root.render(<Surface active />));
    // Mount alone cannot replace another pane's remembered place.
    const store = new ReadingPositionStore("writer");
    expect(store.load("chapter")).toBeNull();
    editor.commands.setTextSelection({ from: 8, to: 12 });
    window.dispatchEvent(new Event("pagehide"));
    const saved = store.load("chapter");
    expect(saved).not.toBeNull();
    await act(async () => root.render(<Surface active={false} />));
    editor.commands.setTextSelection(2);
    window.dispatchEvent(new Event("pagehide"));
    expect(store.load("chapter")).toEqual(saved);
    await act(async () => root.render(<Surface active />));
    expect(editor.state.selection.from).toBe(2); // warm reveal, not a new open
    await act(async () => root.render(null));
    await act(async () => root.render(<Surface active />));
    expect(editor.state.selection.from).toBe(8);
    expect(editor.state.selection.to).toBe(12);
    expect(editor.isFocused).toBe(false);
  } finally {
    await act(async () => root.unmount());
    editor.destroy();
    awareness.destroy();
    doc.destroy();
    host.remove();
    localStorage.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});
