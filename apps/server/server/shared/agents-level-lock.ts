/**
 * Advisory lock serializing the checks that put an AI write into live in one Agents level, so
 * the second of two auto-Applies compares against a live that already holds the first. Taken
 * inside an Apply, after the Work rows and before any list or document key (the lock order in
 * `domains/collab/.context/CONTEXT.md`).
 */
import { sql } from "drizzle-orm";
import { currentDrizzleDb, type DrizzleDb } from "./drizzle-transaction.js";

/** The level's owner: a Project's level, or an account's `user://.agents/`. */
export type AgentsLevelOwner =
  | { level: "project"; projectId: string }
  | { level: "user"; userId: string };

const lockKey = (owner: AgentsLevelOwner) =>
  `agents-level:${owner.level === "project" ? `project:${owner.projectId}` : `user:${owner.userId}`}`;

export async function lockAgentsLevel(db: DrizzleDb, owner: AgentsLevelOwner): Promise<void> {
  await currentDrizzleDb(db).execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${lockKey(owner)}, 0::bigint))`,
  );
}
