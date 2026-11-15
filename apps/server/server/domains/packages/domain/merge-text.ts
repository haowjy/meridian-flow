/**
 * Three-way merge of one package file's text, through the content merge that Apply and Un-Apply
 * use on documents: an Agent file is a code document, one code block holding its text. Where both
 * sides changed the same text the target's version stays, as an Un-Apply's does.
 */
import { contentMerge } from "@meridian/agent-edit/content-merge";
import { buildDocumentSchema } from "@meridian/prosemirror-schema";

const schema = buildDocumentSchema();
const block = (text: string) => [
  schema.nodes.code_block.create({ language: null }, text ? schema.text(text) : undefined),
];

/** `live` with the change from `base` to `target` brought in. */
export function mergeText(input: { base: string; live: string; target: string }): string {
  const merged = contentMerge(schema, block(input.base), block(input.live), block(input.target));
  return merged.blocks.map((node) => node.textContent).join("\n");
}
