/** Persistence port for the server-derived receipt chip on a transcript turn. */
import type { TurnReceiptChip } from "@meridian/contracts/protocol";
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";

export type TurnReceiptStateStore = {
  getDocumentAndTreeChip(threadId: ThreadId, turnId: TurnId): Promise<TurnReceiptChip | null>;
};
