// Adapts the pure markup codec to agent-edit's hash-prefixed block display contract.
import type { DocumentLinkScope, MarkupCodec, ParsedContent, PMNode } from "@meridian/markup";
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

/**
 * `links` spells every link and image destination this codec serializes. It is
 * captured here only until lane F2 of #729/#730 turns this into a factory that
 * binds a holder scope per command.
 */
export function createAgentEditCodec(
  markup: MarkupCodec,
  links: DocumentLinkScope,
): AgentEditCodec {
  return {
    markup,
    parse: (content) => markup.parse(content),
    serialize: (blocks) => markup.serialize(blocks, links),
    serializeBlockBodies: (blocks) => markup.serializeBlocks(blocks, links),

    serializeBlock(block, hash) {
      return toHashline(hash, markup.serializeBlock(block, links));
    },

    serializeBlocks(blocks, hashes) {
      return markup
        .serializeBlocks(blocks, links)
        .map((body, index) => toHashline(hashes[index] ?? "", body));
    },
  };
}
