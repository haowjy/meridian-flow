/** Project lease-derived liveness with pending handoff seeds as non-lease work. */
import type { ThreadId } from "@meridian/contracts/runtime";
import type { ThreadLeaseState, ThreadStatus } from "@meridian/contracts/threads";
import type { Database } from "@meridian/database";
import * as schema from "@meridian/database/schema";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { ThreadStatusReader } from "../../threads/ports/repositories.js";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";

export function createDrizzleHandoffStatusReader(
  db: Database,
  leaseReader: ThreadStatusReader,
): ThreadStatusReader {
  const db_ = () => currentDrizzleDb(db);
  async function pendingSeeds(threadIds: readonly ThreadId[]) {
    if (threadIds.length === 0) return new Set<ThreadId>();
    const rows = await db_()
      .selectDistinct({ threadId: schema.turns.threadId })
      .from(schema.turns)
      .where(
        and(
          inArray(schema.turns.threadId, [...threadIds]),
          eq(schema.turns.role, "system"),
          eq(schema.turns.status, "pending"),
          sql`${schema.turns.metadata}->>'kind' = 'derivation_seed'`,
          sql`${schema.turns.metadata}->>'derivation' = 'handoff'`,
        ),
      );
    return new Set(rows.map((row) => row.threadId as ThreadId));
  }
  const working: ThreadStatus = { kind: "awake", phase: "generating", cancelRequested: false };
  return {
    async read(threadId) {
      const status = await leaseReader.read(threadId);
      if (status.kind === "awake") return status;
      return (await pendingSeeds([threadId])).has(threadId) ? working : status;
    },
    readRunningTurnId: (threadId) => leaseReader.readRunningTurnId(threadId),
    async readMany(threadIds): Promise<Map<ThreadId, ThreadLeaseState>> {
      const states = await leaseReader.readMany(threadIds);
      const missing = threadIds.filter((threadId) => !states.has(threadId));
      for (const threadId of await pendingSeeds(missing))
        states.set(threadId, { status: working, runningTurnId: null, currentTool: null });
      return states;
    },
  };
}
