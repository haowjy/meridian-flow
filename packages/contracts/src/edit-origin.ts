/**
 * Immutable receipt origin; current disposition is derived from retained text. A `pending` part
 * wrote a draft's text: an AI write names its journal row, a writer's Discard or its Undo names
 * none. A `live` part wrote the manuscript; with `draftId` (an Apply, its Undo) the same change
 * went into that draft's review base, and an Undo takes it out of both.
 */
export type EditOrigin =
  | { kind: "pending"; draftId: string; rowId?: number }
  | { kind: "live"; seq: number; draftId?: string };
