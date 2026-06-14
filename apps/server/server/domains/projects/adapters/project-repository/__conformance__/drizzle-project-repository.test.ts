// @ts-nocheck
import { describe } from "vitest";

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  describe.skip("drizzle project repository (postgres)", () => {});
} else {
  describe("drizzle project repository (postgres)", async () => {
    const { afterAll, beforeEach } = await import("vitest");
    const { openDatabase } = await import("@meridian/database");
    const {
      users,
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

    const handle = openDatabase(DATABASE_URL);
    const db = handle.db;

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
      await db.insert(users).values([
        {
          id: PROJECT_REPOSITORY_CONFORMANCE_USER_1,
          externalId: "project-conformance-user-1",
          email: "project-conformance-1@example.test",
        },
        {
          id: PROJECT_REPOSITORY_CONFORMANCE_USER_2,
          externalId: "project-conformance-user-2",
          email: "project-conformance-2@example.test",
        },
      ]);
    }

    beforeEach(async () => {
      await truncateAll();
      await seedUsers();
    });

    afterAll(async () => {
      await handle.close();
    });

    describeProjectRepositoryConformance("drizzle", () => createDrizzleProjectRepository({ db }));
  });
}
