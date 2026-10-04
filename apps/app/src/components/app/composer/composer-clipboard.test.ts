// @vitest-environment jsdom
/** Clipboard round trips keep reference identity, not upload ownership. */
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { expect, it } from "vitest";
import { ComposerSkillNode } from "./composer-document";

it("copies a skill atom as /slug in plain text", () => {
  const editor = new Editor({
    extensions: [StarterKit, ComposerSkillNode],
    content: {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "composerSkill",
              attrs: {
                slug: "writing-principles",
                name: "Writing principles",
                description: "Reader reward.",
              },
            },
          ],
        },
      ],
    },
  });
  try {
    editor.commands.selectAll();
    const copied = editor.view.serializeForClipboard(editor.state.selection.content());
    expect(copied.text).toBe("/writing-principles");
  } finally {
    editor.destroy();
  }
});
