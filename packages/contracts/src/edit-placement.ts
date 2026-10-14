/** Immutable receipt placement shared by host policies and persistence adapters. */
export type EditPlacement =
  | { kind: "pending"; branchId: string; rowId: number }
  | { kind: "live"; seq: number }
  | { kind: "discarded" }
  | { kind: "retired" };
export type EditOrigin = Extract<EditPlacement, { kind: "pending" | "live" }>;
