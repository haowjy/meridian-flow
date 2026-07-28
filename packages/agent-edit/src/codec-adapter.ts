// Adapts the pure markup codec to agent-edit's hash-prefixed block display contract.
import type { MarkupCodec, ParsedContent, PMNode } from "@meridian/markup";
import { toHashline } from "./model/hashline.js";

export interface AgentEditCodec {
  /** The underlying pure markup codec. */
  readonly markup: MarkupCodec;

  parse(content: string): ParsedContent;
  serialize(blocks: PMNode[]): string;
  serializeBlockBodies(blocks: readonly PMNode[]): string[];

  /** Serialize a single block with the hash prefix used by agent-edit echoes. */
  serializeBlock(block: PMNode, hash: string): string;

  /** Batch version of serializeBlock for callers that already have aligned hashes. */
  serializeBlocks(blocks: readonly PMNode[], hashes: readonly string[]): string[];
}

export function createAgentEditCodec(markup: MarkupCodec): AgentEditCodec {
  return {
    markup,
    parse: (content) => markup.parse(content),
    serialize: (blocks) => markup.serialize(blocks),
    serializeBlockBodies: (blocks) => markup.serializeBlocks(blocks),

    serializeBlock(block, hash) {
      return toHashline(hash, markup.serializeBlock(block));
    },

    serializeBlocks(blocks, hashes) {
      return markup
        .serializeBlocks(blocks)
        .map((body, index) => toHashline(hashes[index] ?? "", body));
    },
  };
}
