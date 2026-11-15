/**
 * Advisory lock serializing the checks that put an AI write into live in one Agents level, so
 * the second of two auto-Applies compares against a live that already holds the first's effect.
 *
 * A session lock on a reserved connection, not a transaction lock: the comparison reads text
 * through the live and draft rooms, which run outside any command transaction by design, so the
 * Apply's own transaction cannot hold it. It is taken before any other lock (the caller holds
 * none and is in no transaction) and released after the Apply commits, so it sorts before every
 * key in the lock order in `domains/collab/.context/CONTEXT.md`.
 */
import type { Database } from "@meridian/database";

/** The level's owner: a Project's level, or an account's `user://.agents/`. */
export type AgentsLevelOwner =
  | { level: "project"; projectId: string }
  | { level: "user"; userId: string };

const lockKey = (owner: AgentsLevelOwner) =>
  `agents-level:${owner.level === "project" ? `project:${owner.projectId}` : `user:${owner.userId}`}`;

export async function withAgentsLevelLock<T>(
  db: Database,
  owner: AgentsLevelOwner,
  operation: () => Promise<T>,
): Promise<T> {
  const connection = await db.$client.reserve();
  const key = lockKey(owner);
  try {
    await connection`select pg_advisory_lock(hashtextextended(${key}, 0::bigint))`;
    try {
      return await operation();
    } finally {
      // A lock the connection still holds would outlive it in the pool: drop them all.
      await connection`select pg_advisory_unlock_all()`;
    }
  } finally {
    connection.release();
  }
}
