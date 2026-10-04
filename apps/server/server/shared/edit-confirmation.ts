/**
 * The edit grants one write call carries, confirmed inside each write seam's
 * own transaction (file-access §5). The caller binds them to the call's async
 * scope; a seam (journal append and reversal, branch commit and push, the
 * namespace transaction) locks their Works with its own in id order, then
 * confirms them before taking any advisory lock.
 *
 * A seam reached with no scope is one of the writers §5.1 names (a replay of
 * an already confirmed write, a derived write, a lifecycle-owned write) or an
 * entry point that has no grant yet; it keeps its own locked lifecycle check.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import {
  getDrizzleTransactionLocal,
  isInDrizzleTransaction,
  setDrizzleTransactionLocal,
} from "./drizzle-transaction.js";

export interface EditConfirmation {
  /** Named Works the grants lock, so a seam sorts them with its own Work locks. */
  readonly workIds: readonly string[];
  /** Locks and re-checks the grants in the ambient transaction; throws on a refusal. */
  confirm(): Promise<void>;
}

const scope = new AsyncLocalStorage<EditConfirmation>();

/** Runs a write with its grants bound, for every seam it reaches to confirm. */
export function runWithEditConfirmation<T>(
  confirmation: EditConfirmation,
  operation: () => Promise<T>,
): Promise<T> {
  return scope.run(confirmation, operation);
}

/** The Works the bound grants lock; a seam adds them to its own sorted Work locks. */
export function scopedEditWorkIds(): readonly string[] {
  return scope.getStore()?.workIds ?? [];
}

/**
 * Confirms the bound grants once per transaction. Call it after the seam's
 * Work-row locks and before its advisory locks.
 */
export async function confirmScopedEdits(): Promise<void> {
  const confirmation = scope.getStore();
  if (!confirmation) return;
  if (!isInDrizzleTransaction()) {
    throw new Error("Edit grants are confirmed inside the write's own transaction");
  }
  if (getDrizzleTransactionLocal<boolean>(confirmation)) return;
  await confirmation.confirm();
  setDrizzleTransactionLocal(confirmation, true);
}
