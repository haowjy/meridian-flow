// Projects a document into aligned block, hash, and codec-block arrays.

import type { BlockRef } from "../block-ref.js";
import type { Block } from "../codec-types.js";
import type { DocHandle } from "../doc-handle.js";
import type { AgentEditModel } from "../ports/model.js";

export interface ProjectedBlock {
  block: BlockRef;
  index: number;
  hash: string;
  pmBlock: Block;
}

export interface DocumentBlockProjection {
  blocks: readonly BlockRef[];
  hashes: readonly string[];
  pmBlocks: readonly Block[];
  indexByBlock: ReadonlyMap<BlockRef, number>;
  select(blocks: readonly BlockRef[]): ProjectedBlock[];
}

export function projectDocumentBlocks(
  doc: DocHandle,
  model: AgentEditModel,
): DocumentBlockProjection {
  const blocks = model.getBlocks(doc);
  const hashes = blocks.length === 0 ? [] : model.getDocumentBlockIds(doc);
  const pmBlocks = blocks.length === 0 ? [] : model.projectBlocks(doc);
  const indexByBlock = new Map<BlockRef, number>();
  for (let index = 0; index < blocks.length; index += 1) {
    indexByBlock.set(blocks[index], index);
  }

  return {
    blocks,
    hashes,
    pmBlocks,
    indexByBlock,
    select(selectedBlocks: readonly BlockRef[]): ProjectedBlock[] {
      const selected: ProjectedBlock[] = [];
      for (const block of selectedBlocks) {
        const index = indexByBlock.get(block);
        if (index === undefined) continue;
        selected.push({
          block,
          index,
          hash: hashes[index],
          pmBlock: pmBlocks[index],
        });
      }
      return selected;
    },
  };
}
