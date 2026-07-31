/**
 * Block movement: one verb with four doors (§5.8).
 *
 * The host mounts `BlockMovementSurface` through the chrome surface list and
 * needs nothing else — the handle, the drag, the menu, and Alt+↑/↓ all
 * register themselves with the kernel from inside it. The document half is
 * exported for the surfaces that will move blocks by other means.
 */

export {
  BLOCK_MOVEMENT_SURFACE_ID,
  BlockMovementSurface,
} from "./BlockMovementSurface";
export {
  type BlockMoveDirection,
  type BlockTarget,
  blockAt,
  blockAtIndex,
  blockForSelection,
  blockSeams,
  deleteBlockTransaction,
  duplicateBlockTransaction,
  moveBlockStepTransaction,
  moveBlockToSeamTransaction,
} from "./block-targets";
