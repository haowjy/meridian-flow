/**
 * The one traversal of stored link occurrences: link runs, `image` and `figure`.
 *
 * The client binder and agent-edit's ref assignment walk ProseMirror through
 * here, and `parseWithSpans` aligns its source spans to this exact order.
 * Agent-edit's `extractStoredLinks` walks live Yjs the same way; a parity row
 * in its `assign-refs.test.ts` pins the two.
 */
import { storedLinkRef } from "@meridian/contracts";
import type { Mark, Node as PMNode } from "prosemirror-model";

import { parseImageHtmlAst } from "./markdown/blocks/image-html.js";
import type { DocumentLinkScope, OccurrenceSpan } from "./types.js";

/** Where an occurrence sits, for rebuilding nodes; opaque to everyone but the rebuilder. */
export interface OccurrencePath {
  /** Index of the top-level block. */
  readonly block: number;
  /** Child indexes from that block down to the occurrence's first node. */
  readonly path: readonly number[];
  /** Sibling nodes the occurrence covers: a link run's text nodes, else 1. */
  readonly count: number;
}

export interface LinkOccurrence {
  kind: "link" | "image" | "figure";
  /** Link: label text of the maximal run sharing one link mark. Image/figure: alt. */
  label: string;
  /** The stored attrs; an image or figure `src` is mapped to `href`. */
  attrs: { ref: string | null; href: string; title: string | null };
  at: OccurrencePath;
}

/** Document order; table cells row-major; one entry per maximal same-mark run. */
export function walkLinkOccurrences(blocks: readonly PMNode[]): LinkOccurrence[] {
  const out: LinkOccurrence[] = [];
  blocks.forEach((block, index) => {
    walkNode(block, index, [], out);
  });
  return out;
}

function walkNode(node: PMNode, block: number, path: number[], out: LinkOccurrence[]): void {
  if (node.type.name === "figure") {
    out.push(sourceOccurrence("figure", node, { block, path, count: 1 }));
    return;
  }
  if (node.inlineContent) {
    walkInline(node, block, path, out);
    return;
  }
  node.forEach((child, _offset, index) => {
    walkNode(child, block, [...path, index], out);
  });
}

function walkInline(parent: PMNode, block: number, path: number[], out: LinkOccurrence[]): void {
  let run: { mark: Mark; start: number; count: number; label: string } | null = null;
  const close = () => {
    if (!run) return;
    const { href, title, ref } = run.mark.attrs;
    out.push({
      kind: "link",
      label: run.label,
      attrs: { ref: storedLinkRef(ref), href: String(href ?? ""), title: stringOrNull(title) },
      at: { block, path: [...path, run.start], count: run.count },
    });
    run = null;
  };
  parent.forEach((child, _offset, index) => {
    const link = child.isText ? child.marks.find((mark) => mark.type.name === "link") : undefined;
    if (run && link && run.mark.eq(link)) {
      run.count += 1;
      run.label += child.text ?? "";
      return;
    }
    close();
    if (link) run = { mark: link, start: index, count: 1, label: child.text ?? "" };
    else if (child.type.name === "image")
      out.push(sourceOccurrence("image", child, { block, path: [...path, index], count: 1 }));
  });
  close();
}

function sourceOccurrence(
  kind: "image" | "figure",
  node: PMNode,
  at: OccurrencePath,
): LinkOccurrence {
  return {
    kind,
    label: String(node.attrs.alt ?? ""),
    attrs: {
      ref: storedLinkRef(node.attrs.ref),
      href: String(node.attrs.src ?? ""),
      title: kind === "image" ? stringOrNull(node.attrs.title) : null,
    },
    at,
  };
}

function stringOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

/** What a reader of these blocks was shown for one ref: its canonical address. */
export interface SpelledLinkFact {
  ref: string;
  address: string;
}

