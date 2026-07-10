/** Ambient Drizzle transaction context shared by adapters that must participate in one app-level DB transaction. */
import { AsyncLocalStorage } from "node:async_hooks";
import type { Database } from "@meridian/database";

export type DrizzleDatabase = Database;
export type DrizzleTransaction = Parameters<Parameters<DrizzleDatabase["transaction"]>[0]>[0];
export type DrizzleDb = DrizzleDatabase | DrizzleTransaction;

type DrizzleTransactionContext = {
  db: DrizzleDb;
  afterCommit: Array<() => void | Promise<void>>;
  afterRollback: Array<() => void | Promise<void>>;
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
  const context: DrizzleTransactionContext = { db, afterCommit: [], afterRollback: [] };
  let result: T;
  try {
    result = await db.transaction((tx) => {
      context.db = tx;
      return transactionStorage.run(context, operation);
    });
  } catch (cause) {
    await dispatchAfterRollback(context.afterRollback, cause);
    throw cause;
  }
  await dispatchAfterCommit(context.afterCommit);
  return result;
}

export async function runInRootDrizzleTransaction<T>(
  db: DrizzleDatabase,
  operation: () => Promise<T>,
): Promise<T> {
  return transactionStorage.exit(async () => {
    const context: DrizzleTransactionContext = { db, afterCommit: [], afterRollback: [] };
    let result: T;
    try {
      result = await db.transaction((tx) => {
        context.db = tx;
        return transactionStorage.run(context, operation);
      });
    } catch (cause) {
      await dispatchAfterRollback(context.afterRollback, cause);
      throw cause;
    }
    await dispatchAfterCommit(context.afterCommit);
    return result;
  });
}

export function runAfterDrizzleCommit(callback: () => void | Promise<void>): boolean {
  const active = transactionStorage.getStore();
  if (!active) {
    void runOutsideDrizzleTransaction(callback);
    return false;
  }
  active.afterCommit.push(callback);
  return true;
}

/** Queue only when already inside an ambient transaction; callers run inline otherwise. */
export function deferUntilDrizzleCommit(callback: () => void | Promise<void>): boolean {
  const active = transactionStorage.getStore();
  if (!active) return false;
  active.afterCommit.push(callback);
  return true;
}

/** Queue only when already inside an ambient transaction; callers handle inline errors otherwise. */
export function deferUntilDrizzleRollback(callback: () => void | Promise<void>): boolean {
  const active = transactionStorage.getStore();
  if (!active) return false;
  active.afterRollback.push(callback);
  return true;
}

export function runOutsideDrizzleTransaction<T>(operation: () => T): T {
  return transactionStorage.exit(operation);
}

async function dispatchAfterCommit(callbacks: Array<() => void | Promise<void>>): Promise<void> {
  const errors: unknown[] = [];
  for (const callback of callbacks) {
    try {
      await runOutsideDrizzleTransaction(callback);
    } catch (cause) {
      errors.push(cause);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, `${errors.length} after-commit callbacks failed`);
  }
}

async function dispatchAfterRollback(
  callbacks: Array<() => void | Promise<void>>,
  transactionCause: unknown,
): Promise<void> {
  const errors: unknown[] = [];
  for (const callback of [...callbacks].reverse()) {
    try {
      await runOutsideDrizzleTransaction(callback);
    } catch (cause) {
      errors.push(cause);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(
      [transactionCause, ...errors],
      "Drizzle transaction and after-rollback callbacks failed",
    );
  }
}
