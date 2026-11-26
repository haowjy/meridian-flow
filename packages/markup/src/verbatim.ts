import type { Schema } from "prosemirror-model";
import type { MarkupCodec, PMNode } from "./types.js";

export function codeFileBlock(schema: Schema, filetype: string, text: string): PMNode {
  return schema.nodes.code_block.create(
    { language: filetype },
    text.length > 0 ? schema.text(text) : undefined,
  );
}

/**
 * The codec of a code document: its text is its {@link codeFileBlock}.
 * Nothing in it is Markdown, so parsing never splits a `---` into a rule and serializing
 * never fences the text. Everything that is not a text-to-block conversion is `base`'s.
 */
export function verbatimCodec(base: MarkupCodec, schema: Schema, filetype: string): MarkupCodec {
  const parse = (content: string) => ({ blocks: [codeFileBlock(schema, filetype, content)] });
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
