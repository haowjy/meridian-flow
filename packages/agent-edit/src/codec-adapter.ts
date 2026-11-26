import type {
  DocumentLinkScope,
  MarkupCodec,
  ParsedContent,
  ParsedContentWithSpans,
  ParseOptions,
  PMNode,
  SerializedBlock,
} from "@meridian/markup";
import { createShownLinkLedger, type ShownLinkLedger } from "./links/shown.js";
import { toHashline } from "./model/hashline.js";

export interface AgentEditCodec {
  readonly markup: MarkupCodec;

  parse(content: string, options?: ParseOptions): ParsedContent;
  parseWithSpans(content: string, options?: ParseOptions): ParsedContentWithSpans;
  serialize(blocks: PMNode[]): string;
  serializeBlockBodies(blocks: readonly PMNode[]): SerializedBlock[];

  serializeBlock(block: PMNode, hash: string): string;

  serializeBlocks(blocks: readonly PMNode[], hashes: readonly string[]): string[];

  serializeSelection(
    document: readonly PMNode[],
    hashes: readonly string[],
    picked: readonly number[],
  ): SerializedBlock[];

  shownLinks: ShownLinkLedger["shownLinks"];
}

export interface AgentEditCodecFactory {
  readonly markup: MarkupCodec;
  parse(content: string): ParsedContent;
  parseWithSpans(content: string): ParsedContentWithSpans;
  forScope(links: DocumentLinkScope): AgentEditCodec;
}

export function createAgentEditCodecFactory(markup: MarkupCodec): AgentEditCodecFactory {
  return {
    markup,
    parse: (content) => markup.parse(content),
    parseWithSpans: (content) => markup.parseWithSpans(content),
    forScope: (links) => agentEditCodecForScope(markup, links),
  };
}

function agentEditCodecForScope(markup: MarkupCodec, links: DocumentLinkScope): AgentEditCodec {
  const ledger = createShownLinkLedger(links, markup);
  return {
    markup,
    parse: (content, options) => markup.parse(content, options),
    parseWithSpans: (content, options) => markup.parseWithSpans(content, options),
    serialize: (blocks) => markup.serialize(blocks, links),
    serializeBlockBodies: (blocks) => markup.serializeBlocks(blocks, links),

    serializeBlock(block, hash) {
      const body = markup.serializeBlock(block, links);
      ledger.record([block], [hash], [body]);
      return toHashline(hash, body);
    },

    serializeBlocks(blocks, hashes) {
      const bodies = markup.serializeBlocks(blocks, links).map((entry) => entry.body);
      ledger.record(blocks, hashes, bodies);
      return bodies;
    },

    serializeSelection(document, hashes, picked) {
      const all = markup.serializeBlocks(document, links);
      const entries = picked.map((index) => all[index]);
      ledger.record(
        picked.map((index) => document[index]),
        picked.map((index) => hashes[index]),
        entries.map((entry) => entry.body),
      );
      return entries;
    },

    shownLinks: (items) => ledger.shownLinks(items),
  };
}
