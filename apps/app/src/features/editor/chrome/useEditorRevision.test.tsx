// @vitest-environment jsdom
/**
 * The coarse editor signal counts every transaction, including the one that
 * lands before React has finished mounting.
 *
 * That window is real rather than theoretical: layout effects run before
 * passive ones, so a surface that writes to the document while it measures —
 * or a node view rebuilt on the same commit — moves the document between a
 * consumer's render and the effect a hand-rolled subscription would use. A
 * counter owned by the component never hears that transaction and never
 * re-renders, so the toolbar paints the state before it.
 */
import { Editor } from "@tiptap/core";
import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";

import { createStandaloneEditorExtensions } from "@/core/editor/config";
import { installJsdomLayout } from "@/test-support/jsdom-layout";

import { useEditorRevision } from "./useEditorChrome";

installJsdomLayout();

let editor: Editor;
let host: HTMLElement;
let container: HTMLElement;
let root: Root;
let seen: number[] = [];

beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  seen = [];

  host = document.createElement("div");
  document.body.append(host);
  editor = new Editor({
    element: host,
    extensions: createStandaloneEditorExtensions(),
    content: {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "a sentence" }] }],
    },
  });

  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  editor.destroy();
  host.remove();
});

function Probe() {
  seen.push(useEditorRevision(editor));
  return null;
}

/** A surface that writes to the document while it measures, on mount. */
function WritesOnMount() {
  useLayoutEffect(() => {
    editor.commands.insertContentAt(1, "x");
  }, []);
  return null;
}

it("counts the transaction that lands between render and subscription", () => {
  act(() => {
    root.render(
      <>
        <Probe />
        <WritesOnMount />
      </>,
    );
  });

  expect(seen.at(-1)).toBeGreaterThan(0);
});

it("answers a new revision for every transaction after that", () => {
  act(() => root.render(<Probe />));
  const mounted = seen.at(-1) ?? 0;

  act(() => {
    editor.commands.insertContentAt(1, "y");
  });
  act(() => {
    editor.commands.insertContentAt(1, "z");
  });

  expect(seen.at(-1)).toBe(mounted + 2);
});
