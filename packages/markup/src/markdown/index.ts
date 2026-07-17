/** Pure-markdown plugin and convenience codec preset. */

import type { Schema } from "prosemirror-model";

import { createMarkupCodec } from "../codec.js";
import { demoteAutolinks } from "../helpers.js";
import type { BlockCodec, MarkCodec, MarkupPlugin } from "../types.js";
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
    postParse: demoteAutolinks,
  };
}

export function markdownCodec(options: {
  schema: Schema;
  assetPathResolver: import("../types.js").AssetPathResolver;
}) {
  return createMarkupCodec(options)
    .use(markdown())
    .build({ requiredBlockNames: markdownRequiredBlockNames });
}
