/** Driver cancellation scopes: queued reads and transaction installation settle before callers resume. */
import { AsyncLocalStorage } from "node:async_hooks";
import type postgres from "postgres";

const signals = new AsyncLocalStorage<AbortSignal>();

export function withDatabaseSignal<T>(
  signal: AbortSignal,
  operation: () => Promise<T>,
): Promise<T> {
  signal.throwIfAborted();
  return signals.run(signal, async () => await operation());
}

function guardQueries<Client extends postgres.Sql | postgres.ReservedSql>(client: Client): Client {
  const unsafe = client.unsafe;
  client.unsafe = ((...args: Parameters<typeof unsafe>) => {
    const signal = signals.getStore();
    signal?.throwIfAborted();
    const query = unsafe(...args);
    if (signal) {
      const cancel = () => query.cancel();
      signal.addEventListener("abort", cancel, { once: true });
      const cleanup = () => signal.removeEventListener("abort", cancel);
      // Observe settlement without postgres's overridden .then() starting this lazy
      // query before Drizzle chooses .values() or the driver chooses .execute().
      void Promise.prototype.then.call(query, cleanup, cleanup);
    }
    return query;
  }) as typeof unsafe;
  return client;
}

/** A cancelled reservation never starts SQL; release it if the pool grants it later. */
function reserve(client: postgres.Sql, signal: AbortSignal): Promise<postgres.ReservedSql> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    void client.reserve().then(
      (connection) => {
        signal.removeEventListener("abort", abort);
        if (signal.aborted) connection.release();
        else resolve(connection);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

export function installQueryCancellation<Client extends postgres.Sql>(client: Client): Client {
  guardQueries(client);
  const begin = client.begin;
  client.begin = (async (...args: unknown[]) => {
    const signal = signals.getStore();
    if (!signal) return Reflect.apply(begin, client, args);
    const operation = args.pop() as (tx: postgres.TransactionSql) => Promise<unknown>;
    const options = String(args[0] ?? "").replace(/[^a-z ]/gi, "");
    const connection = await reserve(client, signal);
    const unsafe = connection.unsafe;
    guardQueries(connection);
    const tx = connection as unknown as postgres.TransactionSql;
    let nextSavepoint = 0;
    // Drizzle uses only the callback form. Keep nested rollback outside the aborted
    // scope, just like root rollback; the reserved connection cannot be reused yet.
    tx.savepoint = (async (...nested: unknown[]) => {
      const callback = nested.pop() as (tx: postgres.TransactionSql) => Promise<unknown>;
      const name = `meridian_${nextSavepoint++}`;
      await tx.unsafe(`savepoint ${name}`);
      try {
        const result = await callback(tx);
        signal.throwIfAborted();
        await tx.unsafe(`release savepoint ${name}`);
        return result;
      } catch (error) {
        await unsafe(`rollback to savepoint ${name}`);
        throw error;
      }
    }) as typeof tx.savepoint;
    try {
      await tx.unsafe(`begin ${options}`);
      const result = await operation(tx);
      signal.throwIfAborted();
      // Native postgres.begin uses an internal tagged COMMIT, invisible to query
      // cancellation. Own this COMMIT so Stop also cancels deferred-constraint waits.
      await tx.unsafe("commit");
      return result;
    } catch (error) {
      await unsafe("rollback");
      throw error;
    } finally {
      connection.release();
    }
  }) as typeof client.begin;
  return client;
}
