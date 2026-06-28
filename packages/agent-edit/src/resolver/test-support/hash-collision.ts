// Shared fixtures for hash-prefix collision regressions.

import type { BlockRef } from "../../handles.js";
import { fullHashForItemId, getBlockItemId } from "../../model/block-hash.js";
import type { DocumentModel } from "../../ports/model.js";

export interface HashCollisionCandidate {
  block: BlockRef;
  displayHash: string;
  fullHash: string;
}

export interface HashCollisionFixture {
  sharedPrefix: string;
  candidates: HashCollisionCandidate[];
  target: HashCollisionCandidate;
}

export function collisionMarkdown(count = 800): string {
  return Array.from({ length: count }, (_, index) => `Collision block ${index + 1}`).join("\n\n");
}

export function prefixCollisionFixture(
  model: Pick<DocumentModel, "getBlockId">,
  blocks: readonly BlockRef[],
  prefixLength = 4,
): HashCollisionFixture {
  const candidates = blocks.map((block) => ({
    block,
    displayHash: model.getBlockId(block),
    fullHash: fullHashForItemId(getBlockItemId(block)),
  }));
  const groups = new Map<string, HashCollisionCandidate[]>();
  for (const candidate of candidates) {
    const prefix = candidate.fullHash.slice(0, prefixLength);
    groups.set(prefix, [...(groups.get(prefix) ?? []), candidate]);
  }

  for (const [sharedPrefix, matches] of groups) {
    const displayHashes = new Set(matches.map((match) => match.displayHash));
    if (
      matches.length > 1 &&
      displayHashes.size === matches.length &&
      matches.every(
        (match) =>
          match.displayHash.startsWith(sharedPrefix) &&
          match.displayHash.length > sharedPrefix.length,
      )
    ) {
      return { sharedPrefix, candidates: matches, target: matches[0] };
    }
  }

  throw new Error(
    `Expected at least two blocks with a shared ${prefixLength}-character prefix and unique display hashes`,
  );
}
