/** A brief hold shares the run mutex without publishing an execution lease. */
import type { Database } from "@meridian/database";
import { describe, expect, it } from "vitest";
import type { HeldRunClaim } from "../loop/ports.js";
import { createDrizzleRunClaim } from "./drizzle-run-claim.js";

function createLockDatabase() {
  const locked = new Set<string>();
  const db = {
    $client: {
      async reserve() {
        const owned = new Set<string>();
        const connection = Object.assign(
          async <T extends Record<string, unknown>[]>(
            strings: TemplateStringsArray,
            ...values: unknown[]
          ) => {
            const query = strings.join("");
            const key = String(values[0]);
            if (query.includes("pg_try_advisory_lock")) {
              const acquired = !locked.has(key);
              if (acquired) {
                locked.add(key);
                owned.add(key);
              }
              return [{ acquired }] as unknown as T;
            }
            if (query.includes("pg_advisory_unlock")) {
              const released = owned.delete(key);
              if (released) locked.delete(key);
              return [{ released }] as unknown as T;
            }
            throw new Error(`Unexpected lock query: ${query}`);
          },
          { release() {} },
        );
        return connection;
      },
    },
  } as unknown as Database;
  return db;
}

describe("RunClaim.hold", () => {
  it("excludes run starts without publishing a lease and releases the shared claim", async () => {
    const claim = createDrizzleRunClaim(createLockDatabase());
    const held = await claim.hold("thread-a" as never);
    expect(held).not.toBeNull();
    expect(await claim.startExecution("thread-a" as never, "run-a")).toBeNull();

    await held?.release();

    expect(await claim.hold("thread-a" as never)).not.toBeNull();
  });

  it("builds short exclusive work on the held claim", async () => {
    const claim = createDrizzleRunClaim(createLockDatabase());
    let acquireAgain: (() => Promise<HeldRunClaim | null>) | undefined;

    const result = await claim.withExclusiveThread("thread-b" as never, async () => {
      acquireAgain = async () => claim.hold("thread-b" as never);
      return "exclusive";
    });

    expect(result).toBe("exclusive");
    const acquired = await acquireAgain?.();
    expect(acquired).not.toBeNull();
    await acquired?.release();
  });
});
