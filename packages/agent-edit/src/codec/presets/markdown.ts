import type { Schema } from "prosemirror-model";

import type { ComponentRegistry } from "../../registry/component-registry.js";
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
} from "../blocks/index.js";
import { createCodec } from "../create-codec.js";
import { codeMarkCodec, emMarkCodec, linkMarkCodec, strongMarkCodec } from "../marks/index.js";
import type { BlockCodec, MarkCodec } from "../types.js";

export interface CodecPresetOptions {
  schema?: Schema;
  components?: ComponentRegistry;
}

export const markdownBlockCodecs: readonly BlockCodec[] = [
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
];

export const markdownRequiredBlockNames = [
  "paragraph",
  "heading",
  "code_block",
  "bullet_list",
  "ordered_list",
  "list_item",
  "blockquote",
  "image",
  "horizontal_rule",
] as const;

export function markdownCodec(options: CodecPresetOptions = {}) {
  return createCodec({
    ...options,
    blocks: markdownBlockCodecs,
    marks: markdownMarkCodecs,
    requiredBlockNames: markdownRequiredBlockNames,
  });
}
