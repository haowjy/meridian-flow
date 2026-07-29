/**
 * The document half of block movement: what a pointer gesture is holding.
 *
 * The surface that does the holding lives in
 * `features/editor/surfaces/blocks/`. This is only what the document itself
 * has to know — a lifted block renders differently, and a held position has to
 * survive edits landing under the pointer.
 */

export {
  BLOCK_LIFTED_CLASS,
  BlockDragExtension,
  beginBlockDrag,
  draggedBlockPos,
  endBlockDrag,
  liftBlockDrag,
} from "./BlockDragExtension";
