// @ts-nocheck
import { describe } from "vitest";

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  describe.skip("drizzle work repository (postgres)", () => {});
} else {
  describe("drizzle work repository (postgres)", async () => {
    const { afterAll, beforeEach } = await import("vitest");
    const { openDatabase } = await import("@meridian/database");
    const { users, workbenches, works } = await import("@meridian/database/schema");
    const { truncateDrizzleTables } = await import("../../../../../test-support/drizzle-reset.js");
    const { createDrizzleWorkRepository } = await import("../drizzle.js");
    const { describeWorkRepositoryConformance } = await import("./work-repository.conformance.js");

    const USER_ID = "00000000-0000-4000-9000-000000000101";
    const WORKBENCH_FIXTURES = [
      { id: "00000000-0000-4000-9000-000000000001", title: "Workbench One", slug: "workbench-one" },
      { id: "00000000-0000-4000-9000-000000000002", title: "Workbench Two", slug: "workbench-two" },
    ] as const;

    const handle = openDatabase(DATABASE_URL);
    const db = handle.db;

    async function ensureFixtures(): Promise<void> {
      await db.insert(users).values({
        id: USER_ID,
        externalId: "work-repository-conformance-user",
        email: "work-repository-conformance@example.test",
      });
      await db.insert(workbenches).values(
        WORKBENCH_FIXTURES.map((fixture) => ({
          id: fixture.id,
          title: fixture.title,
          slug: fixture.slug,
          createdBy: USER_ID,
        })),
      );
    }

    async function truncateAll(): Promise<void> {
      await truncateDrizzleTables(db, [works, workbenches, users]);
    }

    beforeEach(async () => {
      await truncateAll();
      await ensureFixtures();
    });

    afterAll(async () => {
      await handle.close();
    });

    describeWorkRepositoryConformance("drizzle", () => createDrizzleWorkRepository({ db }));
  });
}
