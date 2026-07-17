// @vitest-environment jsdom
import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";

import { createStandaloneEditorExtensions } from "@/core/editor/config";
import { COMMON_CODE_LANGUAGES, filterCodeLanguages, matchCodeBlock } from "./EditorCodeBubble";

let editor: Editor | null = null;

afterEach(() => {
  editor?.destroy();
  editor = null;
});

describe("code bubble", () => {
  it("matches a caret in a code block and preserves an unknown language verbatim", () => {
    editor = new Editor({
      extensions: createStandaloneEditorExtensions(),
      content: {
        type: "doc",
        content: [
          {
            type: "code_block",
            attrs: { language: "myCustomLang" },
            content: [{ type: "text", text: "custom code" }],
          },
        ],
      },
    });
    editor.commands.setTextSelection(3);

    expect(matchCodeBlock(editor)).toMatchObject({
      from: 1,
      nodePos: 0,
      data: { language: "myCustomLang", preview: false },
    });
    expect(editor.state.doc.firstChild?.attrs.language).toBe("myCustomLang");
  });

  it("does not claim a text selection or a caret outside code", () => {
    editor = new Editor({
      extensions: createStandaloneEditorExtensions(),
      content: "<p>prose</p><pre><code>code</code></pre>",
    });
    editor.commands.setTextSelection(2);
    expect(matchCodeBlock(editor)).toBeNull();

    editor.commands.setTextSelection({ from: 8, to: 10 });
    expect(matchCodeBlock(editor)).toBeNull();
  });

  it("filters the complete common lowlight set without normalizing values", () => {
    expect(COMMON_CODE_LANGUAGES).toHaveLength(37);
    expect(COMMON_CODE_LANGUAGES).toContain("typescript");
    expect(
      filterCodeLanguages(
        [
          { value: "", label: "Plain text" },
          { value: "typescript", label: "typescript" },
          { value: "myCustomLang", label: "myCustomLang" },
        ],
        "custom",
      ),
    ).toEqual([{ value: "myCustomLang", label: "myCustomLang" }]);
  });
});
