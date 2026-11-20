/**
 * Immutable receipt origin; current disposition is derived from retained text. A part names the
 * text it wrote. `pending`: a draft's text (an AI write names its journal row; a writer's Discard
 * or its Undo names none). `base`: a draft's review base (an Apply, or its Undo). `live`: the
 * manuscript.
 */
export type EditOrigin =
  | { kind: "pending"; draftId: string; rowId?: number }
  | { kind: "base"; draftId: string }
  | { kind: "live"; seq: number };
