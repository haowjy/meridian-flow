// @vitest-environment jsdom
/** What an Editor `@` choice writes: a standard link spelled from its holder. */
import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";

import { createStandaloneEditorExtensions } from "../../config";
import { insertDocumentLink } from "./document-link-insertion";

describe("insertDocumentLink", () => {
  let editor: Editor | null = null;
  afterEach(() => {
    editor?.destroy();
    editor = null;
  });

  function insertedHref(holderUri: string | null, uri: string): string | null {
    editor = new Editor({
      extensions: createStandaloneEditorExtensions(),
      content: "<p>See @</p>",
    });
    const end = editor.state.doc.content.size - 1;
    insertDocumentLink(editor, { from: end - 1, to: end }, { label: "Label", uri, holderUri });
    let href: string | null = null;
    editor.state.doc.descendants((node) => {
      const link = node.marks.find((mark) => mark.type.name === "link");
      if (link) href = link.attrs.href;
    });
    expect(editor.state.doc.textContent).toBe("See Label");
    return href;
  }

  it.each([
    ["manuscript://volume-1/chapter-1.md", "manuscript://volume-1/chapter-2.md", "chapter-2.md"],
    [
      "manuscript://volume-2/chapter-1.md",
      "manuscript://volume-1/chapter-1.md",
      "../volume-1/chapter-1.md",
    ],
    [
      "manuscript://volume-1/chapter-1.md",
      "kb://characters/Lin Feng.md",
      "kb://characters/Lin Feng.md",
    ],
    [null, "manuscript://volume-1/chapter-1.md", "manuscript://volume-1/chapter-1.md"],
    ["manuscript://volume-2/chapter-1.md", "manuscript://volume-2/Lin Mei.md", "Lin Mei.md"],
  ])("from %s, links %s as %s", (holderUri, uri, href) => {
    expect(insertedHref(holderUri, uri)).toBe(href);
  });
});
