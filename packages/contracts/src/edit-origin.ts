/** Immutable receipt origin; current disposition is derived from retained text. */
export type EditOrigin =
  | { kind: "pending"; draftId: string; rowId: number }
  | { kind: "live"; seq: number };
