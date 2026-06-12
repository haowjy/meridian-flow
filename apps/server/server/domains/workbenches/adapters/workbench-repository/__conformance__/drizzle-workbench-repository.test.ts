// @ts-nocheck
import { describe } from "vitest";

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  describe.skip("drizzle workbench repository (postgres)", () => {});
} else {
  describe("drizzle workbench repository (postgres)", async () => {
    const { afterAll, beforeEach } = await import("vitest");
    const { openDatabase } = await import("@meridian/database");
    const {
      users,
      workbenches,
      threads,
      turns,
      turnBlocks,
      modelResponses,
      threadDocuments,
      turnDocumentTouches,
      eventJournal,
    } = await import("@meridian/database/schema");
    const { truncateDrizzleTables } = await import("../../../../../test-support/drizzle-reset.js");
    const { createDrizzleWorkbenchRepository } = await import("../drizzle.js");
    const {
      WORKBENCH_REPOSITORY_CONFORMANCE_USER_1,
      WORKBENCH_REPOSITORY_CONFORMANCE_USER_2,
      describeWorkbenchRepositoryConformance,
    } = await import("./workbench-repository.conformance.js");

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
        workbenches,
        users,
      ]);
    }

    async function seedUsers(): Promise<void> {
      await db.insert(users).values([
        {
          id: WORKBENCH_REPOSITORY_CONFORMANCE_USER_1,
          externalId: "workbench-conformance-user-1",
          email: "workbench-conformance-1@example.test",
        },
        {
          id: WORKBENCH_REPOSITORY_CONFORMANCE_USER_2,
          externalId: "workbench-conformance-user-2",
          email: "workbench-conformance-2@example.test",
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

    describeWorkbenchRepositoryConformance("drizzle", () =>
      createDrizzleWorkbenchRepository({ db }),
    );
  });
}
