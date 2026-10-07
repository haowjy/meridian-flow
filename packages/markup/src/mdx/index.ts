/** Canonical MDX plugin and convenience codec preset. */

import type { Schema } from "prosemirror-model";
import remarkMdx from "remark-mdx";

import { createMarkupCodec } from "../codec.js";
import type { ComponentRegistry } from "../components.js";
import { escapeProseForMdxIngress } from "../escape.js";
import { demoteAutolinks } from "../helpers.js";
import { joinBreakLines } from "../markdown/blocks/hard-break.js";
import { hardBreakCodec, imageCodec, tableCodec } from "../markdown/blocks/index.js";
import { normalizeGfmTableHardBreaks } from "../markdown/blocks/table.js";
import { markdownBlockCodecs, markdownMarkCodecs } from "../markdown/index.js";
import type { AssetPathResolver, BlockCodec, MarkupPlugin } from "../types.js";
import {
  createFigureCodec,
  createJsxContainerCodec,
  createJsxLeafCodec,
  createLayoutCodec,
  serializeLayoutBlock,
} from "./blocks/index.js";

/**
 * The MDX block chain. The codecs hoisted above the JSX ones own raw tags MDX
 * would otherwise hand to a component that does not exist: a `<table>` too
 * shaped for pipes, the `<img>` a picture with a display size escalates to, and
 * the `<br/>` a trailing hard break escalates to.
 */
export function mdxBlockCodecs(components?: ComponentRegistry): readonly BlockCodec[] {
  const hoisted = new Set([tableCodec.name, imageCodec.name, hardBreakCodec.name]);
  return [
    createLayoutCodec(),
    createFigureCodec(),
    tableCodec,
    imageCodec,
    hardBreakCodec,
    createJsxContainerCodec(components),
    createJsxLeafCodec(components),
    ...markdownBlockCodecs.filter((codec) => !hoisted.has(codec.name)),
  ];
}

export function mdx(options?: { components?: ComponentRegistry }): MarkupPlugin {
  return {
    blocks: mdxBlockCodecs(options?.components),
    marks: markdownMarkCodecs,
    remarkPlugins: [remarkMdx],
    preprocess: (text) => escapeProseForMdxIngress(normalizeGfmTableHardBreaks(text)),
    postParse: (root, source) => joinBreakLines(demoteAutolinks(root, source)),
    postSerializeBlock: serializeLayoutBlock,
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
