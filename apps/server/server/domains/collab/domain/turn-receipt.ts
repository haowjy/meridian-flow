/** Server-derived receipt-chip state for a transcript turn. */
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";

export type TurnReceiptState =
  | "live-active"
  | "live-reversed"
  | "branch-active"
  | "branch-reversed"
  | "rollback-pending"
  | "cant_undo_dependent"
  | "expired";

export type TurnReceiptControl = "undo" | "redo" | "view_change";

export type TurnReceiptChip = {
  state: TurnReceiptState;
  control: TurnReceiptControl;
};

export type TurnReceiptStateStore = {
  getTurnReceiptChip(threadId: ThreadId, turnId: TurnId): Promise<TurnReceiptChip | null>;
};

export function controlForTurnReceiptState(state: TurnReceiptState): TurnReceiptControl {
  if (state === "live-reversed" || state === "branch-reversed") return "redo";
  if (state === "live-active" || state === "branch-active") return "undo";
  return "view_change";
}