/** Spell every ref-bearing occurrence of these blocks with this scope. Pure. */
export function spelledLinks(
  blocks: readonly PMNode[],
  links: DocumentLinkScope,
): SpelledLinkFact[] {
  const facts: SpelledLinkFact[] = [];
  for (const { kind, attrs } of walkLinkOccurrences(blocks)) {
    if (attrs.ref === null) continue;
    const { address } =
      kind === "link"
        ? links.spellLink({ href: attrs.href, ref: attrs.ref })
        : links.spellSource({ src: attrs.href, ref: attrs.ref });
    if (address !== null) facts.push({ ref: attrs.ref, address });
  }
  return facts;
}

type AstRecord = {
  type?: unknown;
  name?: unknown;
  url?: unknown;
  title?: unknown;
  value?: unknown;
  children?: unknown;
  position?: { start?: { offset?: unknown }; end?: { offset?: unknown } };
};
type SourceOccurrence = {
  kind: LinkOccurrence["kind"];
  span: OccurrenceSpan;
  link?: { url: unknown; title: unknown };
};

/**
 * Spans for the occurrences of one parsed top-level block, in walk order.
 *
 * `source` is the text the AST positions index, or null when the ingress
 * preprocessor rewrote the caller's text (positions would point elsewhere):
 * then every occurrence spans the whole text. When the block's link, image
 * and figure nodes do not line up one-to-one with its occurrences (a raw-HTML
 * table holds its anchors as text; a link wrapping an image), every occurrence
 * takes the block's span instead. A span therefore always encloses its
 * occurrence, which is all truncation and splice restoration rely on.
 */
export function blockOccurrenceSpans(
  block: PMNode,
  ast: unknown,
  source: string | null,
  textLength: number,
): OccurrenceSpan[] {
  const occurrences = walkLinkOccurrences([block]);
  if (occurrences.length === 0) return [];
  const blockSpan = source === null ? null : spanOf(ast as AstRecord);
  if (!blockSpan) return occurrences.map(() => ({ start: 0, end: textLength }));
  const sources = mergeAdjacentLinks(collectSources(ast as AstRecord, []), source ?? "");
  const aligned =
    sources.length === occurrences.length &&
    sources.every((entry, index) => entry.kind === occurrences[index]?.kind);
  return aligned ? sources.map((entry) => entry.span) : occurrences.map(() => ({ ...blockSpan }));
}

function collectSources(node: AstRecord, out: SourceOccurrence[]): SourceOccurrence[] {
  const span = spanOf(node);
  if (node.type === "link") {
    // A link with no text becomes no run (an image inside one carries no link mark).
    if (span && hasText(node))
      out.push({ kind: "link", span, link: { url: node.url, title: node.title } });
  } else if (node.type === "image" || parseImageHtmlAst(node)) {
    if (span) out.push({ kind: "image", span });
    return out;
  } else if (node.type === "mdxJsxFlowElement" && node.name === "Figure") {
    if (span) out.push({ kind: "figure", span });
    return out;
  }
  if (Array.isArray(node.children))
    for (const child of node.children as AstRecord[]) collectSources(child, out);
  return out;
}

function hasText(node: AstRecord): boolean {
  if ((node.type === "text" || node.type === "inlineCode") && typeof node.value === "string")
    return node.value.length > 0;
  return Array.isArray(node.children) && (node.children as AstRecord[]).some(hasText);
}

/**
 * Adjacent links with one destination are one run in ProseMirror: the parse
 * gives their text the same mark. Only emphasis delimiters may sit between
 * them, since anything else becomes unlinked text that ends the run.
 */
function mergeAdjacentLinks(sources: SourceOccurrence[], source: string): SourceOccurrence[] {
  const merged: SourceOccurrence[] = [];
  for (const entry of sources) {
    const previous = merged[merged.length - 1];
    if (
      previous?.link &&
      entry.link &&
      previous.link.url === entry.link.url &&
      (previous.link.title ?? null) === (entry.link.title ?? null) &&
      /^[*_~]*$/.test(source.slice(previous.span.end, entry.span.start))
    ) {
      previous.span = { start: previous.span.start, end: entry.span.end };
      continue;
    }
    merged.push({ ...entry });
  }
  return merged;
}

function spanOf(node: AstRecord): OccurrenceSpan | null {
  const start = node.position?.start?.offset;
  const end = node.position?.end?.offset;
  return typeof start === "number" && typeof end === "number" ? { start, end } : null;
}
