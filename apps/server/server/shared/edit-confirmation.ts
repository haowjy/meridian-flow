import { AsyncLocalStorage } from "node:async_hooks";
import {
  getDrizzleTransactionLocal,
  isInDrizzleTransaction,
  setDrizzleTransactionLocal,
} from "./drizzle-transaction.js";
import type { LockedOwners } from "./work-lifecycle-lock.js";

export interface EditConfirmation {
  readonly workIds: readonly string[];
  readonly lineageRootIds: readonly string[];
  confirm(locked: LockedOwners): Promise<void>;
  covers(documentIds: readonly string[]): Promise<boolean>;
}

const scope = new AsyncLocalStorage<EditConfirmation>();

export function runWithEditConfirmation<T>(
  confirmation: EditConfirmation,
  operation: () => Promise<T>,
): Promise<T> {
  return scope.run(confirmation, operation);
}

export function runOutsideEditConfirmation<T>(operation: () => T): T {
  return scope.exit(operation);
}

export function scopedEditWorkIds(): readonly string[] {
  return scope.getStore()?.workIds ?? [];
}

export function scopedEditLineageRoots(): readonly string[] {
  return scope.getStore()?.lineageRootIds ?? [];
}

export async function confirmScopedEdits(locked: LockedOwners): Promise<void> {
  const confirmation = scope.getStore();
  if (!confirmation) return;
  if (!isInDrizzleTransaction()) {
    throw new Error("Edit grants are confirmed inside the write's own transaction");
  }
  if (getDrizzleTransactionLocal<boolean>(confirmation)) return;
  await confirmation.confirm(locked);
  setDrizzleTransactionLocal(confirmation, true);
}

export class UngrantedAgentWriteError extends Error {
  constructor(readonly documentIds: readonly string[]) {
    super(`Agent write without a file grant: ${documentIds.join(", ")}`);
    this.name = "UngrantedAgentWriteError";
  }
}

export async function requireAgentWriteGrant(documentIds: readonly string[]): Promise<void> {
  if (await scope.getStore()?.covers(documentIds)) return;
  throw new UngrantedAgentWriteError(documentIds);
}
