// @vitest-environment jsdom
import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";

import { createStandaloneEditorExtensions } from "@/core/editor/config";
import { linkAtSelection, linkAttributesAtSelection } from "./link-selection";

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
      expect(linkAtSelection(editor)).toMatchObject({ from: 1, to: 7 });
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

  it("resolves the whole mark for a selection inside a link", () => {
    editor = new Editor({
      extensions: createStandaloneEditorExtensions(),
      content: '<p><a href="https://example.com">linked</a> plain</p>',
    });
    editor.commands.setTextSelection({ from: 2, to: 5 });

    expect(linkAtSelection(editor)).toMatchObject({ from: 1, to: 7 });
  });

  it("provides a range that link commands can remove from a boundary caret", () => {
    editor = new Editor({
      extensions: createStandaloneEditorExtensions(),
      content: '<p><a href="https://example.com">linked</a> plain</p>',
    });
    editor.commands.setTextSelection(7);
    const link = linkAtSelection(editor);
    expect(link).not.toBeNull();

    editor
      .chain()
      .setTextSelection({ from: link?.from ?? 0, to: link?.to ?? 0 })
      .unsetLink()
      .run();

    expect(editor.getHTML()).toBe("<p>linked plain</p>");
  });
});
