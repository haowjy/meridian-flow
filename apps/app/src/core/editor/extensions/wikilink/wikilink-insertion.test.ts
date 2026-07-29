// @vitest-environment jsdom
/**
 * What the menu writes has to survive the wire, or the writer picked a
 * document and got a link the resolver has never heard of.
 *
 * The codec spells a link as `[[target]]` only when its text IS its target and
 * it carries no title; anything else serializes as `[text]([[target]])`. That
 * makes these two assertions one contract: the shape in the document, and the
 * `[[…]]` an LLM would read back.
 */
import { mdxCodec, unresolvedAssetPathResolver } from "@meridian/markup";
import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";

import { createStandaloneEditorExtensions } from "../../config";
import { insertWikilink } from "./wikilink-insertion";

let editor: Editor | null = null;

afterEach(() => {
  editor?.destroy();
  editor = null;
});

function editorWith(content: string): Editor {
  editor = new Editor({ extensions: createStandaloneEditorExtensions(), content });
  return editor;
}

/** The document as the wire would carry it. */
function serialize(target: Editor): string {
  const codec = mdxCodec({
    schema: target.schema,
    assetPathResolver: unresolvedAssetPathResolver,
    components: {},
  });
  return codec.serialize([...target.state.doc.content.content]);
}

/** Where the trigger's `[[query` sits, as `@tiptap/suggestion` reports it. */
function triggerRange(target: Editor, typed: string): { from: number; to: number } {
  const from = target.state.doc.textContent.indexOf(typed) + 1;
  return { from, to: from + typed.length };
}

describe("choosing a row inserts a wikilink", () => {
  it("writes the name as the link's own text, which is what round-trips", () => {
    const target = editorWith("<p>She checked the seal against [[thi</p>");

    expect(insertWikilink(target, triggerRange(target, "[[thi"), "The Third Gate")).toBe(true);

    expect(target.state.doc.toJSON().content[0].content).toEqual([
      { type: "text", text: "She checked the seal against " },
      {
        type: "text",
        text: "The Third Gate",
        marks: [{ type: "link", attrs: { href: "[[The Third Gate]]", title: null } }],
      },
    ]);
    expect(serialize(target)).toBe("She checked the seal against [[The Third Gate]]\n");
  });

  it("round-trips what it wrote back into the same document", () => {
    const target = editorWith("<p>[[thi</p>");
    insertWikilink(target, triggerRange(target, "[[thi"), "The Third Gate");

    const codec = mdxCodec({
      schema: target.schema,
      assetPathResolver: unresolvedAssetPathResolver,
      components: {},
    });
    const reparsed = codec.parse(serialize(target)).blocks;

    expect(reparsed.map((block) => block.toJSON())).toEqual(
      target.state.doc.content.content.map((block) => block.toJSON()),
    );
  });

  it("leaves the sentence after it unlinked", () => {
    const target = editorWith("<p>[[thi</p>");
    insertWikilink(target, triggerRange(target, "[[thi"), "The Third Gate");
    target.commands.insertContent(" opened.");

    expect(serialize(target)).toBe("[[The Third Gate]] opened.\n");
  });

  it("trims a name the way the resolver reads it", () => {
    const target = editorWith("<p>[[</p>");

    expect(insertWikilink(target, triggerRange(target, "[["), "  Warden Ilsever  ")).toBe(true);
    expect(serialize(target)).toBe("[[Warden Ilsever]]\n");
  });

  it("refuses a name the wire format cannot carry, rather than writing half of one", () => {
    const target = editorWith("<p>[[</p>");

    // The aliased spelling `[[target|label]]` is not what this document
    // format carries, and neither is an unclosed bracket.
    expect(insertWikilink(target, triggerRange(target, "[["), "Kael|the warden")).toBe(false);
    expect(insertWikilink(target, triggerRange(target, "[["), "   ")).toBe(false);
    expect(serialize(target)).toBe("\\[\\[\n");
  });
});
