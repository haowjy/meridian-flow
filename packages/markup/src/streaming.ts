/** Immutable append snapshots over the canonical Markdown parser. */

import type { Node as PMNode } from "prosemirror-model";
import remend from "remend";

import type { MdastRoot } from "./ast.js";
import { markdownSyntax } from "./markdown/syntax.js";
import type { MarkdownStreamOptions, MarkdownStreamSnapshot } from "./types.js";

export type SourceBlock = { from: number; to: number };
export interface ParsedStreamDocument {
  blocks: PMNode[];
  ranges: SourceBlock[];
  tree: MdastRoot;
}

type Definition = { identifier: string; source: string; from: number; to: number };
type StreamState = {
  ranges: readonly SourceBlock[];
  definitions: readonly Definition[];
  hasHtml: boolean;
};

type ParseDocument = (source: string) => ParsedStreamDocument;

export function createMarkdownStreamer(parseDocument: ParseDocument) {
  const states = new WeakMap<MarkdownStreamSnapshot, StreamState>();

  const patchReferenceBlocks = (
    retained: readonly PMNode[],
    ranges: readonly SourceBlock[],
    source: string,
    definitions: string,
  ): PMNode[] => {
    const definitionBlockCount = definitions ? parseDocument(definitions).blocks.length : 0;
    return retained.map((block, index) => {
      const range = ranges[index];
      if (!range || !definitions) return block;
      const reparsed = parseDocument(
        `${definitions}\n\n${source.slice(range.from, range.to)}`,
      ).blocks.slice(definitionBlockCount);
      const replacement = reparsed[0];
      return reparsed.length === 1 && replacement && !replacement.eq(block) ? replacement : block;
    });
  };

  const finish = (
    source: string,
    canonical: readonly PMNode[],
    ranges: readonly SourceBlock[],
    definitions: readonly Definition[],
    activeTree: MdastRoot,
    activeSource: string,
    activeOffset: number,
    activeBlockCount: number,
    options: MarkdownStreamOptions,
    fullParse: boolean,
    fullParseReason: MarkdownStreamSnapshot["fullParseReason"],
  ): MarkdownStreamSnapshot => {
    let displaySource = source;
    let blocks = canonical;
    const openCode = openCodeNode(canonical.slice(-activeBlockCount), activeSource);
    if (options.repair) {
      const repair = trailingTextRange(activeTree, activeSource.length);
      if (repair) {
        const text = activeSource.slice(repair.from, repair.to);
        const repaired = remend(text, { links: false, images: false, katex: false });
        if (repaired !== text && repaired.startsWith(text)) {
          const candidateSource = `${activeSource.slice(0, repair.from)}${repaired}`;
          const candidate = parseDocument(candidateSource).blocks;
          const retained = canonical.slice(0, canonical.length - candidate.length);
          if (repairIsSafe(retained, canonical, candidate)) {
            displaySource = `${source.slice(0, activeOffset)}${candidateSource}`;
            blocks = reuseEqualNodes([...retained, ...candidate], canonical);
          }
        }
      }
    }
    const snapshot: MarkdownStreamSnapshot = Object.freeze({
      source,
      displaySource,
      blocks: Object.freeze([...blocks]),
      openCode,
      fullParse,
      fullParseReason,
    });
    states.set(snapshot, {
      ranges: [...ranges],
      definitions: [...definitions],
      hasHtml: containsHtml(activeTree),
    });
    return snapshot;
  };

  const whole = (
    previous: MarkdownStreamSnapshot | null,
    source: string,
    options: MarkdownStreamOptions,
    reason: MarkdownStreamSnapshot["fullParseReason"],
  ): MarkdownStreamSnapshot => {
    const parsed = parseDocument(source);
    return finish(
      source,
      reuseEqualNodes(parsed.blocks, previous?.blocks ?? []),
      parsed.ranges,
      firstDefinitions(collectDefinitions(parsed.tree, source, 0)),
      parsed.tree,
      source,
      0,
      parsed.blocks.length,
      options,
      true,
      reason,
    );
  };

  return (
    previous: MarkdownStreamSnapshot | null,
    source: string,
    options: MarkdownStreamOptions = {},
  ): MarkdownStreamSnapshot => {
    const previousState = previous ? states.get(previous) : undefined;
    const resetReason = !previous
      ? "initial"
      : !source.startsWith(previous.source) || !previousState
        ? "non-append"
        : previousState.hasHtml
          ? "html"
          : null;
    if (resetReason) return whole(previous, source, options, resetReason);
    if (!previous || !previousState) throw new Error("stream snapshot state is unavailable");

    const cutIndex = Math.max(0, previous.blocks.length - 2);
    const cut = previousState.ranges[cutIndex]?.from ?? 0;
    const suffix = source.slice(cut);
    const parsedSuffix = parseDocument(suffix);
    if (containsHtml(parsedSuffix.tree)) return whole(previous, source, options, "html");

    const retainedDefinitions = previousState.definitions.filter(
      (definition) => definition.to <= cut,
    );
    const definitions = firstDefinitions([
      ...retainedDefinitions,
      ...collectDefinitions(parsedSuffix.tree, suffix, cut),
    ]);
    const definitionSource = definitions.map((definition) => definition.source).join("\n");
    const definitionBlockCount = definitionSource
      ? parseDocument(definitionSource).blocks.length
      : 0;
    const activeBlocks = definitionSource
      ? parseDocument(`${definitionSource}\n\n${suffix}`).blocks.slice(definitionBlockCount)
      : parsedSuffix.blocks;
    const retained = previous.blocks.slice(0, cutIndex);
    const retainedRanges = previousState.ranges.slice(0, cutIndex);
    const patched = definitionsChanged(previousState.definitions, definitions)
      ? patchReferenceBlocks(retained, retainedRanges, source, definitionSource)
      : retained;
    const canonical = reuseEqualNodes([...patched, ...activeBlocks], previous.blocks);
    const ranges = [
      ...retainedRanges,
      ...parsedSuffix.ranges.map((range) => ({ from: range.from + cut, to: range.to + cut })),
    ];
    return finish(
      source,
      canonical,
      ranges,
      definitions,
      parsedSuffix.tree,
      suffix,
      cut,
      activeBlocks.length,
      options,
      false,
      null,
    );
  };
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

function collectDefinitions(tree: MdastRoot, source: string, base: number): Definition[] {
  const result: Definition[] = [];
  visitTree(tree, (node) => {
    if (node.type !== "definition" || typeof node.identifier !== "string") return;
    const range = astOffsets(node);
    if (range) {
      result.push({
        identifier: node.identifier,
        source: source.slice(range.from, range.to),
        from: range.from + base,
        to: range.to + base,
      });
    }
  });
  return result;
}

function firstDefinitions(definitions: readonly Definition[]): Definition[] {
  const seen = new Set<string>();
  return definitions.filter((definition) => {
    if (seen.has(definition.identifier)) return false;
    seen.add(definition.identifier);
    return true;
  });
}

function definitionsChanged(a: readonly Definition[], b: readonly Definition[]): boolean {
  return (
    a.length !== b.length ||
    a.some(
      (definition, index) =>
        definition.identifier !== b[index]?.identifier || definition.source !== b[index]?.source,
    )
  );
}

function containsHtml(tree: MdastRoot): boolean {
  let found = false;
  visitTree(tree, (node) => {
    if (node.type === "html") found = true;
  });
  return found;
}

function visitTree(
  root: unknown,
  visit: (node: { type?: string; identifier?: string; children?: unknown[] }) => void,
): void {
  if (!root || typeof root !== "object") return;
  const node = root as { type?: string; identifier?: string; children?: unknown[] };
  visit(node);
  node.children?.forEach((child) => {
    visitTree(child, visit);
  });
}

function trailingTextRange(tree: MdastRoot, sourceLength: number): SourceBlock | null {
  const block = tree.children.at(-1) as unknown;
  if (!block || typeof block !== "object") return null;
  const typed = block as { type?: string; children?: unknown[] };
  if (typed.type !== "paragraph" && typed.type !== "heading") return null;
  let node: unknown = typed;
  while (node && typeof node === "object") {
    const value = node as { type?: string; children?: unknown[] };
    if (value.type === "inlineCode" || value.type === "html" || value.type === "link") return null;
    if (value.type === "text") {
      const range = astOffsets(value);
      return range?.to === sourceLength ? range : null;
    }
    node = value.children?.at(-1);
  }
  return null;
}

function reuseEqualNodes(next: readonly PMNode[], previous: readonly PMNode[]): PMNode[] {
  return next.map((node, index) => {
    const old = previous[index];
    return old && node.eq(old) ? old : node;
  });
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

function openCodeNode(blocks: readonly PMNode[], source: string): PMNode | null {
  const openIndex = markdownSyntax(source).code.findIndex(
    (region) => region.fenced && !region.closed && region.to === source.length,
  );
  return openIndex === -1 ? null : (codeNodes(blocks)[openIndex] ?? null);
}

function repairIsSafe(
  retained: readonly PMNode[],
  canonical: readonly PMNode[],
  candidate: readonly PMNode[],
): boolean {
  if (candidate.length === 0 || retained.length + candidate.length !== canonical.length)
    return false;
  const canonicalActive = canonical.slice(retained.length);
  if (candidate.slice(0, -1).some((node, index) => !canonicalActive[index]?.eq(node))) return false;
  const canonicalCode = codeNodes(canonicalActive).map((node) => JSON.stringify(node.toJSON()));
  const candidateCode = codeNodes(candidate).map((node) => JSON.stringify(node.toJSON()));
  return (
    canonicalCode.length === candidateCode.length &&
    canonicalCode.every((node, index) => node === candidateCode[index])
  );
}
