/** PostgreSQL half of the shared transcript reader behavior contract. */

import type { ProjectId, UserId } from "@meridian/contracts/runtime";
import { beforeEach, describe } from "vitest";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("transcript page adapter contract (postgres)", () => {});
} else {
  describe("transcript page adapter contract (postgres)", async () => {
    const schema = await import("@meridian/database/schema");
    const { assertThrowawayDatabaseForRunDbTests, conformanceUserValues } = await import(
      "@meridian/database/__test-support__/db-fixtures"
    );
    const { useRollbackTestDatabase } = await import(
      "../../../test-support/rollback-test-database.js"
    );
    const { truncateDrizzleTables } = await import("../../../test-support/drizzle-reset.js");
    const { createDrizzleRepositoriesForTest } = await import(
      "../adapters/drizzle/repositories.js"
    );
    const { defineTranscriptPageContract } = await import(
      "../__conformance__/transcript-page-contract.js"
    );

    assertThrowawayDatabaseForRunDbTests(DATABASE_URL);
    const database = useRollbackTestDatabase(DATABASE_URL, {
      max: 4,
      prepareSuite: (db) => truncateDrizzleTables(db, [schema.users]),
    });
    let db = database.current;
    const userId = "00000000-0000-4000-8000-000000000a01" as UserId;
    const projectId = "00000000-0000-4000-8000-000000000a02" as ProjectId;

    beforeEach(async () => {
      db = database.current;
      await db
        .insert(schema.users)
        .values(conformanceUserValues(userId, "transcript-page-contract"));
      await db.insert(schema.projects).values({
        id: projectId,
        userId,
        name: "Transcript page contract",
        slug: "transcript-page-contract",
      });
    });

    defineTranscriptPageContract(async () => ({
      repos: createDrizzleRepositoriesForTest(db),
      projectId,
      userId,
    }));
  });
}
