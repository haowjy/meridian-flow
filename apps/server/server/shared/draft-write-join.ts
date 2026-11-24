// keep: a draft write may only join a transaction that has locked nothing but Works; any other ambient caller is refused rather than joined
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

export function approveDraftWriteJoin(): void {
  if (!setDrizzleTransactionLocal(approvedJoin, true)) {
    throw new Error("approveDraftWriteJoin requires an ambient transaction");
  }
}

export function assertDraftWriteJoinAllowed(): void {
  if (isInDrizzleTransaction() && getDrizzleTransactionLocal<boolean>(approvedJoin) !== true) {
    throw new DraftWriteJoinRefusedError();
  }
}
