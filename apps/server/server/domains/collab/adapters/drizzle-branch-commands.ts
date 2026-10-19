/** Postgres command record (contract §4.6): lookup, claim in the effect transaction, settlement. */

import type { StoredBranchCommandResult } from "@meridian/contracts/branches";
import type { Database } from "@meridian/database";
import { branchCommands } from "@meridian/database/schema";
import { eq, sql } from "drizzle-orm";
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
    })
    .from(branchCommands)
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
