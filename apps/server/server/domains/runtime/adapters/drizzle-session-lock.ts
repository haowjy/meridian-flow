/** PostgreSQL session advisory locks with process-local ownership and loss notification. */
import type { Database } from "@meridian/database";

export interface SessionLockClaim {
  release(): Promise<void>;
  onLost(listener: () => void): () => void;
}

export interface SessionLock {
  tryAcquire(key: string): Promise<SessionLockClaim | null>;
}

/**
 * A single reserved session can own many independent advisory locks without
 * consuming one pool connection per active operation. Any session error drops
 * all local ownership and notifies holders: a lock tied to a dead session is
 * no longer a valid claim.
 */
export function createDrizzleSessionLock(db: Database, seed: bigint): SessionLock {
  type Connection = Awaited<ReturnType<Database["$client"]["reserve"]>>;
  type Holder = {
    token: symbol;
    listeners: Set<() => void>;
    connection: Connection;
  };

  let connectionPromise: ReturnType<Database["$client"]["reserve"]> | undefined;
  let activeConnection: Connection | undefined;
  const claims = new Map<string, Holder>();
  let operationChain = Promise.resolve();

  const exclusive = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = operationChain.then(operation, operation);
    operationChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const reserve = async (): Promise<Connection> => {
    if (!connectionPromise) connectionPromise = db.$client.reserve();
    const pending = connectionPromise;
    try {
      const connection = await pending;
      activeConnection = connection;
      return connection;
    } catch (error) {
      if (connectionPromise === pending) connectionPromise = undefined;
      throw error;
    }
  };

  const drop = (connection: Connection) => {
    if (activeConnection !== connection) return;
    activeConnection = undefined;
    connectionPromise = undefined;
    const lost = [...claims.values()].filter((claim) => claim.connection === connection);
    for (const [key, claim] of claims) {
      if (claim.connection === connection) claims.delete(key);
    }
    connection.release();
    for (const claim of lost) {
      for (const listener of claim.listeners) {
        try {
          listener();
        } catch {
          // A holder cannot prevent other lost-claim notifications.
        }
      }
    }
  };

  const releaseIfIdle = (connection: Connection) => {
    if (claims.size === 0) drop(connection);
  };

  return {
    async tryAcquire(key) {
      return exclusive(async () => {
        if (claims.has(key)) return null;
        const connection = await reserve();
        try {
          const [row] = await connection<{ acquired: boolean }[]>`
            select pg_try_advisory_lock(hashtextextended(${key}, ${seed})) as acquired
          `;
          if (!row?.acquired) {
            releaseIfIdle(connection);
            return null;
          }
          const holder: Holder = { token: Symbol(key), listeners: new Set(), connection };
          claims.set(key, holder);
          return {
            onLost(listener) {
              if (claims.get(key) !== holder) {
                listener();
                return () => undefined;
              }
              holder.listeners.add(listener);
              return () => holder.listeners.delete(listener);
            },
            async release() {
              await exclusive(async () => {
                if (claims.get(key) !== holder) return;
                try {
                  const [unlock] = await connection<{ released: boolean }[]>`
                    select pg_advisory_unlock(hashtextextended(${key}, ${seed})) as released
                  `;
                  if (!unlock?.released) throw new Error(`Session lock was not held: ${key}`);
                  claims.delete(key);
                  releaseIfIdle(connection);
                } catch {
                  // The connection is not trustworthy after a failed unlock.
                  // Dropping it releases every server-side lock it held.
                  drop(connection);
                }
              });
            },
          };
        } catch (error) {
          drop(connection);
          throw error;
        }
      });
    },
  };
}
