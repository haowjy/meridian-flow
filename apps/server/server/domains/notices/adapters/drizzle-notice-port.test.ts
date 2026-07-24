/** Postgres coverage for model-context notice recording and destructive drains. */

import { afterAll, beforeEach, describe, expect, it } from "vitest";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;

const USER_ID = "00000000-0000-4000-8000-000000000301";
const PROJECT_ID = "00000000-0000-4000-8000-000000000302";
const THREAD_ID = "00000000-0000-4000-8000-000000000305";
const OTHER_THREAD_ID = "00000000-0000-4000-8000-000000000306";

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("drizzle notice port (postgres)", () => {
    it("requires RUN_DB_TESTS and DATABASE_URL", () => {});
  });
} else {
  describe("drizzle notice port (postgres)", async () => {
    const { createDb } = await import("@meridian/database");
    const schema = await import("@meridian/database/schema");
    const { assertThrowawayDatabaseForRunDbTests, conformanceUserValues } = await import(
      "@meridian/database/__test-support__/db-fixtures"
    );
    const { truncateDrizzleTables } = await import("../../../test-support/drizzle-reset.js");
    const { createDrizzleNoticePort } = await import("./drizzle-notice-port.js");

    assertThrowawayDatabaseForRunDbTests(DATABASE_URL);
    const db = createDb(DATABASE_URL, { max: 1 });
    beforeEach(async () => {
      await truncateDrizzleTables(db, [
        schema.pendingNotices,
        schema.threads,
        schema.projects,
        schema.users,
      ]);
      await db.insert(schema.users).values(conformanceUserValues(USER_ID, "pending-notices"));
      await db.insert(schema.projects).values({
        id: PROJECT_ID,
        userId: USER_ID,
        name: "Notice Project",
        slug: "notice-project",
      });
      await db.insert(schema.threads).values([
        {
          id: THREAD_ID,
          projectId: PROJECT_ID,
          createdByUserId: USER_ID,
          title: "Thread",
          kind: "primary",
          status: "idle",
        },
        {
          id: OTHER_THREAD_ID,
          projectId: PROJECT_ID,
          createdByUserId: USER_ID,
          title: "Other Thread",
          kind: "primary",
          status: "idle",
        },
      ]);
    });

    afterAll(async () => {
      await db.close();
    });

    it("drains only the requested thread and deletes delivered notices", async () => {
      const port = createDrizzleNoticePort(db);
      for (const threadId of [THREAD_ID, OTHER_THREAD_ID]) {
        await port.record({
          kind: "awareness_degraded",
          scope: { kind: "thread", threadId },
          message: "Document awareness degraded",
          data: { documentIds: [] },
        });
      }

      await expect(port.drainForModelContext(THREAD_ID)).resolves.toMatchObject([
        { kind: "awareness_degraded", scope: { kind: "thread", threadId: THREAD_ID } },
      ]);
      await expect(port.drainForModelContext(THREAD_ID)).resolves.toEqual([]);
      await expect(port.drainForModelContext(OTHER_THREAD_ID)).resolves.toHaveLength(1);
    });

    it("records inside an ambient Drizzle transaction", async () => {
      const { runInDrizzleTransaction } = await import("../../../shared/drizzle-transaction.js");
      const port = createDrizzleNoticePort(db);
      await expect(
        runInDrizzleTransaction(db, async () => {
          await port.record({
            kind: "awareness_degraded",
            scope: { kind: "thread", threadId: THREAD_ID },
            message: "Document awareness degraded",
            data: { documentIds: [] },
          });
          throw new Error("roll back response transaction");
        }),
      ).rejects.toThrow("roll back response transaction");

      await expect(db.select().from(schema.pendingNotices)).resolves.toEqual([]);
    });
  });
}
