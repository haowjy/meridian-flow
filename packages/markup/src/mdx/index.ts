/** Canonical MDX plugin and convenience codec preset. */

import type { Schema } from "prosemirror-model";
import remarkMdx from "remark-mdx";

import { createMarkupCodec } from "../codec.js";
import type { ComponentRegistry } from "../components.js";
import { escapeProseForMdxIngress } from "../escape.js";
import { demoteAutolinks } from "../helpers.js";
import { imageCodec, tableCodec } from "../markdown/blocks/index.js";
import {
  canonicalizeGfmTableHardBreaks,
  normalizeGfmTableHardBreaks,
} from "../markdown/blocks/table.js";
import { markdownBlockCodecs, markdownMarkCodecs } from "../markdown/index.js";
import { remarkWikiLink } from "../markdown/wikilink.js";
import type { AssetPathResolver, BlockCodec, MarkupPlugin } from "../types.js";
import {
  createFigureCodec,
  createJsxContainerCodec,
  createJsxLeafCodec,
  createLayoutCodec,
  serializeLayoutBlock,
} from "./blocks/index.js";

/**
 * The MDX block chain. The two codecs hoisted above the JSX ones own raw tags
 * MDX would otherwise hand to a component that does not exist: a `<table>` too
 * shaped for pipes, and the `<img>` a picture with a display size escalates to.
 */
export function mdxBlockCodecs(components?: ComponentRegistry): readonly BlockCodec[] {
  const hoisted = new Set([tableCodec.name, imageCodec.name]);
  return [
    createLayoutCodec(),
    createFigureCodec(),
    tableCodec,
    imageCodec,
    createJsxContainerCodec(components),
    createJsxLeafCodec(components),
    ...markdownBlockCodecs.filter((codec) => !hoisted.has(codec.name)),
  ];
}

export function mdx(options?: { components?: ComponentRegistry }): MarkupPlugin {
  return {
    blocks: mdxBlockCodecs(options?.components),
    marks: markdownMarkCodecs,
    remarkPlugins: [remarkMdx, remarkWikiLink],
    preprocess: (text) => escapeProseForMdxIngress(normalizeGfmTableHardBreaks(text)),
    postParse: demoteAutolinks,
    // Canonical AFTER the wrapper, not before it. `serializeLayoutBlock`
    // re-parses the block it is wrapping and stringifies it inside a JSX
    // element, and mdast spells a break in a table cell `<br />` — so
    // canonicalizing first left the wrapper free to undo it, and MDX ingress
    // escapes that `<`, which read a broken line back as the literal text
    // `head<br />down`. A pipe cell's break is `\` at the end of the line
    // wherever the table sits, Layout included.
    postSerializeBlock: (node, serialized, ctx) =>
      canonicalizeGfmTableHardBreaks(serializeLayoutBlock(node, serialized, ctx)),
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
