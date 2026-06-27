import type { BlockRef } from "../block-ref.js";
import type { DocHandle } from "../doc-handle.js";
import type { DocumentModel } from "../ports/model.js";

export const AROUND_BLOCK_RADIUS = 3;

const HEX_HASH_RE = /^[0-9a-f]{4,}$/i;

export interface ScopeContext {
  doc: DocHandle;
  model: DocumentModel;
}

export interface BlockScope {
  kind: "document" | "block" | "range" | "section" | "around";
  blocks: BlockRef[];
  startIndex: number;
  endIndex: number;
  heading?: BlockRef;
  headingLevel?: number;
}

export type ScopeResult =
  | { ok: true; scope: BlockScope }
  | { ok: false; code: "not_found" | "invalid_write"; message: string };

export function resolveSearchScope(
  ctx: ScopeContext,
  input?: unknown,
  around?: string,
): ScopeResult {
  if (input !== undefined && around !== undefined) {
    return invalid("`in` and `around` are mutually exclusive scope parameters");
  }
  if (around !== undefined) return resolveAround(ctx, around);
  if (input !== undefined) return resolveScope(ctx, input);
  const blocks = ctx.model.getBlocks(ctx.doc);
  return { ok: true, scope: scopeFromIndexes("document", blocks, 0, blocks.length - 1) };
}

export function resolveScope(ctx: ScopeContext, input: unknown): ScopeResult {
  const blocks = ctx.model.getBlocks(ctx.doc);
  if (blocks.length === 0) return notFound("Document has no blocks");

  if (typeof input === "number") {
    if (!Number.isInteger(input) || input < 1 || input > blocks.length) {
      return notFound(`Block position ${input} was not found`);
    }
    return { ok: true, scope: scopeFromIndexes("block", blocks, input - 1, input - 1) };
  }

  if (Array.isArray(input)) return resolveTupleRange(ctx, input);
  if (typeof input !== "string" || input.length === 0) {
    return invalid("`in` must be a block hash, range, section, or accepted positional target");
  }

  if (input.startsWith("#")) return resolveFragment(ctx, input.slice(1));
  if (input.includes("..")) return resolveStringRange(ctx, input);
  return resolveSingleHash(ctx, input);
}

export function resolveFragment(ctx: ScopeContext, fragment: string): ScopeResult {
  if (fragment.length === 0) return invalid("Empty section fragment");
  const hexShaped = HEX_HASH_RE.test(fragment);
  if (hexShaped) {
    const byHash = resolveHashAsBlockOrSection(ctx, fragment);
    if (byHash.ok || byHash.code !== "not_found") return byHash;
    return resolveSlug(ctx, fragment);
  }
  const bySlug = resolveSlug(ctx, fragment);
  if (bySlug.ok) return bySlug;
  return resolveHashAsBlockOrSection(ctx, fragment);
}

export function isHeading(model: DocumentModel, block: BlockRef): boolean {
  return model.getHeadingLevel(block) !== undefined;
}

export function headingLevel(model: DocumentModel, block: BlockRef): number {
  return model.getHeadingLevel(block) ?? 1;
}

export function slugForHeadingText(text: string): string {
  return (
    text
      .normalize("NFKD")
      .toLowerCase()
      .trim()
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
      .replace(/^-+|-+$/g, "") || "section"
  );
}

function resolveAround(ctx: ScopeContext, around: string): ScopeResult {
  const hash = around.startsWith("#") ? around.slice(1) : around;
  const lookup = ctx.model.lookupBlock(ctx.doc, hash);
  if (!lookup.ok) return notFound(`Block hash "${hash}" was not found`);
  const blocks = ctx.model.getBlocks(ctx.doc);
  const index = blocks.indexOf(lookup.block);
  if (index < 0) return notFound(`Block hash "${hash}" was not found`);
  return {
    ok: true,
    scope: scopeFromIndexes(
      "around",
      blocks,
      Math.max(0, index - AROUND_BLOCK_RADIUS),
      Math.min(blocks.length - 1, index + AROUND_BLOCK_RADIUS),
    ),
  };
}

function resolveSingleHash(ctx: ScopeContext, hash: string): ScopeResult {
  const lookup = ctx.model.lookupBlock(ctx.doc, hash);
  if (!lookup.ok) return notFound(`Block hash "${hash}" was not found`);
  const blocks = ctx.model.getBlocks(ctx.doc);
  const index = blocks.indexOf(lookup.block);
  return { ok: true, scope: scopeFromIndexes("block", blocks, index, index) };
}

