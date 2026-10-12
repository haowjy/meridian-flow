/** Failed session-lock releases clear local claims and make later claims usable. */
import type { Database } from "@meridian/database";
import { describe, expect, it, vi } from "vitest";
import { createDrizzleSessionLock } from "./drizzle-session-lock.js";

describe("PostgreSQL session advisory lock", () => {
  it("drops a dead session, notifies holders, and reserves a fresh one", async () => {
    let failUnlock = true;
    const released = vi.fn();
    const connection = Object.assign(
      async <T extends Record<string, unknown>[]>(strings: TemplateStringsArray) => {
        if (strings.join("").includes("pg_advisory_unlock") && failUnlock) {
          failUnlock = false;
          throw new Error("connection dropped");
        }
        return [{ acquired: true, released: true }] as unknown as T;
      },
      { release: released },
    );
    const reserve = vi.fn(async () => connection);
    const db = { $client: { reserve } } as unknown as Database;
    const lock = createDrizzleSessionLock(db, 83n);
    const first = await lock.tryAcquire("seed-a");
    expect(first).not.toBeNull();

    const onLost = vi.fn();
    first?.onLost(onLost);
    await first?.release();

    expect(onLost).toHaveBeenCalledOnce();
    expect(released).toHaveBeenCalledOnce();
    const second = await lock.tryAcquire("seed-b");
    expect(second).not.toBeNull();
    expect(reserve).toHaveBeenCalledTimes(2);
    await second?.release();
  });
});
