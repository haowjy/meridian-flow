/** PostgreSQL receipt serialization and real savepoints; joins the namespace transaction context. */
import type { Database } from "@meridian/database";
import { contextAvailabilityHeads } from "@meridian/database/schema";
import { contextOperationReceipts } from "@meridian/database/schema/context-operation-receipts";
import { and, eq, sql } from "drizzle-orm";
import {
  currentDrizzleDb,
  runInDrizzleSavepoint,
  runInDrizzleTransaction,
} from "../../../shared/drizzle-transaction.js";
import type { ContextOperationReceiptStore } from "../ports/context-operation-receipts.js";

export function createDrizzleContextOperationReceipts(
  db: Database,
  owner: { userId: string; projectId: string },
): ContextOperationReceiptStore {
  return {
    transaction: (operationId, operation) =>
      runInDrizzleTransaction(db, async () => {
        const key = `context-operation:${owner.userId}:${owner.projectId}:${operationId}`;
        await currentDrizzleDb(db).execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0::bigint))`,
        );
        return operation();
      }),
    savepoint: (operation) => runInDrizzleSavepoint(db, operation),
    async lookup(operationId) {
      const [row] = await currentDrizzleDb(db)
        .select({ receipt: contextOperationReceipts.receipt })
        .from(contextOperationReceipts)
        .where(
          and(
            eq(contextOperationReceipts.userId, owner.userId),
            eq(contextOperationReceipts.projectId, owner.projectId),
            eq(contextOperationReceipts.operationId, operationId),
          ),
        );
      return row?.receipt ?? null;
    },
    async observationVersion(command) {
      const uri = command.kind === "delete" ? command.uri : command.destinationUri;
      const key = uri.startsWith("user://") ? `user:${owner.userId}` : `project:${owner.projectId}`;
      const [head] = await currentDrizzleDb(db)
        .select({ version: contextAvailabilityHeads.namespaceGeneration })
        .from(contextAvailabilityHeads)
        .where(eq(contextAvailabilityHeads.authorityKey, key));
      return String(head?.version ?? 0n);
    },
    async insert(receipt) {
      await currentDrizzleDb(db)
        .insert(contextOperationReceipts)
        .values({ ...owner, operationId: receipt.operationId, receipt });
    },
  };
}
