// Turns Y.Doc blocks into agent-facing text and parses agent input.
import type * as Y from "yjs";

import type { Block, Codec, ParsedContent } from "../codec/types.js";
import type { AgentEditModel } from "../ports/model.js";
import { isHeading, resolveScope, resolveSearchScope } from "../resolver/scope.js";
import type { ViewCommand } from "./types.js";

export interface DocumentRenderAddress {
  filePath: string;
  fragment?: string;
}

export type ViewBlockSelection =
  | { ok: true; blocks: Y.XmlElement[] }
  | { ok: false; code: "not_found" | "invalid_write"; message: string };

export interface DocumentRenderer {
  selectViewBlocks(
    doc: Y.Doc,
    command: ViewCommand,
    address: DocumentRenderAddress,
  ): ViewBlockSelection;
  renderBlocks(doc: Y.Doc, blocks: readonly Y.XmlElement[]): string;
  renderBlockLines(doc: Y.Doc, blocks?: readonly Y.XmlElement[]): string[];
  renderOutline(doc: Y.Doc, blocks: readonly Y.XmlElement[], filePath: string): string;
  parseForCommand(content: string): ParseForCommandResult;
}

export type ParseForCommandResult =
  | { ok: true; parsed: ParsedContent }
  | { ok: false; message: string };

export function createDocumentRenderer(deps: {
  model: AgentEditModel;
  codec: Codec;
}): DocumentRenderer {
  const { model, codec } = deps;

  return {
    selectViewBlocks,
    renderBlocks,
    renderBlockLines,
    renderOutline,
    parseForCommand,
  };

  function selectViewBlocks(
    doc: Y.Doc,
    command: ViewCommand,
    address: DocumentRenderAddress,
  ): ViewBlockSelection {
    const scopeContext = { doc, model };
    if (address.fragment && (command.in !== undefined || command.around !== undefined)) {
      return {
        ok: false,
        code: "invalid_write",
        message: "Use either file #fragment, in, or around for view scope, not multiple.",
      };
    }
    if (address.fragment) {
      const result = resolveScope(scopeContext, `#${address.fragment}`);
      return result.ok ? { ok: true, blocks: result.scope.blocks } : result;
    }
    if (command.around !== undefined) {
      const result = resolveSearchScope(scopeContext, undefined, command.around);
      return result.ok ? { ok: true, blocks: result.scope.blocks } : result;
    }
    if (command.in !== undefined) {
      const result = resolveScope(scopeContext, command.in);
      return result.ok ? { ok: true, blocks: result.scope.blocks } : result;
    }
    return { ok: true, blocks: model.getBlocks(doc) };
  }

  function renderBlocks(doc: Y.Doc, blocks: readonly Y.XmlElement[]): string {
    return renderBlockLines(doc, blocks).join("\n");
  }

  function renderBlockLines(doc: Y.Doc, blocks?: readonly Y.XmlElement[]): string[] {
    const selected = blocks ?? model.getBlocks(doc);
    if (selected.length === 0) return [];
    // Batch path: project PM tree + compute hashes once for the whole doc,
    // then filter to the selected blocks. For full-doc renders (no `blocks`
    // arg) this is O(D + B·S) instead of O(B·D + B·S).
    if (!blocks) {
      const hashes = model.getBlockIds(doc);
      const pmBlocks = model.toProsemirrorBlocks(doc);
      return codec.serializeBlocks(pmBlocks, hashes);
    }
    // Subset render: the blocks arg is a slice of the doc's blocks. Map them
    // to their PM nodes + hashes via index lookup.
    const allBlocks = model.getBlocks(doc);
    const allHashes = model.getBlockIds(doc);
    const allPmBlocks = model.toProsemirrorBlocks(doc);
    const indexByBlock = new Map<Y.XmlElement, number>();
    for (let i = 0; i < allBlocks.length; i++) indexByBlock.set(allBlocks[i], i);
    const pmBlocks: Block[] = [];
    const hashes: string[] = [];
    for (const block of selected) {
      const idx = indexByBlock.get(block);
      if (idx !== undefined) {
        pmBlocks.push(allPmBlocks[idx]);
        hashes.push(allHashes[idx]);
      }
    }
    return codec.serializeBlocks(pmBlocks, hashes);
  }

  function renderOutline(doc: Y.Doc, blocks: readonly Y.XmlElement[], filePath: string): string {
    if (blocks.length === 0) return "";
    const allBlocks = model.getBlocks(doc);
    const allHashes = model.getBlockIds(doc);
    const allPmBlocks = model.toProsemirrorBlocks(doc);
    const indexByBlock = new Map<Y.XmlElement, number>();
    for (let i = 0; i < allBlocks.length; i++) indexByBlock.set(allBlocks[i], i);
    const headingBlocks: Block[] = [];
    const headingHashes: string[] = [];
    for (const block of blocks) {
      if (!isHeading(block)) continue;
      const idx = indexByBlock.get(block);
      if (idx !== undefined) {
        headingBlocks.push(allPmBlocks[idx]);
        headingHashes.push(allHashes[idx]);
      }
    }
    if (headingBlocks.length === 0) return renderBlocks(doc, blocks);
    const lines: string[] = [];
    const serialized = codec.serializeBlocks(headingBlocks, headingHashes);
    for (let i = 0; i < headingBlocks.length; i++) {
      lines.push(serialized[i]);
      lines.push(`write(command="view", file="${filePath}#${headingHashes[i]}")`);
    }
    return lines.join("\n");
  }

  function parseForCommand(content: string): ParseForCommandResult {
    try {
      return { ok: true, parsed: codec.parse(content) };
    } catch (cause) {
      return { ok: false, message: cause instanceof Error ? cause.message : String(cause) };
    }
  }
}
