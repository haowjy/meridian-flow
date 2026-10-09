// Adapts the pure markup codec to agent-edit's hash-prefixed block display contract.
import type {
  DocumentLinkScope,
  MarkupCodec,
  ParsedContent,
  ParsedContentWithSpans,
  PMNode,
} from "@meridian/markup";
import { toHashline } from "./model/hashline.js";

/** A codec bound to one holder's link scope: every serialization spells through it. */
export interface AgentEditCodec {
  /** The underlying pure markup codec. */
  readonly markup: MarkupCodec;

  parse(content: string): ParsedContent;
  /** Parse with each link occurrence's source span (pure syntax, like `parse`). */
  parseWithSpans(content: string): ParsedContentWithSpans;
  serialize(blocks: PMNode[]): string;
  serializeBlockBodies(blocks: readonly PMNode[]): string[];

  /** Serialize a single block with the hash prefix used by agent-edit echoes. */
  serializeBlock(block: PMNode, hash: string): string;

  /** Batch version of serializeBlock for callers that already have aligned hashes. */
  serializeBlocks(blocks: readonly PMNode[], hashes: readonly string[]): string[];
}

/**
 * Parse is pure syntax and needs no scope; serializing does. Each command
 * binds once at entry, after its host prepared the scope, and passes the
 * bound codec down.
 */
export interface AgentEditCodecFactory {
  readonly markup: MarkupCodec;
  parse(content: string): ParsedContent;
  parseWithSpans(content: string): ParsedContentWithSpans;
  bind(links: DocumentLinkScope): AgentEditCodec;
}

export function createAgentEditCodecFactory(markup: MarkupCodec): AgentEditCodecFactory {
  return {
    markup,
    parse: (content) => markup.parse(content),
    parseWithSpans: (content) => markup.parseWithSpans(content),
    bind: (links) => bindAgentEditCodec(markup, links),
  };
}

function bindAgentEditCodec(markup: MarkupCodec, links: DocumentLinkScope): AgentEditCodec {
  return {
    markup,
    parse: (content) => markup.parse(content),
    parseWithSpans: (content) => markup.parseWithSpans(content),
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
