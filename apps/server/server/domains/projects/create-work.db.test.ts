/** Postgres coverage for atomic Work creation and current selection. */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;

const USER_ID = "00000000-0000-4000-8000-000000000831";
const PROJECT_ID = "00000000-0000-4000-8000-000000000832";

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("Work creation (postgres)", () => {});
} else {
  describe("Work creation (postgres)", async () => {
    const { createDb } = await import("@meridian/database");
    const schema = await import("@meridian/database/schema");
    const { assertThrowawayDatabaseForRunDbTests, conformanceUserValues } = await import(
      "@meridian/database/__test-support__/db-fixtures"
    );
    const { createDrizzleProjectPreferencesRepository } = await import("../preferences/index.js");
    const { truncateDrizzleTables } = await import("../../test-support/drizzle-reset.js");
    const { createWork } = await import("./create-work.js");
    const { createDrizzleProjectWorkRepository } = await import("./index.js");

    assertThrowawayDatabaseForRunDbTests(DATABASE_URL);
    const db = createDb(DATABASE_URL, { max: 4 });
    const works = createDrizzleProjectWorkRepository({
      db,
      hasUnreviewedDraft: async () => false,
    });

    beforeEach(async () => {
      await truncateDrizzleTables(db, [schema.users]);
      await db.insert(schema.users).values(conformanceUserValues(USER_ID, "create-work"));
      await db.insert(schema.projects).values({
        id: PROJECT_ID,
        userId: USER_ID,
        name: "Create Work",
        slug: "create-work",
      });
    });

    afterAll(async () => {
      await db.close();
    });

    it("rolls creation back when current selection fails", async () => {
      const preferences = createDrizzleProjectPreferencesRepository({ db });

      await expect(
        createWork(
          {
            works,
            preferences: {
              ...preferences,
              async setCurrentWorkId() {
                throw new Error("injected preference failure");
              },
            },
          },
          USER_ID,
          {
            projectId: PROJECT_ID,
            createdByUserId: USER_ID,
            name: "Act 2",
          },
        ),
      ).rejects.toThrow("injected preference failure");

      await expect(works.listByProject(PROJECT_ID)).resolves.toEqual([]);
      await expect(preferences.getCurrentWorkId(USER_ID, PROJECT_ID)).resolves.toBeNull();
    });
  });
}
