/** Pause after every awaited snapshot query, without production hooks or module mocks. */
import type { Database } from "@meridian/database";
import type { DrizzleTransaction } from "../../../shared/drizzle-transaction.js";

export function observeReviewSnapshot(db: Database, boundary: () => Promise<void>): Database {
  function query<T extends object>(target: T): T {
    return new Proxy(target, {
      get(target, key, receiver) {
        const value = Reflect.get(target, key, receiver);
        if (key === "then") {
          return (resolve: (value: unknown) => unknown, reject: (cause: unknown) => unknown) =>
            Promise.resolve(target)
              .then(async (result) => {
                await boundary();
                return result;
              })
              .then(resolve, reject);
        }
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          const result = value.apply(target, args);
          return result && typeof result === "object" ? query(result) : result;
        };
      },
    });
  }
  return new Proxy(db, {
    get(target, key, receiver) {
      if (key !== "transaction") return Reflect.get(target, key, receiver);
      return (
        run: (tx: DrizzleTransaction) => Promise<unknown>,
        options: { isolationLevel?: string; accessMode?: string },
      ) =>
        target.transaction(
          (tx) =>
            run(
              options?.isolationLevel === "repeatable read" && options.accessMode === "read only"
                ? new Proxy(tx, {
                    get(target, key, receiver) {
                      const value = Reflect.get(target, key, receiver);
                      return key === "select" || key === "execute"
                        ? (...args: unknown[]) => query(value.apply(target, args))
                        : value;
                    },
                  })
                : tx,
            ),
          options as never,
        );
    },
  });
}
