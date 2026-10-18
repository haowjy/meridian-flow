/** Server-derived receipt-chip state for a transcript turn. */
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";

export type TurnReceiptState =
  | "live-active"
  | "live-reversed"
  | "branch-active"
  | "branch-reversed"
  | "work-active"
  | "work-reversed"
  | "rollback-pending"
  | "cant_undo_dependent"
  | "expired";

export type TurnReceiptControl = "undo" | "redo" | "view_change";

export type TurnReceiptChip = {
  skips?: import("@meridian/contracts/protocol").TurnInverseSkip[];
  state: TurnReceiptState;
  control: TurnReceiptControl;
};

export type TurnReceiptStateStore = {
  getTurnReceiptChip(threadId: ThreadId, turnId: TurnId): Promise<TurnReceiptChip | null>;
};
