/**
 * Drizzle conformance tests for PackageRepository against real Postgres.
 * Runs against the canonical @meridian/database schema, adapted to Meridian's
 * Supabase auth users and projects-as-projects storage shape.
 *
 * Requires:
 *   DATABASE_URL  — Postgres connection string
 */
import { afterAll, beforeEach, describe, it } from "vitest";

const DATABASE_URL = process.env.DATABASE_URL;
const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const USER_ID = "00000000-0000-4000-9000-000000000201";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("drizzle package repository (postgres)", () => {
    it("requires DATABASE_URL", () => {});
  });
} else {
  describe("drizzle package repository (postgres)", async () => {
    const { createDb } = await import("@meridian/database");
    const { agentDefinitions, agentSkills, projects, skills, userInstalledSkills, users } =
      await import("@meridian/database/schema");
    const { conformanceUserValues } = await import(
      "@meridian/database/__test-support__/db-fixtures"
    );
    const { truncateDrizzleTables } = await import("../../../../test-support/drizzle-reset.js");
    const { createDrizzlePackageStore } = await import("../drizzle-package-store.js");
    const { describePackageRepositoryConformance } = await import(
      "./package-repository.conformance.js"
    );

    const db = createDb(DATABASE_URL, { max: 1 });

    async function ensureFixtures(): Promise<void> {
      await db.insert(users).values(conformanceUserValues(USER_ID, "package-repository"));
      await db.insert(projects).values({
        id: PROJECT_ID,
        userId: USER_ID,
        name: "Package conformance",
        slug: "package-conformance",
      });
    }

    async function truncateAll(): Promise<void> {
      await truncateDrizzleTables(db, [
        agentSkills,
        userInstalledSkills,
        skills,
        agentDefinitions,
        projects,
        users,
      ]);
    }

    beforeEach(async () => {
      await truncateAll();
      await ensureFixtures();
    });

    afterAll(async () => {
      await db.close();
    });

    describePackageRepositoryConformance("drizzle", () => createDrizzlePackageStore({ db }), {
      projectId: PROJECT_ID,
      userId: USER_ID,
    });
  });
}
