import type { DraftId } from "./ids.js";

/**
 * Immutable receipt origin: the room the write merged into, Live or a draft's fork of the
 * document. A part's update is its own `update`, the batch it committed. The model's undo and
 * revert of a part run in its room.
 */
export type EditOrigin = { kind: "live" } | { kind: "fork"; draftId: DraftId };
