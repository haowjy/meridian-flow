// @vitest-environment jsdom
/** The browser TipTap schema must keep the shared document type and attribute names. */

import { documentMarks, documentNodes } from "@meridian/prosemirror-schema";
import { Editor } from "@tiptap/core";
import { afterEach, expect, it } from "vitest";
import { createStandaloneEditorExtensions } from "./config";

/**
 * Pins implementation decisions (rewrite or delete this case when one changes):
 * - the browser and shared schemas are assembled separately but have one wire surface
 * - the suggestion surface (`sug`, `sugAttrs`, `suggest_ins`, `suggest_del`) has left the browser
 *   schema; the shared schema drops it at 4.0.0 (phase 1e), and this exclusion goes with it
 */

const SUGGESTION_ATTRS = new Set(["sug", "sugAttrs"]);
const SUGGESTION_MARKS = new Set(["suggest_ins", "suggest_del"]);

const editors: Editor[] = [];

afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy();
});

function attributeNames(attributes: Record<string, unknown> | null | undefined): string[] {
  return Object.keys(attributes ?? {}).sort();
}

function editorSurface(editor: Editor, kind: "nodes" | "marks") {
  const types = editor.schema[kind];
  return Object.fromEntries(
    Object.entries(types)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, type]) => [name, attributeNames(type.spec.attrs)]),
  );
}

function sharedSurface(specs: Record<string, { attrs?: Record<string, unknown> } | object>) {
  return Object.fromEntries(
    Object.entries(specs)
      .filter(([name]) => !SUGGESTION_MARKS.has(name))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, spec]) => [
        name,
        attributeNames("attrs" in spec ? spec.attrs : undefined).filter(
          (attr) => !SUGGESTION_ATTRS.has(attr),
        ),
      ]),
  );
}

it("keeps every shared node, mark, and attribute in the browser schema", () => {
  const editor = new Editor({ extensions: createStandaloneEditorExtensions() });
  editors.push(editor);

  expect(editorSurface(editor, "nodes")).toEqual(sharedSurface(documentNodes));
  expect(editorSurface(editor, "marks")).toEqual(sharedSurface(documentMarks));
});
