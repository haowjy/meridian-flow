// Turns document blocks into agent-facing text and parses agent input.

import type { ParsedContent } from "@meridian/markup";
import type { BlockRef } from "../block-ref.js";
import type { AgentEditCodec } from "../codec-adapter.js";
import type { DocHandle } from "../doc-handle.js";
import { projectDocumentBlocks } from "../model/block-projection.js";
import type { AgentEditModel } from "../ports/model.js";
import { isHeading, resolveScope, resolveSearchScope } from "../resolver/scope.js";
import type { ViewCommand } from "./types.js";

export interface DocumentRenderAddress {
  filePath: string;
  fragment?: string;
}

export type ViewBlockSelection =
  | { ok: true; blocks: BlockRef[] }
  | { ok: false; code: "not_found" | "invalid_write"; message: string };

export interface DocumentRenderer {
  selectViewBlocks(
    doc: DocHandle,
    command: ViewCommand,
    address: DocumentRenderAddress,
  ): ViewBlockSelection;
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
    selectViewBlocks,
    renderBlocks,
    renderBlockLines,
    renderOutline,
    parseForCommand,
  };

  function selectViewBlocks(
    doc: DocHandle,
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

  function renderBlocks(doc: DocHandle, blocks: readonly BlockRef[]): string {
    return renderBlockLines(doc, blocks).join("\n");
  }

  function renderBlockLines(doc: DocHandle, blocks?: readonly BlockRef[]): string[] {
    const projection = projectDocumentBlocks(doc, model);
    if (projection.blocks.length === 0) return [];
    if (!blocks) return codec.serializeBlocks(projection.pmBlocks, projection.hashes);
    const selected = projection.select(blocks);
    const pmBlocks = selected.map((block) => block.pmBlock);
    const hashes = selected.map((block) => block.hash);
    return codec.serializeBlocks(pmBlocks, hashes);
  }

  function renderOutline(doc: DocHandle, blocks: readonly BlockRef[], filePath: string): string {
    if (blocks.length === 0) return "";
    const projection = projectDocumentBlocks(doc, model);
    const headingBlocks = projection.select(blocks).filter(({ block }) => isHeading(model, block));
    if (headingBlocks.length === 0) return renderBlocks(doc, blocks);
    const lines: string[] = [];
    const serialized = codec.serializeBlocks(
      headingBlocks.map((block) => block.pmBlock),
      headingBlocks.map((block) => block.hash),
    );
    for (let i = 0; i < headingBlocks.length; i++) {
      lines.push(serialized[i]);
      lines.push(`write(command="view", file="${filePath}#${headingBlocks[i].hash}")`);
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
