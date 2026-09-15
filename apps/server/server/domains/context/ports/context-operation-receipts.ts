/** Durable receipt transaction port, bound to one authenticated actor and project. */
import type { ContextOperationReceipt } from "@meridian/contracts/protocol";

export interface ContextOperationReceiptStore {
  transaction<T>(operationId: string, operation: () => Promise<T>): Promise<T>;
  savepoint<T>(operation: () => Promise<T>): Promise<T>;
  lookup(operationId: string): Promise<ContextOperationReceipt | null>;
  insert(receipt: ContextOperationReceipt): Promise<void>;
}
