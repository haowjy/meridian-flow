/** PostgreSQL session-lock adapter for cross-process thread-run ownership. */
import type { Database } from "@meridian/database";
import type { ThreadRunOwnership } from "../loop/thread-run-ownership.js";

const THREAD_RUN_LOCK_SEED = 81n;

export function createDrizzleThreadRunOwnership(db: Database): ThreadRunOwnership {
  // One reserved session owns every run lock for this server process. Holding a
  // pool connection per turn would cap live runs at the ordinary query-pool size.
  let connectionPromise: ReturnType<Database["$client"]["reserve"]> | undefined;
  let activeClaims = 0;
  let operationChain = Promise.resolve();
  const connection = () => (connectionPromise ??= db.$client.reserve());
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
        const lockConnection = await connection();
        const lockKey = `meridian:thread-run:${threadId}`;
        try {
          const [row] = await lockConnection<{ acquired: boolean }[]>`
            select pg_try_advisory_lock(
              hashtextextended(${lockKey}, ${THREAD_RUN_LOCK_SEED})
            ) as acquired
          `;
          if (!row?.acquired) {
            if (activeClaims === 0) {
              lockConnection.release();
              connectionPromise = undefined;
            }
            return null;
          }
          activeClaims += 1;
          let released = false;
          return {
            async release() {
              if (released) return;
              released = true;
              await exclusive(async () => {
                try {
                  await lockConnection`
                    select pg_advisory_unlock(
                      hashtextextended(${lockKey}, ${THREAD_RUN_LOCK_SEED})
                    )
                  `;
                  activeClaims -= 1;
                  if (activeClaims === 0) {
                    lockConnection.release();
                    connectionPromise = undefined;
                  }
                } catch (cause) {
                  lockConnection.release();
                  connectionPromise = undefined;
                  activeClaims = 0;
                  throw cause;
                }
              });
            },
          };
        } catch (cause) {
          lockConnection.release();
          connectionPromise = undefined;
          activeClaims = 0;
          throw cause;
        }
      });
    },
  };
}
