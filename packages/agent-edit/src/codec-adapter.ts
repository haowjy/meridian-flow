// Adapts the pure markup codec to agent-edit's hash-prefixed block display contract.
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

/** A codec bound to one holder's link scope: every serialization spells through it. */
export interface AgentEditCodec {
  /** The underlying pure markup codec. */
  readonly markup: MarkupCodec;

  /** `within`: the `open` of the block the content lands beside, so its nesting reads there. */
  parse(content: string, options?: ParseOptions): ParsedContent;
  /** Parse with each link occurrence's source span (pure syntax, like `parse`). */
  parseWithSpans(content: string, options?: ParseOptions): ParsedContentWithSpans;
  serialize(blocks: PMNode[]): string;
  /** Each block as it sits in the document, with the gap that separates it from the one before. */
  serializeBlockBodies(blocks: readonly PMNode[]): SerializedBlock[];

  /** Serialize a single block with the hash prefix used by agent-edit echoes. */
  serializeBlock(block: PMNode, hash: string): string;

  /**
   * Bodies of blocks shown to the model under `hashes[i]`, recording the links each
   * showed in the shown-link ledger. Compose the line with `toHashline`.
   */
  serializeBlocks(blocks: readonly PMNode[], hashes: readonly string[]): string[];

  /**
   * The blocks at `picked` of a whole document, each as it sits there (its containers' prefixes
   * and its gap), recording the links they showed. `hashes` are the whole document's.
   */
  serializeSelection(
    document: readonly PMNode[],
    hashes: readonly string[],
    picked: readonly number[],
  ): SerializedBlock[];

  /**
   * Host-only facts for items this codec rendered as hashlines (whole or as a
   * prefix): each ref and the address it spelled at that render.
   */
  shownLinks: ShownLinkLedger["shownLinks"];
}

/**
 * Parse is pure syntax and needs no scope; serializing does. Each command
 * takes the codec for its scope once at entry, after its host prepared the
 * scope, and passes that codec down.
 */
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
