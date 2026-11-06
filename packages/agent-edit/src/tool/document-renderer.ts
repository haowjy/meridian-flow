// Turns document blocks into agent-facing text and parses agent input.

import type { ParsedContent } from "@meridian/markup";
import type { AgentEditCodec, AgentEditCodecFactory } from "../codec-adapter.js";
import type { DocHandle } from "../handles.js";
import type { AgentEditModel, ProjectedBlock } from "../ports/model.js";
import { hashLocateContext } from "../resolver/hash-locator.js";
import {
  headingSectionFragments,
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
  | {
      ok: true;
      /** The selected blocks, in document order. */
      selected: readonly ProjectedBlock[];
      /** The one projection of the document, whole: its size and headings; never re-project. */
      projected: readonly ProjectedBlock[];
    }
  | { ok: false; code: "not_found" | "invalid_write"; message: string; documentBlocks?: number };

export interface DocumentRenderer {
  selectReadBlocks(
    doc: DocHandle,
    command: ReadCommand,
    address: DocumentRenderAddress,
  ): ReadBlockSelection;
  renderRead(
    selection: Extract<ReadBlockSelection, { ok: true }>,
    codec: AgentEditCodec,
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
    renderRead,
    parseForCommand,
  };

  function selectReadBlocks(
    doc: DocHandle,
    command: ReadCommand,
    address: DocumentRenderAddress,
  ): ReadBlockSelection {
    // Projecting repairs the document, so it runs before any scope takes an index.
    const projected = model.projectBlocks(doc);
    const scopeContext = hashLocateContext(model, projected);
    const scopeSelection = (result: ScopeResult): ReadBlockSelection => {
      if (result.ok) {
        const { startIndex, blocks } = result.scope;
        return {
          ok: true,
          selected: projected.slice(startIndex, startIndex + blocks.length),
          projected,
        };
      }
      if (result.code === "ambiguous") {
        const matches = new Set(result.matches);
        return {
          ok: true,
          selected: projected.filter((block) => matches.has(block.ref)),
          projected,
        };
      }
      return result;
    };
    if (address.fragment) return scopeSelection(resolveScope(scopeContext, `#${address.fragment}`));
    if (command.around !== undefined) {
      return scopeSelection(resolveSearchScope(scopeContext, undefined, command.around));
    }
    if (command.in !== undefined) return scopeSelection(resolveScope(scopeContext, command.in));
    return { ok: true, selected: projected, projected };
  }

  function renderRead(
    { selected, projected }: Extract<ReadBlockSelection, { ok: true }>,
    codec: AgentEditCodec,
    format: "full" | "outline",
  ): RenderedRead {
    const headingBlocks =
      format === "outline" ? selected.filter((block) => isHeading(model, block.ref)) : [];
    const outline = headingBlocks.length > 0;
    const shown = outline ? headingBlocks : selected;
    const bodies = codec.serializeBlocks(
      shown.map((block) => block.node),
      shown.map((block) => block.hash),
    );
    const items: RenderedRead["blocks"] = shown.map((block, index) => ({
      hash: block.hash,
      body: bodies[index],
    }));
    if (outline) {
      const fragments = headingSectionFragments(hashLocateContext(model, projected));
      items.forEach((item, index) => {
        const section = fragments.get(shown[index].ref);
        if (section !== undefined) item.section = section;
      });
    }
    return {
      format: outline ? "outline" : "full",
      blocks: items,
      documentBlocks: projected.length,
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
