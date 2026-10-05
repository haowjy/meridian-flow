import type { BlockRef, DocHandle } from "../handles.js";
import type { DocumentModel } from "../ports/model.js";
import { locateBlockByHash } from "./hash-locator.js";
import { headingSlugs, sectionEndIndex, sectionNotFoundMessage } from "./heading-sections.js";

export const AROUND_BLOCK_RADIUS = 3;

const HEX_HASH_RE = /^[0-9a-f]{4,}$/i;

export interface ScopeContext {
  doc: DocHandle;
  model: DocumentModel;
}

export interface ScopeResolveOptions {
  allowSlugFallback?: boolean;
}

export interface BlockScope {
  kind: "document" | "block" | "range" | "section" | "around";
  blocks: BlockRef[];
  startIndex: number;
  endIndex: number;
  heading?: BlockRef;
  headingLevel?: number;
}

export type ScopeResult = { ok: true; scope: BlockScope } | ScopeFailure;

export type ScopeFailure =
  | {
      ok: false;
      code: "not_found" | "invalid_write";
      message: string;
      /** Set when a block number ran past the end, so the reply gives the size, not a re-read. */
      documentBlocks?: number;
    }
  | { ok: false; code: "ambiguous"; message: string; matches: BlockRef[] };

export function resolveSearchScope(
  ctx: ScopeContext,
  input?: unknown,
  around?: string,
  options: ScopeResolveOptions = {},
): ScopeResult {
  if (around !== undefined) return resolveAround(ctx, around);
  if (input !== undefined) return resolveScope(ctx, input, options);
  const blocks = ctx.model.getBlocks(ctx.doc);
  return { ok: true, scope: scopeFromIndexes("document", blocks, 0, blocks.length - 1) };
}

export function resolveScope(
  ctx: ScopeContext,
  input: unknown,
  options: ScopeResolveOptions = {},
): ScopeResult {
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

  if (input.startsWith("#")) return resolveFragment(ctx, input.slice(1), options);
  if (input.includes("..")) return resolveStringRange(ctx, input);
  return resolveSingleHash(ctx, input);
}

export function resolveFragment(
  ctx: ScopeContext,
  fragment: string,
  options: ScopeResolveOptions = {},
): ScopeResult {
  if (fragment.length === 0) return invalid("Empty section fragment");
  const hexShaped = HEX_HASH_RE.test(fragment);
  if (hexShaped) {
    const byHash = resolveHashAsBlockOrSection(ctx, fragment);
    if (byHash.ok) return byHash;
    if (byHash.code === "ambiguous") return byHash;
    if (byHash.code !== "not_found") return byHash;
    if (options.allowSlugFallback === false) return byHash;
    return resolveSlug(ctx, fragment);
  }
  const bySlug = resolveSlug(ctx, fragment);
  if (bySlug.ok) return bySlug;
  const byHash = resolveHashAsBlockOrSection(ctx, fragment);
  // A slug-shaped fragment that matches nothing was meant as a slug.
  return byHash.ok || byHash.code !== "not_found" ? byHash : bySlug;
}

export function isHeading(model: DocumentModel, block: BlockRef): boolean {
  return model.getHeadingLevel(block) !== undefined;
}

export function headingLevel(model: DocumentModel, block: BlockRef): number {
  return model.getHeadingLevel(block) ?? 1;
}

function resolveAround(ctx: ScopeContext, around: string): ScopeResult {
  const hash = around.startsWith("#") ? around.slice(1) : around;
  const located = locateBlockByHash(ctx, hash);
  if (!located.ok) return located;
  return {
    ok: true,
    scope: scopeFromIndexes(
      "around",
      located.blocks,
      Math.max(0, located.index - AROUND_BLOCK_RADIUS),
      Math.min(located.blocks.length - 1, located.index + AROUND_BLOCK_RADIUS),
    ),
  };
}

function resolveSingleHash(ctx: ScopeContext, hash: string): ScopeResult {
  const located = locateBlockByHash(ctx, hash);
  if (!located.ok) return located;
  return {
    ok: true,
    scope: scopeFromIndexes("block", located.blocks, located.index, located.index),
  };
}

function resolveHashAsBlockOrSection(ctx: ScopeContext, hash: string): ScopeResult {
  const located = locateBlockByHash(ctx, hash);
  if (!located.ok) return located;
  if (!isHeading(ctx.model, located.block)) {
    return {
      ok: true,
      scope: scopeFromIndexes("block", located.blocks, located.index, located.index),
    };
  }
  return sectionFromHeading(ctx, located.index);
}

