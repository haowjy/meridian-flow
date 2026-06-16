import { describe } from "vitest";

const DATABASE_URL = process.env.DATABASE_URL;
const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("drizzle project repository (postgres)", () => {});
} else {
  describe("drizzle project repository (postgres)", async () => {
    const { afterAll, beforeEach } = await import("vitest");
    const { createDb } = await import("@meridian/database");
    const {
      projects,
      threads,
      turns,
      turnBlocks,
      modelResponses,
      threadDocuments,
      turnDocumentTouches,
      eventJournal,
      users,
    } = await import("@meridian/database/schema");
    const { conformanceUserValues } = await import(
      "@meridian/database/__test-support__/db-fixtures"
    );
    const { truncateDrizzleTables } = await import("../../../../../test-support/drizzle-reset.js");
    const { createDrizzleProjectRepository } = await import("../drizzle.js");
    const {
      PROJECT_REPOSITORY_CONFORMANCE_USER_1,
      PROJECT_REPOSITORY_CONFORMANCE_USER_2,
      describeProjectRepositoryConformance,
    } = await import("./project-repository.conformance.js");

    const db = createDb(DATABASE_URL, { max: 1 });

    async function truncateAll(): Promise<void> {
      await truncateDrizzleTables(db, [
        eventJournal,
        turnDocumentTouches,
        turnBlocks,
        modelResponses,
        threadDocuments,
        turns,
        threads,
        projects,
        users,
      ]);
    }

    async function seedUsers(): Promise<void> {
      await db
        .insert(users)
        .values([
          conformanceUserValues(PROJECT_REPOSITORY_CONFORMANCE_USER_1, "project-repository-1"),
          conformanceUserValues(PROJECT_REPOSITORY_CONFORMANCE_USER_2, "project-repository-2"),
        ]);
    }

    beforeEach(async () => {
      await truncateAll();
      await seedUsers();
    });

    afterAll(async () => {
      await db.close();
    });

    describeProjectRepositoryConformance("drizzle", () => createDrizzleProjectRepository({ db }));
  });
}
