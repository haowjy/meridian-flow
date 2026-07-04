/** Shared block-content equivalence policy for draft conflict checks. */

import type { AgentEditModel } from "@meridian/agent-edit";
import { toDocHandle } from "@meridian/agent-edit";
import type * as Y from "yjs";

export type BlockContentShape = {
  type: string;
  text: string;
};

export function blockContentShapes(doc: Y.Doc, model: AgentEditModel): BlockContentShape[] {
  return model.getBlocks(toDocHandle(doc)).map((block) => ({
    type: model.getBlockType(block),
    text: model.getText(block),
  }));
}

export function blockContentShapesEqual(
  left: readonly BlockContentShape[],
  right: readonly BlockContentShape[],
): boolean {
  return (
    left.length === right.length &&
    left.every((block, index) => {
      const other = right[index];
      return other !== undefined && block.type === other.type && block.text === other.text;
    })
  );
}

export function liveMatchesBaseContent(input: {
  baseDoc: Y.Doc;
  liveDoc: Y.Doc;
  model: AgentEditModel;
}): boolean {
  return blockContentShapesEqual(
    blockContentShapes(input.baseDoc, input.model),
    blockContentShapes(input.liveDoc, input.model),
  );
}

export function sameBlockContent(left: BlockContentShape, right: BlockContentShape): boolean {
  return left.type === right.type && left.text === right.text;
}
