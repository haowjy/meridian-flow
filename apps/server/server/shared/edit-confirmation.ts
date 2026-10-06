/**
 * The edit grants one write call carries, confirmed inside each write seam's
 * own transaction (file-access §5). The caller binds them to the call's async
 * scope; a seam (journal append and reversal, branch commit and push, the
 * namespace transaction) locks their Works with its own in id order, then
 * confirms them before taking any advisory lock.
 *
 * A reply's save confirms its grants once, before any participant writes
 * (§5.2), and marks those documents confirmed for its transaction.
 *
 * A seam reached with no scope is one of the writers §5.1 names (a replay of
 * an already confirmed write, a derived write, a lifecycle-owned write); it
 * keeps its own locked lifecycle check. An agent write is never one of them,
 * so an agent write with no scope and no confirmed reply is refused.
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
  /** Re-checks the grants under the seam's Work locks, in its transaction; throws on a refusal. */
  confirm(): Promise<void>;
  /** The grants name each document, or it lies in a container they grant. */
  covers(documentIds: readonly string[]): Promise<boolean>;
}

const scope = new AsyncLocalStorage<EditConfirmation>();

/** Runs a write with its grants bound, for every seam it reaches to confirm. */
export function runWithEditConfirmation<T>(
  confirmation: EditConfirmation,
  operation: () => Promise<T>,
): Promise<T> {
  return scope.run(confirmation, operation);
}

/**
 * Runs work that isn't the bound write outside its grants: what the write
 * triggers after it commits, or on a timer. Confirming the grants again there
 * would see the write's own result, and a deleted document confirms nothing.
 * After-commit dispatch leaves the scope this way.
 */
export function runOutsideEditConfirmation<T>(operation: () => T): T {
  return scope.exit(operation);
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

const replyConfirmed = { key: "reply-confirmed-documents" };

/**
 * The reply's save confirmed these documents' grants in this transaction
 * (§5.2). Outside a transaction (the in-memory composition) no seam checks.
 */
export function markReplyConfirmed(documentIds: Iterable<string>): void {
  const confirmed = getDrizzleTransactionLocal<Set<string>>(replyConfirmed) ?? new Set<string>();
  for (const documentId of documentIds) confirmed.add(documentId);
  setDrizzleTransactionLocal(replyConfirmed, confirmed);
}

/** An agent write reached a seam with no grant: an entry point skipped the file policy. */
export class UngrantedAgentWriteError extends Error {
  constructor(readonly documentIds: readonly string[]) {
    super(`Agent write without a file grant: ${documentIds.join(", ")}`);
    this.name = "UngrantedAgentWriteError";
  }
}

/**
 * Refuses an agent write that carries no grant for its documents: the grants
 * bound to the call don't cover them, and the reply saving it didn't confirm
 * them.
 */
export async function requireAgentWriteGrant(documentIds: readonly string[]): Promise<void> {
  const confirmed = getDrizzleTransactionLocal<Set<string>>(replyConfirmed);
  if (confirmed && documentIds.every((documentId) => confirmed.has(documentId))) return;
  if (await scope.getStore()?.covers(documentIds)) return;
  throw new UngrantedAgentWriteError(documentIds);
}
