/** PostgreSQL session-lock adapter for cross-process thread-run ownership. */
import type { Database } from "@meridian/database";
import type { ThreadRunOwnership } from "../loop/thread-run-ownership.js";

const THREAD_RUN_LOCK_SEED = 81n;

export function createDrizzleThreadRunOwnership(db: Database): ThreadRunOwnership {
  // One reserved session owns every run lock for this server process. Holding a
  // pool connection per turn would cap live runs at the ordinary query-pool size.
  let connectionPromise: ReturnType<Database["$client"]["reserve"]> | undefined;
  const localClaims = new Map<string, symbol>();
  let operationChain = Promise.resolve();
  const connection = async () => {
    if (!connectionPromise) connectionPromise = db.$client.reserve();
    const pending = connectionPromise;
    try {
      return await pending;
    } catch (cause) {
      if (connectionPromise === pending) connectionPromise = undefined;
      throw cause;
    }
  };
  const releaseConnectionIfIdle = (
    lockConnection: Awaited<ReturnType<Database["$client"]["reserve"]>>,
  ) => {
    if (localClaims.size !== 0) return;
    connectionPromise = undefined;
    lockConnection.release();
  };
  const exclusive = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = operationChain.then(operation, operation);
    operationChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  return {
    async tryAcquire(threadId) {
      return exclusive(async () => {
        // PostgreSQL session advisory locks are reentrant. This registry makes
        // the adapter's ownership contract exclusive without acting as recovery
        // authority; process death still releases the database session locks.
        if (localClaims.has(threadId)) return null;

        const lockConnection = await connection();
        const lockKey = `meridian:thread-run:${threadId}`;
        try {
          const [row] = await lockConnection<{ acquired: boolean }[]>`
            select pg_try_advisory_lock(
              hashtextextended(${lockKey}, ${THREAD_RUN_LOCK_SEED})
            ) as acquired
          `;
          if (!row?.acquired) {
            releaseConnectionIfIdle(lockConnection);
            return null;
          }
          const claimToken = Symbol(threadId);
          localClaims.set(threadId, claimToken);
          return {
            async release() {
              await exclusive(async () => {
                // A stale claim must not release a newer claim for the same
                // thread after its own successful release.
                if (localClaims.get(threadId) !== claimToken) return;
                const [unlock] = await lockConnection<{ released: boolean }[]>`
                    select pg_advisory_unlock(
                      hashtextextended(${lockKey}, ${THREAD_RUN_LOCK_SEED})
                    ) as released
                  `;
                if (!unlock?.released) {
                  throw new Error(`Thread run claim was not held: ${threadId}`);
                }
                localClaims.delete(threadId);
                releaseConnectionIfIdle(lockConnection);
              });
            },
          };
        } catch (cause) {
          releaseConnectionIfIdle(lockConnection);
          throw cause;
        }
      });
    },
  };
}
