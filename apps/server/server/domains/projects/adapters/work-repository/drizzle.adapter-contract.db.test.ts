/** PostgreSQL half of the shared WorkRepository conformance suite. */

import { beforeEach, describe, it } from "vitest";
import { createDrizzleLineageScratchLifecycle } from "../../../context/adapters/lineage-scratch-lifecycle.js";
import { createLocalFileAccessChanges } from "../../../file-policy/index.js";

const DATABASE_URL = process.env.DATABASE_URL;
const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("drizzle WorkRepository adapter contract (postgres)", () => {});
} else {
  describe("drizzle WorkRepository adapter contract (postgres)", async () => {
    const { projects, users } = await import("@meridian/database/schema");
    const { conformanceUserValues } = await import(
      "@meridian/database/__test-support__/db-fixtures"
    );
    const { deleteDrizzleRows, useRollbackTestDatabase } = await import(
      "../../../../test-support/drizzle-reset.js"
    );
    const { expectWorkRepositoryLifecycleContract } = await import(
      "../__conformance__/work-repository-contract.js"
    );
    const { createDrizzleWorkRepository } = await import("./drizzle.js");

    const USER_ID = "00000000-0000-4000-8000-000000000a10";
    const PROJECT_ID = "00000000-0000-4000-8000-000000000a11";
    const database = useRollbackTestDatabase(DATABASE_URL, {
      prepareSuite: (db) => deleteDrizzleRows(db, [users]),
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

    it("honors restore, no-change, and retention policy", async () => {
      let now = new Date("2026-01-01T00:00:00.000Z");
      const repo = createDrizzleWorkRepository({
        lineageScratch: createDrizzleLineageScratchLifecycle(db),
        db,
        fileAccessChanges: createLocalFileAccessChanges(),
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
      });
    });
  });
}
