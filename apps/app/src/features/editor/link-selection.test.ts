// @vitest-environment jsdom
import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";

import { createStandaloneEditorExtensions } from "@/core/editor/config";
import { linkAttributesAtSelection } from "./link-selection";

let editor: Editor | null = null;

afterEach(() => {
  editor?.destroy();
  editor = null;
});

describe("linkAttributesAtSelection", () => {
  it("finds an existing link from a caret at either boundary or inside it", () => {
    editor = new Editor({
      extensions: createStandaloneEditorExtensions(),
      content: '<p><a href="https://example.com">linked</a> plain</p>',
    });

    for (const position of [1, 3, 7]) {
      editor.commands.setTextSelection(position);
      expect(linkAttributesAtSelection(editor)).toMatchObject({ href: "https://example.com" });
    }
  });

  it("does not treat a caret in plain text as an existing link", () => {
    editor = new Editor({
      extensions: createStandaloneEditorExtensions(),
      content: '<p><a href="https://example.com">linked</a> plain</p>',
    });
    editor.commands.setTextSelection(9);

    expect(linkAttributesAtSelection(editor)).toBeNull();
  });
});
