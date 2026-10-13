/** Postgres command record (contract §4.6): lookup, claim in the effect transaction, settlement. */

import type { DraftCommandResult } from "@meridian/contracts/drafts";
import type { Database } from "@meridian/database";
import { branchPushSettlementBatches, draftCommands } from "@meridian/database/schema";
import { and, eq, sql } from "drizzle-orm";
import type { DrizzleDb } from "../../../shared/drizzle-transaction.js";
import type {
  CommandLookup,
  CommandLookupKey,
  DraftCommandEnvelope,
  DraftCommands,
} from "../domain/draft-commands.js";

export function createDrizzleDraftCommands(db: Database): DraftCommands {
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
      accountId: draftCommands.accountId,
      workId: draftCommands.workId,
      requestDigest: draftCommands.requestDigest,
      draftId: draftCommands.draftId,
      kind: draftCommands.kind,
      state: draftCommands.state,
      result: draftCommands.result,
      batchState: branchPushSettlementBatches.state,
    })
    .from(draftCommands)
    .leftJoin(
      branchPushSettlementBatches,
      eq(branchPushSettlementBatches.id, draftCommands.settlementBatchId),
    )
    .where(eq(draftCommands.id, envelope.commandId))
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
  return { kind: "pending", draftId: row.draftId };
}

/**
 * The first write of the effect transaction. False: another request holds the id (its row
 * committed, or its transaction is open and this insert waited on the key), so the caller
 * rolls its own effect back and answers the winner's row.
 */
export async function claimCommandWithinTx(
  db: DrizzleDb,
  envelope: DraftCommandEnvelope,
  settled?: DraftCommandResult,
): Promise<boolean> {
  const [claimed] = await db
    .insert(draftCommands)
    .values({
      id: envelope.commandId,
      workId: envelope.workId,
      draftId: envelope.draftId,
      accountId: envelope.accountId,
      kind: envelope.kind,
      requestDigest: envelope.digest,
      ...(settled
        ? { state: "done" as const, result: settled, completedAt: sql`clock_timestamp()` }
        : {}),
    })
    .onConflictDoNothing()
    .returning({ id: draftCommands.id });
  return Boolean(claimed);
}

/** An Apply's staging transaction records the batch its command now waits on. */
export async function attachBatchWithinTx(
  db: DrizzleDb,
  commandId: string,
  batchId: string,
): Promise<void> {
  await db
    .update(draftCommands)
    .set({ settlementBatchId: batchId })
    .where(eq(draftCommands.id, commandId));
}

/** Completion or withdrawal of the command's batch: its terminal result, same transaction. */
export async function settleCommandForBatchWithinTx(
  db: DrizzleDb,
  batchId: string,
  result: DraftCommandResult,
): Promise<void> {
  await db
    .update(draftCommands)
    .set({ state: "done", result, completedAt: sql`clock_timestamp()` })
    .where(and(eq(draftCommands.settlementBatchId, batchId), eq(draftCommands.state, "pending")));
}
