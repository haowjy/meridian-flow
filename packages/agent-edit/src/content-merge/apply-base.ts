import type { Node as PMNode, Schema } from "prosemirror-model";
import { blocksEqual } from "../diff/equal.js";
import { contentMerge } from "./merge.js";

/**
 * The shared server write and optimistic fold of a frozen Apply click (O → P): the patched blocks
 * when nothing changed under the writer, otherwise the content merge of the patch into what is there.
 */
export function applyBase(
  schema: Schema,
  committed: readonly PMNode[],
  optimistic: readonly PMNode[],
  patched: readonly PMNode[],
): readonly PMNode[] {
  return blocksEqual(optimistic, committed)
    ? patched
    : contentMerge(schema, optimistic, committed, patched).blocks;
}
