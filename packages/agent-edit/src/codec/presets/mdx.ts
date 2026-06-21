import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import remarkMdx from "remark-mdx";

import { figureCodec, jsxContainerCodec, jsxLeafCodec } from "../blocks/index.js";
import { createCodec, requiredBlockNamesForSchema } from "../create-codec.js";
import type { BlockCodec } from "../types.js";
import { type CodecPresetOptions, markdownBlockCodecs, markdownMarkCodecs } from "./markdown.js";

export const mdxBlockCodecs: readonly BlockCodec[] = [
  figureCodec,
  jsxContainerCodec,
  jsxLeafCodec,
  ...markdownBlockCodecs,
];

export const mdxRequiredBlockNames: readonly string[] = Object.freeze(
  requiredBlockNamesForSchema(buildDocumentSchema()),
);

export function mdxCodec(options: CodecPresetOptions = {}) {
  return createCodec({
    ...options,
    blocks: mdxBlockCodecs,
    marks: markdownMarkCodecs,
    mdx: true,
    remarkPlugins: [remarkMdx],
    requireSchemaBlockCoverage: true,
  });
}
