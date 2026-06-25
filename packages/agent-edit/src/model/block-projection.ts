// Projects a Yjs document into aligned block, hash, and ProseMirror arrays.
import type * as Y from "yjs";

import type { Block } from "../codec/types.js";
import type { AgentEditModel } from "../ports/model.js";

export interface ProjectedBlock {
  block: Y.XmlElement;
  index: number;
  hash: string;
  pmBlock: Block;
}

export interface DocumentBlockProjection {
  blocks: readonly Y.XmlElement[];
  hashes: readonly string[];
  pmBlocks: readonly Block[];
  indexByBlock: ReadonlyMap<Y.XmlElement, number>;
  select(blocks: readonly Y.XmlElement[]): ProjectedBlock[];
}

export function projectDocumentBlocks(doc: Y.Doc, model: AgentEditModel): DocumentBlockProjection {
  const blocks = model.getBlocks(doc);
  const hashes = blocks.length === 0 ? [] : model.getDocumentBlockIds(doc);
  const pmBlocks = blocks.length === 0 ? [] : model.toProsemirrorBlocks(doc);
  const indexByBlock = new Map<Y.XmlElement, number>();
  for (let index = 0; index < blocks.length; index += 1) {
    indexByBlock.set(blocks[index], index);
  }

  return {
    blocks,
    hashes,
    pmBlocks,
    indexByBlock,
    select(selectedBlocks: readonly Y.XmlElement[]): ProjectedBlock[] {
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