function resolveStringRange(ctx: ScopeContext, input: string): ScopeResult {
  const [startHash, endHash] = input.split("..");
  if (!startHash) return invalid("Range start is required");
  const blocks = ctx.model.getBlocks(ctx.doc);
  const start = locateBlockByHash(ctx, startHash, {
    notFoundMessage: `Range start block "${startHash}" was not found`,
  });
  if (!start.ok) return start;
  const endIndex: BlockIndexResult = endHash
    ? blockIndexForHash(ctx, endHash)
    : { ok: true, index: blocks.length - 1 };
  if (!endIndex.ok) return endIndex.error;
  if (start.index > endIndex.index) return invalid("Range start must not come after range end");
  return { ok: true, scope: scopeFromIndexes("range", blocks, start.index, endIndex.index) };
}

function resolveTupleRange(ctx: ScopeContext, input: unknown[]): ScopeResult {
  if (input.length !== 2) return invalid("Tuple ranges must have exactly two entries");
  const blocks = ctx.model.getBlocks(ctx.doc);
  const startIndex = tupleEndpointIndex(ctx, input[0]);
  const endIndex = tupleEndpointIndex(ctx, input[1]);
  if (!startIndex.ok) return startIndex.error;
  if (!endIndex.ok) return endIndex.error;
  if (startIndex.index > endIndex.index)
    return invalid("Range start must not come after range end");
  return { ok: true, scope: scopeFromIndexes("range", blocks, startIndex.index, endIndex.index) };
}

type BlockIndexResult = { ok: true; index: number } | { ok: false; error: ScopeFailure };

function tupleEndpointIndex(ctx: ScopeContext, value: unknown): BlockIndexResult {
  const blocks = ctx.model.getBlocks(ctx.doc);
  if (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= blocks.length
  ) {
    return { ok: true, index: value - 1 };
  }
  if (typeof value === "string") return blockIndexForHash(ctx, value);
  if (typeof value === "number" && Number.isInteger(value) && value > blocks.length) {
    return {
      ok: false,
      error: {
        ok: false,
        code: "not_found",
        message: `Block ${value} is past the end`,
        documentBlocks: blocks.length,
      },
    };
  }
  return { ok: false, error: notFound("Tuple range endpoint not found") };
}

function blockIndexForHash(ctx: ScopeContext, hash: string): BlockIndexResult {
  const located = locateBlockByHash(ctx, hash, {
    notFoundMessage: `Range end block "${hash}" was not found`,
  });
  return located.ok ? { ok: true, index: located.index } : { ok: false, error: located };
}

function resolveSlug(ctx: ScopeContext, slug: string): ScopeResult {
  const headings = headingSlugEntries(ctx);
  const found = headings.find((entry) => entry.slug === slug);
  if (!found) return notFound(sectionNotFoundMessage(slug));
  return sectionFromHeading(ctx, found.index);
}

function headingSlugEntries(
  ctx: ScopeContext,
): Array<{ slug: string; index: number; block: BlockRef }> {
  const headings: Array<{ index: number; block: BlockRef }> = [];
  ctx.model.getBlocks(ctx.doc).forEach((block, index) => {
    if (isHeading(ctx.model, block)) headings.push({ index, block });
  });
  const slugs = headingSlugs(headings.map(({ block }) => ctx.model.getText(block)));
  return headings.map((heading, position) => ({ ...heading, slug: slugs[position] as string }));
}

/**
 * The `#fragment` that reads each heading's section: its slug, or its hash when
 * the slug is hex-shaped, since `resolveFragment` tries such fragments as hashes first.
 */
export function headingSectionFragments(ctx: ScopeContext): Map<BlockRef, string | undefined> {
  return new Map(
    headingSlugEntries(ctx).map(({ slug, block }) => [
      block,
      HEX_HASH_RE.test(slug) ? undefined : slug,
    ]),
  );
}

function sectionFromHeading(ctx: ScopeContext, headingIndex: number): ScopeResult {
  const blocks = ctx.model.getBlocks(ctx.doc);
  const heading = blocks[headingIndex];
  const endIndex = sectionEndIndex(blocks.length, headingIndex, (index) =>
    ctx.model.getHeadingLevel(blocks[index] as BlockRef),
  );
  return {
    ok: true,
    scope: {
      ...scopeFromIndexes("section", blocks, headingIndex, endIndex),
      heading,
      headingLevel: headingLevel(ctx.model, heading),
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

function notFound(message: string): ScopeFailure {
  return { ok: false, code: "not_found", message };
}

function invalid(message: string): ScopeFailure {
  return { ok: false, code: "invalid_write", message };
}
