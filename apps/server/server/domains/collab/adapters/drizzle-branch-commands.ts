/** Postgres command record (contract §4.6): lookup, claim in the effect transaction, settlement. */

import type { StoredBranchCommandResult } from "@meridian/contracts/branches";
import type { Database } from "@meridian/database";
import { branchCommands, branchPushSettlementBatches } from "@meridian/database/schema";
import { and, eq, sql } from "drizzle-orm";
import type { DrizzleDb } from "../../../shared/drizzle-transaction.js";
import type {
  BranchCommandEnvelope,
  BranchCommands,
  CommandLookup,
  CommandLookupKey,
} from "../domain/branch-commands.js";

export function createDrizzleBranchCommands(db: Database): BranchCommands {
  return {
    async lookup(envelope) {
      return lookupCommand(db as unknown as DrizzleDb, envelope);
    },
  };
}

export async function lookupCommand(
  db: DrizzleDb,
  envelope: CommandLookupKey,
): Promise<CommandLookup> {
  const [row] = await db
    .select({
      accountId: branchCommands.accountId,
      workId: branchCommands.workId,
      requestDigest: branchCommands.requestDigest,
      branchId: branchCommands.branchId,
      kind: branchCommands.kind,
      state: branchCommands.state,
      result: branchCommands.result,
      batchState: branchPushSettlementBatches.state,
    })
    .from(branchCommands)
    .leftJoin(
      branchPushSettlementBatches,
      eq(branchPushSettlementBatches.id, branchCommands.settlementBatchId),
    )
    .where(eq(branchCommands.id, envelope.commandId))
    .limit(1);
  if (!row) return { kind: "none" };
  if (
    row.accountId !== envelope.accountId ||
    row.workId !== envelope.workId ||
    (envelope.digest !== undefined && row.requestDigest !== envelope.digest)
  ) {
    return { kind: "conflict" };
  }
  if (row.state === "done" && row.result) {
    return { kind: "done", commandKind: row.kind, result: row.result };
  }
  if (row.batchState === "blocked") return { kind: "blocked" };
  return { kind: "pending", branchId: row.branchId };
}

/**
 * The first write of the effect transaction. False: another request holds the id (its row
 * committed, or its transaction is open and this insert waited on the key), so the caller
 * rolls its own effect back and answers the winner's row.
 */
export async function claimCommandWithinTx(
  db: DrizzleDb,
  envelope: BranchCommandEnvelope,
  settled?: StoredBranchCommandResult,
): Promise<boolean> {
  const [claimed] = await db
    .insert(branchCommands)
    .values({
      id: envelope.commandId,
      workId: envelope.workId,
      branchId: envelope.branchId,
      accountId: envelope.accountId,
      kind: envelope.kind,
      requestDigest: envelope.digest,
      ...(settled
        ? { state: "done" as const, result: settled, completedAt: sql`clock_timestamp()` }
        : {}),
    })
    .onConflictDoNothing()
    .returning({ id: branchCommands.id });
  return Boolean(claimed);
}

/** An Apply's staging transaction records the batch its command now waits on. */
export async function attachBatchWithinTx(
  db: DrizzleDb,
  commandId: string,
  batchId: string,
): Promise<void> {
  await db
    .update(branchCommands)
    .set({ settlementBatchId: batchId })
    .where(eq(branchCommands.id, commandId));
}

/** Completion or withdrawal of the command's batch: its terminal result, same transaction. */
export async function settleCommandForBatchWithinTx(
  db: DrizzleDb,
  batchId: string,
  result: StoredBranchCommandResult,
): Promise<void> {
  await db
    .update(branchCommands)
    .set({ state: "done", result, completedAt: sql`clock_timestamp()` })
    .where(and(eq(branchCommands.settlementBatchId, batchId), eq(branchCommands.state, "pending")));
}