function resolveHashAsBlockOrSection(ctx: ScopeContext, hash: string): ScopeResult {
  const lookup = ctx.model.lookupBlock(ctx.doc, hash);
  if (!lookup.ok) return notFound(`Block hash "${hash}" was not found`);
  const blocks = ctx.model.getBlocks(ctx.doc);
  const index = blocks.indexOf(lookup.block);
  if (index < 0) return notFound(`Block hash "${hash}" was not found`);
  if (!isHeading(ctx.model, lookup.block)) {
    return { ok: true, scope: scopeFromIndexes("block", blocks, index, index) };
  }
  return sectionFromHeading(ctx, index);
}

function resolveStringRange(ctx: ScopeContext, input: string): ScopeResult {
  const [startHash, endHash] = input.split("..");
  if (!startHash) return invalid("Range start is required");
  const blocks = ctx.model.getBlocks(ctx.doc);
  const start = ctx.model.lookupBlock(ctx.doc, startHash);
  if (!start.ok) return notFound(`Range start block "${startHash}" was not found`);
  const startIndex = blocks.indexOf(start.block);
  const endIndex = endHash ? blockIndexForHash(ctx, endHash) : blocks.length - 1;
  if (endIndex === null) return notFound(`Range end block "${endHash}" was not found`);
  if (startIndex > endIndex) return invalid("Range start must not come after range end");
  return { ok: true, scope: scopeFromIndexes("range", blocks, startIndex, endIndex) };
}

function resolveTupleRange(ctx: ScopeContext, input: unknown[]): ScopeResult {
  if (input.length !== 2) return invalid("Tuple ranges must have exactly two entries");
  const blocks = ctx.model.getBlocks(ctx.doc);
  const startIndex = tupleEndpointIndex(ctx, input[0]);
  const endIndex = tupleEndpointIndex(ctx, input[1]);
  if (startIndex === null || endIndex === null) return notFound("Tuple range endpoint not found");
  if (startIndex > endIndex) return invalid("Range start must not come after range end");
  return { ok: true, scope: scopeFromIndexes("range", blocks, startIndex, endIndex) };
}

function tupleEndpointIndex(ctx: ScopeContext, value: unknown): number | null {
  const blocks = ctx.model.getBlocks(ctx.doc);
  if (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= blocks.length
  ) {
    return value - 1;
  }
  if (typeof value === "string") return blockIndexForHash(ctx, value);
  return null;
}

function blockIndexForHash(ctx: ScopeContext, hash: string): number | null {
  const lookup = ctx.model.lookupBlock(ctx.doc, hash);
  if (!lookup.ok) return null;
  const index = ctx.model.getBlocks(ctx.doc).indexOf(lookup.block);
  return index < 0 ? null : index;
}

function resolveSlug(ctx: ScopeContext, slug: string): ScopeResult {
  const headings = headingSlugEntries(ctx);
  const found = headings.find((entry) => entry.slug === slug);
  if (!found) return notFound(`Section "#${slug}" was not found`);
  return sectionFromHeading(ctx, found.index);
}

function headingSlugEntries(ctx: ScopeContext): Array<{ slug: string; index: number }> {
  const counts = new Map<string, number>();
  const out: Array<{ slug: string; index: number }> = [];
  ctx.model.getBlocks(ctx.doc).forEach((block, index) => {
    if (!isHeading(ctx.model, block)) return;
    const base = slugForHeadingText(ctx.model.getText(block));
    const seen = counts.get(base) ?? 0;
    counts.set(base, seen + 1);
    out.push({ slug: seen === 0 ? base : `${base}-${seen}`, index });
  });
  return out;
}

function sectionFromHeading(ctx: ScopeContext, headingIndex: number): ScopeResult {
  const blocks = ctx.model.getBlocks(ctx.doc);
  const heading = blocks[headingIndex];
  const level = headingLevel(ctx.model, heading);
  let endIndex = blocks.length - 1;
  for (let index = headingIndex + 1; index < blocks.length; index += 1) {
    if (isHeading(ctx.model, blocks[index]) && headingLevel(ctx.model, blocks[index]) <= level) {
      endIndex = index - 1;
      break;
    }
  }
  return {
    ok: true,
    scope: {
      ...scopeFromIndexes("section", blocks, headingIndex, endIndex),
      heading,
      headingLevel: level,
    },
  };
}

function scopeFromIndexes(
  kind: BlockScope["kind"],
  allBlocks: readonly BlockRef[],
  startIndex: number,
  endIndex: number,
): BlockScope {
  if (allBlocks.length === 0) {
    return { kind, blocks: [], startIndex: 0, endIndex: -1 };
  }
  return {
    kind,
    blocks: allBlocks.slice(startIndex, endIndex + 1),
    startIndex,
    endIndex,
  };
}

function notFound(message: string): ScopeResult {
  return { ok: false, code: "not_found", message };
}

function invalid(message: string): ScopeResult {
  return { ok: false, code: "invalid_write", message };
}
