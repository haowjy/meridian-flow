/** Pure-markdown plugin and convenience codec preset. */

import type { Schema } from "prosemirror-model";
import type { PluggableList } from "unified";

import { createMarkupCodec } from "../codec.js";
import { demoteAutolinks } from "../helpers.js";
import type { AssetPathResolver, BlockCodec, MarkCodec, MarkupPlugin } from "../types.js";
import {
  blockquoteCodec,
  bulletListCodec,
  codeBlockCodec,
  headingCodec,
  horizontalRuleCodec,
  imageCodec,
  listItemCodec,
  orderedListCodec,
  paragraphCodec,
  tableCodec,
} from "./blocks/index.js";
import { normalizeGfmTableHardBreaks } from "./blocks/table.js";
import {
  codeMarkCodec,
  emMarkCodec,
  linkMarkCodec,
  strikeMarkCodec,
  strongMarkCodec,
} from "./marks/index.js";

export const markdownBlockCodecs: readonly BlockCodec[] = [
  tableCodec,
  paragraphCodec,
  headingCodec,
  codeBlockCodec,
  bulletListCodec,
  orderedListCodec,
  listItemCodec,
  blockquoteCodec,
  imageCodec,
  horizontalRuleCodec,
];

export const markdownMarkCodecs: readonly MarkCodec[] = [
  strongMarkCodec,
  emMarkCodec,
  codeMarkCodec,
  linkMarkCodec,
  strikeMarkCodec,
];

export const markdownRequiredBlockNames: readonly string[] = Object.freeze(
  markdownBlockCodecs.map((codec) => codec.name),
);

export function markdown(): MarkupPlugin {
  return {
    blocks: markdownBlockCodecs,
    marks: markdownMarkCodecs,
    preprocess: normalizeGfmTableHardBreaks,
    postParse: demoteAutolinks,
  };
}

/**
 * The canonical Markdown codec. `remarkPlugins` extend it for one caller (the
 * clipboard door keeps an escaped `\[[` the writer meant literally); the wire
 * codec takes none.
 */
export function markdownCodec(options: {
  schema: Schema;
  assetPathResolver: AssetPathResolver;
  remarkPlugins?: PluggableList;
}) {
  const { remarkPlugins, ...codecOptions } = options;
  return createMarkupCodec(codecOptions)
    .use(markdown())
    .use({ remarkPlugins })
    .build({ requiredBlockNames: markdownRequiredBlockNames });
}
