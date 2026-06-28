// Resolves agent-visible block hashes to document positions with structured ambiguity.

import type { BlockRef, DocHandle } from "../handles.js";
import type { DocumentModel } from "../ports/model.js";

export interface HashLocateContext {
  doc: DocHandle;
  model: DocumentModel;
}

export type HashLocationFailure =
  | { ok: false; code: "not_found"; message: string }
  | { ok: false; code: "ambiguous"; message: string; matches: BlockRef[] };

export type HashLocationResult =
  | { ok: true; block: BlockRef; index: number; blocks: BlockRef[] }
  | HashLocationFailure;

export function locateBlockByHash(
  ctx: HashLocateContext,
  hash: string,
  options: { notFoundMessage?: string } = {},
): HashLocationResult {
  const lookup = ctx.model.lookupBlock(ctx.doc, hash);
  if (!lookup.ok) {
    if (lookup.reason === "ambiguous") {
      return {
        ok: false,
        code: "ambiguous",
        message: ambiguousHashMessage(ctx.model, hash, lookup.matches),
        matches: lookup.matches,
      };
    }
    return {
      ok: false,
      code: "not_found",
      message: options.notFoundMessage ?? `Block hash "${hash}" was not found`,
    };
  }

  const blocks = ctx.model.getBlocks(ctx.doc);
  const index = blocks.indexOf(lookup.block);
  if (index < 0) {
    return {
      ok: false,
      code: "not_found",
      message: options.notFoundMessage ?? `Block hash "${hash}" was not found`,
    };
  }
  return { ok: true, block: lookup.block, index, blocks };
}

function ambiguousHashMessage(
  model: Pick<DocumentModel, "getBlockId">,
  hash: string,
  matches: readonly BlockRef[],
): string {
  const candidateHashes = matches.map((match) => model.getBlockId(match)).join(", ");
  return `Block hash "${hash}" is ambiguous (matches: ${candidateHashes}). Read the block to disambiguate.`;
}
