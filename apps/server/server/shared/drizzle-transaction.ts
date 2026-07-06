/** Ambient Drizzle transaction context shared by adapters that must participate in one app-level DB transaction. */
import { AsyncLocalStorage } from "node:async_hooks";
import type { Database } from "@meridian/database";

export type DrizzleDatabase = Database;
export type DrizzleTransaction = Parameters<Parameters<DrizzleDatabase["transaction"]>[0]>[0];
export type DrizzleDb = DrizzleDatabase | DrizzleTransaction;

type DrizzleTransactionContext = {
  db: DrizzleDb;
  afterCommit: Array<() => void | Promise<void>>;
};

const transactionStorage = new AsyncLocalStorage<DrizzleTransactionContext>();

export function currentDrizzleDb(db: DrizzleDb): DrizzleDb {
  return transactionStorage.getStore()?.db ?? db;
}

export async function runInDrizzleTransaction<T>(
  db: DrizzleDatabase,
  operation: () => Promise<T>,
): Promise<T> {
  const active = transactionStorage.getStore();
  if (active) return operation();
  const context: DrizzleTransactionContext = { db, afterCommit: [] };
  const result = await db.transaction((tx) => {
    context.db = tx;
    return transactionStorage.run(context, operation);
  });
  await dispatchAfterCommit(context.afterCommit);
  return result;
}

export async function runInRootDrizzleTransaction<T>(
  db: DrizzleDatabase,
  operation: () => Promise<T>,
): Promise<T> {
  return transactionStorage.exit(async () => {
    const context: DrizzleTransactionContext = { db, afterCommit: [] };
    const result = await db.transaction((tx) => {
      context.db = tx;
      return transactionStorage.run(context, operation);
    });
    await dispatchAfterCommit(context.afterCommit);
    return result;
  });
}

export function runAfterDrizzleCommit(callback: () => void | Promise<void>): void {
  const active = transactionStorage.getStore();
  if (!active) {
    void runOutsideDrizzleTransaction(callback);
    return;
  }
  active.afterCommit.push(callback);
}

export function runOutsideDrizzleTransaction<T>(operation: () => T): T {
  return transactionStorage.exit(operation);
}

async function dispatchAfterCommit(callbacks: Array<() => void | Promise<void>>): Promise<void> {
  for (const callback of callbacks) {
    await runOutsideDrizzleTransaction(callback);
  }
}
