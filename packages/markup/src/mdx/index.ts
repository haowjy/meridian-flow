/** Canonical MDX plugin and convenience codec preset. */

import type { Schema } from "prosemirror-model";
import remarkMdx from "remark-mdx";

import { createMarkupCodec } from "../codec.js";
import type { ComponentRegistry } from "../components.js";
import { escapeProseForMdxIngress } from "../escape.js";
import { demoteAutolinks } from "../helpers.js";
import { markdownBlockCodecs, markdownMarkCodecs } from "../markdown/index.js";
import type { BlockCodec, MarkupPlugin } from "../types.js";
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
    createJsxContainerCodec(components),
    createJsxLeafCodec(components),
    ...markdownBlockCodecs,
  ];
}

export const mdxRequiredBlockNames: readonly string[] = Object.freeze(
  mdxBlockCodecs()
    .map((codec) => codec.name)
    .filter((name) => name !== "layout"),
);

export function mdx(options?: { components?: ComponentRegistry }): MarkupPlugin {
  return {
    blocks: mdxBlockCodecs(options?.components),
    marks: markdownMarkCodecs,
    remarkPlugins: [remarkMdx],
    preprocess: escapeProseForMdxIngress,
    postParse: demoteAutolinks,
    postSerializeBlock: serializeLayoutBlock,
  };
}

export function mdxCodec(options: { schema: Schema; components?: ComponentRegistry }) {
  return createMarkupCodec({ schema: options.schema })
    .use(mdx({ components: options.components }))
    .build({ requireSchemaBlockCoverage: true });
}
