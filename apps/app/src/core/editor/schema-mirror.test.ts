// @vitest-environment jsdom
/** The browser TipTap schema must keep the shared document type and attribute names. */

import { documentMarks, documentNodes } from "@meridian/prosemirror-schema";
import { Editor } from "@tiptap/core";
import { afterEach, expect, it } from "vitest";
import { createStandaloneEditorExtensions } from "./config";

/**
 * Pins implementation decisions (rewrite or delete this case when one changes):
 * - the browser and shared schemas are assembled separately but have one wire surface
 */

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
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, spec]) => [name, attributeNames("attrs" in spec ? spec.attrs : undefined)]),
  );
}

it("keeps every shared node, mark, and attribute in the browser schema", () => {
  const editor = new Editor({ extensions: createStandaloneEditorExtensions() });
  editors.push(editor);

  expect(editorSurface(editor, "nodes")).toEqual(sharedSurface(documentNodes));
  expect(editorSurface(editor, "marks")).toEqual(sharedSurface(documentMarks));
});
