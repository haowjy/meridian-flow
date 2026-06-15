import { describe } from "vitest";

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  describe.skip("drizzle work repository (postgres)", () => {});
} else {
  describe("drizzle work repository (postgres)", async () => {
    const { afterAll, beforeEach } = await import("vitest");
    const { createDb } = await import("@meridian/database");
    const { authUsers, projects, works } = await import("@meridian/database/schema");
    const { truncateDrizzleTables } = await import("../../../../../test-support/drizzle-reset.js");
    const { createDrizzleWorkRepository } = await import("../drizzle.js");
    const { describeWorkRepositoryConformance } = await import("./work-repository.conformance.js");

    const USER_ID = "00000000-0000-4000-9000-000000000101";
    const PROJECT_FIXTURES = [
      { id: "00000000-0000-4000-9000-000000000001", title: "Project One", slug: "project-one" },
      { id: "00000000-0000-4000-9000-000000000002", title: "Project Two", slug: "project-two" },
    ] as const;

    const db = createDb(DATABASE_URL, { max: 1 });

    async function ensureFixtures(): Promise<void> {
      await db.insert(authUsers).values({ id: USER_ID });
      await db.insert(projects).values(
        PROJECT_FIXTURES.map((fixture) => ({
          id: fixture.id,
          name: fixture.title,
          slug: fixture.slug,
          userId: USER_ID,
        })),
      );
    }

    async function truncateAll(): Promise<void> {
      await truncateDrizzleTables(db, [works, projects, authUsers]);
    }

    beforeEach(async () => {
      await truncateAll();
      await ensureFixtures();
    });

    afterAll(async () => {
      await db.close();
    });

    describeWorkRepositoryConformance("drizzle", () => createDrizzleWorkRepository({ db }));
  });
}
