import { contentMerge } from "@meridian/agent-edit/content-merge";
import { buildDocumentSchema } from "@meridian/prosemirror-schema";

const schema = buildDocumentSchema();
const block = (text: string) => [
  schema.nodes.code_block.create({ language: null }, text ? schema.text(text) : undefined),
];

/**
 * `live` with the change from `base` to `target` brought in. Where both sides changed the same
 * text, `live` stays: it is the draft side of the merge, whose version a conflict keeps.
 */
export function mergeCodeText(input: { base: string; live: string; target: string }): {
  text: string;
  clashes: number;
} {
  const merged = contentMerge(schema, block(input.base), block(input.target), block(input.live));
  return {
    text: merged.blocks.map((node) => node.textContent).join("\n"),
    clashes: merged.conflicts.length,
  };
}
