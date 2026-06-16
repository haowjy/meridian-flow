/** Ambient Drizzle transaction context shared by adapters that must participate in one app-level DB transaction. */
import { AsyncLocalStorage } from "node:async_hooks";
import type { Database } from "@meridian/database";

export type DrizzleDatabase = Database;
export type DrizzleTransaction = Parameters<Parameters<DrizzleDatabase["transaction"]>[0]>[0];
export type DrizzleDb = DrizzleDatabase | DrizzleTransaction;

const transactionStorage = new AsyncLocalStorage<DrizzleDb>();

export function currentDrizzleDb(db: DrizzleDb): DrizzleDb {
  return transactionStorage.getStore() ?? db;
}

export async function runInDrizzleTransaction<T>(
  db: DrizzleDatabase,
  operation: () => Promise<T>,
): Promise<T> {
  const active = transactionStorage.getStore();
  if (active) return operation();
  return db.transaction((tx) => transactionStorage.run(tx, operation));
}
