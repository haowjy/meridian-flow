/** Postgres: work that outlives its ambient transaction cannot reach the released connection. */
import { createDb } from "@meridian/database";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { currentDrizzleDb, runInDrizzleTransaction } from "./drizzle-transaction.js";

const RUN = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

if (!RUN || !DATABASE_URL) describe.skip("ambient transaction scope (postgres)", () => {});
else
  describe("ambient transaction scope (postgres)", () => {
    it("refuses a rejected fan-out's late query instead of running it in the next transaction", async () => {
      // One connection, so the next transaction is the one that takes the released connection.
      const db = createDb(DATABASE_URL, { max: 1 });
      try {
        let late: Promise<unknown> = Promise.resolve();
        await expect(
          runInDrizzleTransaction(db, async () => {
            late = wait(50).then(() =>
              currentDrizzleDb(db).execute(sql`select current_setting('probe.owner', true)`),
            );
            await Promise.all([Promise.reject(new Error("guard failed")), late]);
          }),
        ).rejects.toThrow("guard failed");
        const next = runInDrizzleTransaction(db, async () => {
          await currentDrizzleDb(db).execute(sql`select set_config('probe.owner', 'next', true)`);
          await wait(100);
          return currentDrizzleDb(db).execute(sql`select 1`);
        });
        await expect(late).rejects.toThrow("Database work ran after its transaction ended");
        await expect(next).resolves.toBeDefined();
      } finally {
        await db.close();
      }
    });
  });
