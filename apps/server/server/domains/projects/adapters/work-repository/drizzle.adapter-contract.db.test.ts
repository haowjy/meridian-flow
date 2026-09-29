/** PostgreSQL half of the shared WorkRepository conformance suite. */
import { eq } from "drizzle-orm";
import { beforeEach, describe, it } from "vitest";

const DATABASE_URL = process.env.DATABASE_URL;
const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("drizzle WorkRepository adapter contract (postgres)", () => {});
} else {
  describe("drizzle WorkRepository adapter contract (postgres)", async () => {
    const { projects, threads, threadWorks, users } = await import("@meridian/database/schema");
    const { conformanceUserValues } = await import(
      "@meridian/database/__test-support__/db-fixtures"
    );
    const { truncateDrizzleTables } = await import("../../../../test-support/drizzle-reset.js");
    const { useRollbackTestDatabase } = await import(
      "../../../../test-support/rollback-test-database.js"
    );
    const { expectWorkRepositoryLifecycleContract } = await import(
      "../__conformance__/work-repository-contract.js"
    );
    const { createDrizzleWorkRepository } = await import("./drizzle.js");

    const USER_ID = "00000000-0000-4000-8000-000000000a10";
    const PROJECT_ID = "00000000-0000-4000-8000-000000000a11";
    const database = useRollbackTestDatabase(DATABASE_URL, {
      prepareSuite: (db) => truncateDrizzleTables(db, [users]),
    });
    let db = database.current;

    beforeEach(async () => {
      db = database.current;
      await db.insert(users).values(conformanceUserValues(USER_ID, "work-contract"));
      await db.insert(projects).values({
        id: PROJECT_ID,
        userId: USER_ID,
        name: "Work Contract",
        slug: "work-contract",
      });
    });

    it("honors lifecycle cascade, exact restore, no-change, and retention", async () => {
      let now = new Date("2026-01-01T00:00:00.000Z");
      const repo = createDrizzleWorkRepository({
        db,
        now: () => now,
        projectionMutation: {
          async publishWorks() {},
          async touchWorks() {},
          async mutatePendingBranches(_ids, operation) {
            return operation();
          },
        },
      });
      await expectWorkRepositoryLifecycleContract({
        repo,
        projectId: PROJECT_ID,
        setNow(value) {
          now = value;
        },
        async addThread(input) {
          await db.insert(threads).values({
            id: input.id,
            projectId: PROJECT_ID,
            createdByUserId: USER_ID,
            title: input.id,
            deletedAt: input.deletedAt ? new Date(input.deletedAt) : null,
          });
          await db.insert(threadWorks).values({
            threadId: input.id,
            workId: input.workId,
            projectId: PROJECT_ID,
            isPrimary: true,
          });
        },
        async readThread(id) {
          const [row] = await db
            .select({ deletedAt: threads.deletedAt, deletedByWorkId: threads.deletedByWorkId })
            .from(threads)
            .where(eq(threads.id, id));
          if (!row) throw new Error(`Missing thread ${id}`);
          return {
            deletedAt: row.deletedAt?.toISOString() ?? null,
            deletedByWorkId: row.deletedByWorkId,
          };
        },
      });
    });
  });
}
