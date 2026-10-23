/** Whole-source Markdown parsing with conservative unfinished-mark repair. */

import type { Node as PMNode } from "prosemirror-model";
import remend from "remend";

import type { MdastRoot } from "./ast.js";
import { markdownSyntax } from "./markdown/syntax.js";
import type { MarkdownStreamOptions, MarkdownStreamResult } from "./types.js";

export type SourceBlock = { from: number; to: number };

interface ParsedStreamDocument {
  blocks: PMNode[];
  ranges: SourceBlock[];
  tree: MdastRoot;
}

export function parseStreamingDocument(
  source: string,
  options: MarkdownStreamOptions,
  parse: (source: string) => ParsedStreamDocument,
): MarkdownStreamResult {
  const canonical = parse(source);
  const openCode = markdownOpenCode(canonical.blocks, source);
  if (!options.repair) return { blocks: canonical.blocks, openCode };

  const tail = repairableTail(canonical.tree, source.length);
  const blockStart = canonical.ranges.at(-1)?.from;
  if (!tail || blockStart === undefined) return { blocks: canonical.blocks, openCode };

  const originalTail = source.slice(blockStart);
  const repairedTail = remend(originalTail, { links: false, images: false, katex: false });
  if (repairedTail === originalTail || !repairedTail.startsWith(originalTail)) {
    return { blocks: canonical.blocks, openCode };
  }

  const candidate = parse(`${source.slice(0, blockStart)}${repairedTail}`);
  if (!repairIsSafe(canonical.blocks, candidate.blocks)) {
    return { blocks: canonical.blocks, openCode };
  }
  return { blocks: candidate.blocks, openCode };
}

function astOffsets(node: unknown): SourceBlock | null {
  if (!node || typeof node !== "object") return null;
  const position = (
    node as { position?: { start?: { offset?: number }; end?: { offset?: number } } }
  ).position;
  const from = position?.start?.offset;
  const to = position?.end?.offset;
  return typeof from === "number" && typeof to === "number" ? { from, to } : null;
}

/** The last source character must belong to ordinary prose, not an opaque inline construct. */
function repairableTail(tree: MdastRoot, sourceLength: number): SourceBlock | null {
  const block = tree.children.at(-1) as unknown;
  if (!block || typeof block !== "object") return null;
  const typed = block as { type?: string; children?: unknown[] };
  if (
    typed.type !== "paragraph" &&
    typed.type !== "heading" &&
    typed.type !== "blockquote" &&
    typed.type !== "list"
  ) {
    return null;
  }

  let node: unknown = typed;
  while (node && typeof node === "object") {
    const value = node as { type?: string; children?: unknown[] };
    if (
      value.type === "inlineCode" ||
      value.type === "code" ||
      value.type === "html" ||
      value.type === "link"
    ) {
      return null;
    }
    if (value.type === "text") {
      const range = astOffsets(value);
      return range?.to === sourceLength ? range : null;
    }
    node = value.children?.at(-1);
  }
  return null;
}

function codeNodes(blocks: readonly PMNode[]): PMNode[] {
  const result: PMNode[] = [];
  for (const block of blocks) {
    if (block.type.name === "code_block") result.push(block);
    block.descendants((node) => {
      if (node.type.name === "code_block") result.push(node);
      return node.type.name !== "code_block";
    });
  }
  return result;
}

export function markdownOpenCode(blocks: readonly PMNode[], source: string): PMNode | null {
  if (!source.includes("```") && !source.includes("~~~")) return null;
  const openIndex = markdownSyntax(source).code.findIndex(
    (region) => region.fenced && !region.closed && region.to === source.length,
  );
  return openIndex === -1 ? null : (codeNodes(blocks)[openIndex] ?? null);
}

function repairIsSafe(canonical: readonly PMNode[], candidate: readonly PMNode[]): boolean {
  if (canonical.length !== candidate.length || canonical.length === 0) return false;
  if (canonical.slice(0, -1).some((node, index) => !candidate[index]?.eq(node))) return false;
  const last = canonical.at(-1);
  const candidateLast = candidate.at(-1);
  if (!last || !candidateLast || last.eq(candidateLast)) return false;

  const beforeCode = codeNodes(canonical);
  const afterCode = codeNodes(candidate);
  return (
    beforeCode.length === afterCode.length &&
    beforeCode.every((node, index) => afterCode[index]?.eq(node))
  );
}
