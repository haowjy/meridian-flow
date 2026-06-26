// Adapts the pure markup codec to agent-edit's hash-prefixed block display contract.
import type { MarkupCodec, ParsedContent, PMNode } from "@meridian/markup";

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
      const body = markup.serializeBlock(block);
      return body.includes("\n") ? `${hash}|\n${body}` : `${hash}|${body}`;
    },

    serializeBlocks(blocks, hashes) {
      const bodies = markup.serializeBlocks(blocks);
      return bodies.map((body, index) => {
        const hash = hashes[index] ?? "";
        return body.includes("\n") ? `${hash}|\n${body}` : `${hash}|${body}`;
      });
    },
  };
}
