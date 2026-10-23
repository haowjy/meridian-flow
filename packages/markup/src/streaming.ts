/** Whole-source Markdown parsing with conservative unfinished-mark repair. */

import type { Node as PMNode } from "prosemirror-model";
import remend from "remend";

import { markdownSyntax } from "./markdown/syntax.js";
import { sourceRange } from "./presentation-source-map.js";
import type { MarkdownStreamOptions, MarkdownStreamResult } from "./types.js";

export type RepairTail = { from: number };

interface ParsedStreamDocument {
  blocks: PMNode[];
  repairTail: RepairTail | null;
}

export function parseStreamingDocument(
  source: string,
  options: MarkdownStreamOptions,
  parse: (source: string) => ParsedStreamDocument,
): MarkdownStreamResult {
  const canonical = parse(source);
  const openCode = markdownOpenCode(canonical.blocks, source);
  if (!options.repair) return { blocks: canonical.blocks, openCode };

  const blockStart = canonical.repairTail?.from;
  if (blockStart === undefined) return { blocks: canonical.blocks, openCode };

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

/** The last source character must belong to ordinary prose, not an opaque inline construct. */
export function repairableTail(block: unknown, sourceLength: number): boolean {
  if (!block || typeof block !== "object") return false;
  const typed = block as { type?: string; children?: unknown[] };
  if (
    typed.type !== "paragraph" &&
    typed.type !== "heading" &&
    typed.type !== "blockquote" &&
    typed.type !== "list"
  ) {
    return false;
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
      return false;
    }
    if (value.type === "text") {
      return sourceRange(value)?.to === sourceLength;
    }
    node = value.children?.at(-1);
  }
  return false;
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
  const last = blocks.at(-1);
  if (!last || !endsInCode(last) || (!source.includes("```") && !source.includes("~~~"))) {
    return null;
  }
  const openIndex = markdownSyntax(source).code.findIndex(
    (region) => region.fenced && !region.closed && region.to === source.length,
  );
  return openIndex === -1 ? null : (codeNodes(blocks)[openIndex] ?? null);
}

function endsInCode(node: PMNode): boolean {
  if (node.type.name === "code_block") return true;
  return node.lastChild ? endsInCode(node.lastChild) : false;
}

function repairIsSafe(canonical: readonly PMNode[], candidate: readonly PMNode[]): boolean {
  if (canonical.length !== candidate.length || canonical.length === 0) return false;
  if (canonical.slice(0, -1).some((node, index) => !candidate[index]?.eq(node))) return false;
  const last = canonical.at(-1);
  const candidateLast = candidate.at(-1);
  if (!last || !candidateLast || last.eq(candidateLast)) return false;
  if (!addsFormatting(last, candidateLast)) return false;

  const beforeCode = codeNodes(canonical);
  const afterCode = codeNodes(candidate);
  return (
    beforeCode.length === afterCode.length &&
    beforeCode.every((node, index) => afterCode[index]?.eq(node))
  );
}

function addsFormatting(before: PMNode, after: PMNode): boolean {
  const available = formattingTokens(before);
  for (const [token, count] of formattingTokens(after)) {
    if ((available.get(token) ?? 0) < count) return true;
  }
  return false;
}

function formattingTokens(root: PMNode): Map<string, number> {
  const tokens = new Map<string, number>();
  root.descendants((node) => {
    if (!node.isText) addToken(tokens, `node:${node.type.name}:${JSON.stringify(node.attrs)}`);
    for (const mark of node.marks) {
      addToken(tokens, `mark:${mark.type.name}:${JSON.stringify(mark.attrs)}:${node.textContent}`);
    }
  });
  return tokens;
}

function addToken(tokens: Map<string, number>, token: string): void {
  tokens.set(token, (tokens.get(token) ?? 0) + 1);
}
