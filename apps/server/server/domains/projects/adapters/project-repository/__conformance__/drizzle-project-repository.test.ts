import { describe } from "vitest";

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  describe.skip("drizzle project repository (postgres)", () => {});
} else {
  describe("drizzle project repository (postgres)", async () => {
    const { afterAll, beforeEach } = await import("vitest");
    const { createDb } = await import("@meridian/database");
    const {
      authUsers,
      projects,
      threads,
      turns,
      turnBlocks,
      modelResponses,
      threadDocuments,
      turnDocumentTouches,
      eventJournal,
    } = await import("@meridian/database/schema");
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
        authUsers,
      ]);
    }

    async function seedUsers(): Promise<void> {
      await db.insert(authUsers).values([
        {
          id: PROJECT_REPOSITORY_CONFORMANCE_USER_1,
        },
        {
          id: PROJECT_REPOSITORY_CONFORMANCE_USER_2,
        },
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
