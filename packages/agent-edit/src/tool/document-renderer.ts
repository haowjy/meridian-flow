// Turns document blocks into agent-facing text and parses agent input.

import type { ParsedContent } from "@meridian/markup";
import type { AgentEditCodec, AgentEditCodecFactory } from "../codec-adapter.js";
import type { BlockRef, DocHandle } from "../handles.js";
import type { AgentEditModel } from "../ports/model.js";
import {
  headingSectionFragments,
  isHeading,
  resolveScope,
  resolveSearchScope,
  type ScopeResult,
} from "../resolver/scope.js";
import { modelBlockItem } from "./model-result.js";
import type { ReadCommand } from "./types.js";

export interface DocumentRenderAddress {
  filePath: string;
  fragment?: string;
}

export type ReadBlockSelection =
  | { ok: true; blocks: Array<BlockRef> }
  | { ok: false; code: "not_found" | "invalid_write"; message: string; documentBlocks?: number };

export interface DocumentRenderer {
  selectReadBlocks(
    doc: DocHandle,
    command: ReadCommand,
    address: DocumentRenderAddress,
  ): ReadBlockSelection;
  renderBlockLines(doc: DocHandle, codec: AgentEditCodec, blocks?: readonly BlockRef[]): string[];
  renderRead(
    doc: DocHandle,
    codec: AgentEditCodec,
    blocks: readonly BlockRef[],
    format: "full" | "outline",
  ): RenderedRead;
  parseForCommand(content: string): ParseForCommandResult;
}

export interface RenderedRead {
  /** The format actually rendered: an outline of a document with no headings is full. */
  format: "full" | "outline";
  /** An outline heading's `section` is the slug fragment that reads it, when one is safe. */
  blocks: Array<{ hash: string; body: string; section?: string }>;
  /** How many blocks the whole document has, so a narrowed read can say it is partial. */
  documentBlocks: number;
}

export type ParseForCommandResult =
  | { ok: true; parsed: ParsedContent }
  | { ok: false; message: string };

export function createDocumentRenderer(deps: {
  model: AgentEditModel;
  codec: AgentEditCodecFactory;
}): DocumentRenderer {
  const { model, codec } = deps;

  return {
    selectReadBlocks,
    renderBlockLines,
    renderRead,
    parseForCommand,
  };

  function selectReadBlocks(
    doc: DocHandle,
    command: ReadCommand,
    address: DocumentRenderAddress,
  ): ReadBlockSelection {
    const scopeContext = { doc, model };
    if (address.fragment) {
      const result = resolveScope(scopeContext, `#${address.fragment}`);
      return scopeSelection(result);
    }
    if (command.around !== undefined) {
      const result = resolveSearchScope(scopeContext, undefined, command.around);
      return scopeSelection(result);
    }
    if (command.in !== undefined) {
      const result = resolveScope(scopeContext, command.in);
      return scopeSelection(result);
    }
    return { ok: true, blocks: model.getBlocks(doc) };
  }

  function scopeSelection(result: ScopeResult): ReadBlockSelection {
    if (result.ok) return { ok: true, blocks: result.scope.blocks };
    if (result.code === "ambiguous") return { ok: true, blocks: result.matches };
    return result;
  }

  function renderBlockLines(
    doc: DocHandle,
    codec: AgentEditCodec,
    blocks?: readonly BlockRef[],
  ): string[] {
    return model.serializeBlockLines(doc, codec, blocks);
  }

  function renderRead(
    doc: DocHandle,
    codec: AgentEditCodec,
    blocks: readonly BlockRef[],
    format: "full" | "outline",
  ): RenderedRead {
    const headingBlocks =
      format === "outline" ? blocks.filter((block) => isHeading(model, block)) : [];
    const outline = headingBlocks.length > 0;
    const rendered = outline ? headingBlocks : blocks;
    const items = model.serializeBlockLines(doc, codec, rendered).map(modelBlockItem);
    if (outline) {
      const fragments = headingSectionFragments({ doc, model });
      items.forEach((item, index) => {
        const section = fragments.get(rendered[index] as BlockRef);
        if (section !== undefined) item.section = section;
      });
    }
    return {
      format: outline ? "outline" : "full",
      blocks: items,
      documentBlocks: model.getBlocks(doc).length,
    };
  }

  function parseForCommand(content: string): ParseForCommandResult {
    try {
      return { ok: true, parsed: codec.parse(content) };
    } catch (cause) {
      return { ok: false, message: cause instanceof Error ? cause.message : String(cause) };
    }
  }
}
