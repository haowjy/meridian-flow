// Resolves agent-visible block hashes to document positions with structured ambiguity.

import type { DocumentModel, LoroBlock } from "../model/loro-model.js";
import type { ProjectedBlock } from "../model/types.js";

/**
 * The one projection the resolver indexes into. Projecting repairs the document (an element
 * the schema can't build is deleted), so resolver code holds only this list, never the raw
 * document: no block index can come from before the repair.
 */
export interface HashLocateContext {
  model: DocumentModel;
  projected: readonly ProjectedBlock[];
  /** `projected`'s refs, in order. */
  blocks: readonly LoroBlock[];
}

export function hashLocateContext(
  model: DocumentModel,
  projected: readonly ProjectedBlock[],
): HashLocateContext {
  return { model, projected, blocks: projected.map((block) => block.ref) };
}

export type HashLocationFailure =
  | { ok: false; code: "not_found"; message: string }
  | { ok: false; code: "ambiguous"; message: string; matches: LoroBlock[] };

export type HashLocationResult =
  | { ok: true; block: LoroBlock; index: number; blocks: readonly LoroBlock[] }
  | HashLocationFailure;

export function locateBlockByHash(
  ctx: HashLocateContext,
  hash: string,
  options: { notFoundMessage?: string } = {},
): HashLocationResult {
  // Display hashes are flexible prefixes; resolve held old widths against immutable full hashes.
  const normalized = hash.trim().toLowerCase();
  const matches =
    normalized.length === 0
      ? []
      : ctx.projected.filter((block) => block.fullHash.startsWith(normalized));
  if (matches.length > 1) {
    const refs = matches.map((match) => match.ref);
    return {
      ok: false,
      code: "ambiguous",
      message: ambiguousHashMessage(ctx.model, hash, refs),
      matches: refs,
    };
  }
  const [match] = matches;
  if (!match) {
    return {
      ok: false,
      code: "not_found",
      message: options.notFoundMessage ?? hashNotFoundMessage(hash),
    };
  }
  return { ok: true, block: match.ref, index: ctx.projected.indexOf(match), blocks: ctx.blocks };
}

function ambiguousHashMessage(
  model: Pick<DocumentModel, "getBlockId">,
  hash: string,
  matches: readonly LoroBlock[],
): string {
  const candidateHashes = matches.map((match) => model.getBlockId(match)).join(", ");
  return `Block hash "${hash}" is ambiguous (matches: ${candidateHashes}).`;
}

/**
 * An explicit `version: "live"` read can name a block absent from the diverged
 * draft the write changes. Seeded drafts retain their live block addresses.
 */
function hashNotFoundMessage(hash: string): string {
  return `Block hash "${hash}" was not found in the version your writes change. Hashes from \`version: "live"\` can't target it.`;
}
