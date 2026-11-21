/**
 * Which ambient transactions a draft write may join. `ensureActiveForWrite` locks the
 * Work row and then the draft row, so it may only join a transaction that has locked
 * nothing but Works (global lock order); any other ambient caller is refused rather than
 * joined. The ContextFS command boundary approves its own transaction after its Work
 * locks and before any namespace or document lock.
 */
import {
  getDrizzleTransactionLocal,
  isInDrizzleTransaction,
  setDrizzleTransactionLocal,
} from "./drizzle-transaction.js";

const approvedJoin = { name: "draft-write-join" };

export class DraftWriteJoinRefusedError extends Error {
  constructor() {
    super("A draft write may only join a command transaction that has locked nothing but Works");
    this.name = "DraftWriteJoinRefusedError";
  }
}

/** The command boundary's approval: this transaction has locked only Works so far. */
export function approveDraftWriteJoin(): void {
  if (!setDrizzleTransactionLocal(approvedJoin, true)) {
    throw new Error("approveDraftWriteJoin requires an ambient transaction");
  }
}

/** Joining is allowed: no ambient transaction (open one), or an approved one. */
export function assertDraftWriteJoinAllowed(): void {
  if (isInDrizzleTransaction() && getDrizzleTransactionLocal<boolean>(approvedJoin) !== true) {
    throw new DraftWriteJoinRefusedError();
  }
}
