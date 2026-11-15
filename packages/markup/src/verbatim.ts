import type { Schema } from "prosemirror-model";
import type { MarkupCodec, PMNode } from "./types.js";

/**
 * The codec of a code document (filetype `source`): its text is one code block, byte for byte.
 * Nothing in it is Markdown, so parsing never splits a `---` into a rule and serializing
 * never fences the text. Everything that is not a text-to-block conversion is `base`'s.
 */
export function verbatimCodec(base: MarkupCodec, schema: Schema, language: string): MarkupCodec {
  const parse = (content: string) => ({
    blocks: [
      schema.nodes.code_block.create({ language }, content ? schema.text(content) : undefined),
    ],
  });
  const text = (blocks: readonly PMNode[]) => blocks.map((block) => block.textContent).join("\n");
  return {
    ...base,
    parse,
    parseWithSpans: (content) => ({ ...parse(content), spans: [] }),
    serialize: (blocks) => text(blocks),
    serializeBlock: (block) => block.textContent,
    serializeBlocks: (blocks) =>
      blocks.map((block) => ({ body: block.textContent, gap: "", open: "" })),
  };
}
