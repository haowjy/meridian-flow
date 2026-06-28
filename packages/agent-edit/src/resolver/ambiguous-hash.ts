// Shared block-hash ambiguity messages for read and write resolvers.

import type { BlockRef } from "../handles.js";
import type { DocumentModel } from "../ports/model.js";

export function ambiguousHashMessage(
  model: Pick<DocumentModel, "getBlockId">,
  hash: string,
  matches: readonly BlockRef[],
): string {
  const candidateHashes = matches.map((match) => model.getBlockId(match)).join(", ");
  return `Block hash "${hash}" is ambiguous (matches: ${candidateHashes}). Read the block to disambiguate.`;
}
