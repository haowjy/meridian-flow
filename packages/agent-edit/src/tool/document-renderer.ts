// Turns document blocks into agent-facing text and parses agent input.

import type { ParsedContent } from "@meridian/markup";
import type { AgentEditCodec } from "../codec-adapter.js";
import type { BlockRef, DocHandle } from "../handles.js";
import type { AgentEditModel } from "../ports/model.js";
import {
  isHeading,
  resolveScope,
  resolveSearchScope,
  type ScopeResult,
} from "../resolver/scope.js";
import type { ReadCommand } from "./types.js";

export interface DocumentRenderAddress {
  filePath: string;
  fragment?: string;
}

export type ReadBlockSelection =
  | { ok: true; blocks: Array<BlockRef> }
  | { ok: false; code: "not_found" | "invalid_write"; message: string };

export interface DocumentRenderer {
  selectReadBlocks(
    doc: DocHandle,
    command: ReadCommand,
    address: DocumentRenderAddress,
  ): ReadBlockSelection;
  renderBlocks(doc: DocHandle, blocks: readonly BlockRef[]): string;
  renderBlockLines(doc: DocHandle, blocks?: readonly BlockRef[]): string[];
  renderOutline(doc: DocHandle, blocks: readonly BlockRef[], filePath: string): string;
  parseForCommand(content: string): ParseForCommandResult;
}

export type ParseForCommandResult =
  | { ok: true; parsed: ParsedContent }
  | { ok: false; message: string };

export function createDocumentRenderer(deps: {
  model: AgentEditModel;
  codec: AgentEditCodec;
}): DocumentRenderer {
  const { model, codec } = deps;

  return {
    selectReadBlocks,
    renderBlocks,
    renderBlockLines,
    renderOutline,
    parseForCommand,
  };

  function selectReadBlocks(
    doc: DocHandle,
    command: ReadCommand,
    address: DocumentRenderAddress,
  ): ReadBlockSelection {
    const scopeContext = { doc, model };
    if (address.fragment && (command.in !== undefined || command.around !== undefined)) {
      return {
        ok: false,
        code: "invalid_write",
        message: "Use either file #fragment, in, or around for read scope, not multiple.",
      };
    }
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

  function renderBlocks(doc: DocHandle, blocks: readonly BlockRef[]): string {
    return renderBlockLines(doc, blocks).join("\n");
  }

  function renderBlockLines(doc: DocHandle, blocks?: readonly BlockRef[]): string[] {
    return model.serializeBlockLines(doc, codec, blocks);
  }

  function renderOutline(doc: DocHandle, blocks: readonly BlockRef[], filePath: string): string {
    if (blocks.length === 0) return "";
    const headingBlocks = blocks.filter((block) => isHeading(model, block));
    if (headingBlocks.length === 0) return renderBlocks(doc, blocks);
    const lines: string[] = [];
    const serialized = model.serializeBlockLines(doc, codec, headingBlocks);
    for (let i = 0; i < headingBlocks.length; i++) {
      const hash = model.getBlockId(headingBlocks[i]);
      lines.push(serialized[i]);
      lines.push(`write(command="read", file="${filePath}#${hash}")`);
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
