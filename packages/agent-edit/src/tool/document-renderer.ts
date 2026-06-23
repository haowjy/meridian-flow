// Turns Y.Doc blocks into agent-facing text and parses agent input.
import type * as Y from "yjs";

import type { Block, Codec, ParsedContent } from "../codec/types.js";
import type { DocumentModel } from "../model/types.js";
import { isHeading, resolveScope, resolveSearchScope } from "../resolver/scope.js";
import type { ViewCommand } from "./types.js";

export interface DocumentRendererModel extends DocumentModel<Y.XmlElement> {
  toProsemirrorBlock(doc: Y.Doc, block: Y.XmlElement): Block;
}

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
  model: DocumentRendererModel;
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
    return (blocks ?? model.getBlocks(doc)).map((block) =>
      codec.serializeBlock(model.toProsemirrorBlock(doc, block), model.getBlockId(block)),
    );
  }

  function renderOutline(doc: Y.Doc, blocks: readonly Y.XmlElement[], filePath: string): string {
    const lines: string[] = [];
    for (const block of blocks) {
      if (!isHeading(block)) continue;
      const hash = model.getBlockId(block);
      lines.push(codec.serializeBlock(model.toProsemirrorBlock(doc, block), hash));
      lines.push(`write(command="view", file="${filePath}#${hash}")`);
    }
    return lines.length > 0 ? lines.join("\n") : renderBlocks(doc, blocks);
  }

  function parseForCommand(content: string): ParseForCommandResult {
    try {
      return { ok: true, parsed: codec.parse(content) };
    } catch (cause) {
      return { ok: false, message: cause instanceof Error ? cause.message : String(cause) };
    }
  }
}
