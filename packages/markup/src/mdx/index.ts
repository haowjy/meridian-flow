/** Canonical MDX plugin and convenience codec preset. */

import type { Schema } from "prosemirror-model";
import remarkMdx from "remark-mdx";

import { createMarkupCodec } from "../codec.js";
import type { ComponentRegistry } from "../components.js";
import { escapeProseForMdxIngress } from "../escape.js";
import { demoteAutolinks } from "../helpers.js";
import { tableCodec } from "../markdown/blocks/index.js";
import {
  canonicalizeGfmTableHardBreaks,
  normalizeGfmTableHardBreaks,
} from "../markdown/blocks/table.js";
import { markdownBlockCodecs, markdownMarkCodecs } from "../markdown/index.js";
import {
  canonicalizeLabeledWikilinkDestinations,
  normalizeLabeledWikilinkDestinations,
  remarkWikiLink,
} from "../markdown/wikilink.js";
import type { AssetPathResolver, BlockCodec, MarkupPlugin } from "../types.js";
import {
  createFigureCodec,
  createJsxContainerCodec,
  createJsxLeafCodec,
  createLayoutCodec,
  serializeLayoutBlock,
} from "./blocks/index.js";

export function mdxBlockCodecs(components?: ComponentRegistry): readonly BlockCodec[] {
  return [
    createLayoutCodec(),
    createFigureCodec(),
    tableCodec,
    createJsxContainerCodec(components),
    createJsxLeafCodec(components),
    ...markdownBlockCodecs.filter((codec) => codec.name !== "table"),
  ];
}

export function mdx(options?: { components?: ComponentRegistry }): MarkupPlugin {
  return {
    blocks: mdxBlockCodecs(options?.components),
    marks: markdownMarkCodecs,
    remarkPlugins: [remarkMdx, remarkWikiLink],
    preprocess: (text) =>
      escapeProseForMdxIngress(
        normalizeLabeledWikilinkDestinations(normalizeGfmTableHardBreaks(text), {
          protectMdxSyntax: true,
        }),
      ),
    postParse: demoteAutolinks,
    postSerializeBlock: (node, serialized, ctx) =>
      serializeLayoutBlock(
        node,
        canonicalizeLabeledWikilinkDestinations(canonicalizeGfmTableHardBreaks(serialized), {
          protectMdxSyntax: true,
        }),
        ctx,
      ),
  };
}

export function mdxCodec(options: {
  schema: Schema;
  assetPathResolver: AssetPathResolver;
  components?: ComponentRegistry;
}) {
  return createMarkupCodec({ schema: options.schema, assetPathResolver: options.assetPathResolver })
    .use(mdx({ components: options.components }))
    .build({ requireSchemaBlockCoverage: true });
}
