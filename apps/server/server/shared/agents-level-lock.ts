/**
 * Advisory locks serializing the checks that put an AI write into live in one Agents level, so
 * the second of two auto-Applies compares against a live that already holds the first's effect.
 *
 * Session locks on a small client of their own, outside the server's pool: a waiter holds one of
 * these connections and no pooled one, so waiters can never take the connections the holder's
 * reads and Apply need. It is not a transaction lock because the comparison reads text through
 * the live and draft rooms, which run outside any command transaction by design. The caller holds
 * no other lock and is in no transaction, so these sort before every key in the lock order in
 * `domains/collab/.context/CONTEXT.md`.
 *
 * A wait ends at `timeoutMs` (the wait for a connection and for each lock together): the caller's
 * write then stays a draft for the writer, and nothing hangs.
 */
import type { Sql } from "postgres";

/** The level's owner: a Project's level, or an account's `user://.agents/`. */
export type AgentsLevelOwner =
  | { level: "project"; projectId: string }
  | { level: "user"; userId: string };

const lockKey = (owner: AgentsLevelOwner) =>
  `agents-level:${owner.level === "project" ? `project:${owner.projectId}` : `user:${owner.userId}`}`;

/** Postgres' `lock_not_available`, raised when `lock_timeout` ends a wait. */
const LOCK_NOT_AVAILABLE = "55P03";

export type Held<T> = { held: true; value: T } | { held: false };

export interface AgentsLevelLocks {
  /**
   * Runs `operation` holding every level's lock, taken in a fixed order (sorted by key, so a
   * project's before a user's) so two writes that touch both levels cannot wait on each other.
   * `held: false` when a lock or a connection was not free in time.
   */
  hold<T>(owners: AgentsLevelOwner[], operation: () => Promise<T>): Promise<Held<T>>;
}

export function createAgentsLevelLocks(
  client: Sql,
  options: { timeoutMs: number } = { timeoutMs: 10_000 },
): AgentsLevelLocks {
  return {
    async hold(owners, operation) {
      const deadline = Date.now() + options.timeoutMs;
      const keys = [...new Set(owners.map(lockKey))].sort();
      const pending = client.reserve();
      let timer: NodeJS.Timeout | undefined;
      const timedOut = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), options.timeoutMs);
      });
      const connection = await Promise.race([pending, timedOut]);
      clearTimeout(timer);
      if (!connection) {
        // The connection arrives later and goes straight back; a failed reserve holds nothing.
        void pending.then(
          (late) => late.release(),
          () => undefined,
        );
        return { held: false };
      }
      try {
        for (const key of keys) {
          await connection`select set_config('lock_timeout', ${String(Math.max(1, deadline - Date.now()))}, false)`;
          try {
            await connection`select pg_advisory_lock(hashtextextended(${key}, 0::bigint))`;
          } catch (error) {
            if ((error as { code?: string }).code === LOCK_NOT_AVAILABLE) return { held: false };
            throw error;
          }
        }
        return { held: true, value: await operation() };
      } finally {
        // A lock the connection still holds would outlive it in the pool: drop them all.
        await connection`select pg_advisory_unlock_all()`;
        await connection`select set_config('lock_timeout', '0', false)`;
        connection.release();
      }
    },
  };
}
