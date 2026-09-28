/** PostgreSQL half of connected listing and history projection contracts. */
import type { ProjectId, UserId } from "@meridian/contracts/runtime";
import { beforeEach, describe } from "vitest";

const RUN = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;
if (!RUN || !DATABASE_URL) describe.skip("history tools (postgres)", () => {});
else
  describe("history tools (postgres)", async () => {
    const schema = await import("@meridian/database/schema");
    const { conformanceUserValues } = await import(
      "@meridian/database/__test-support__/db-fixtures"
    );
    const { useRollbackTestDatabase } = await import("../../../test-support/drizzle-reset.js");
    const { deleteDrizzleRows } = await import("../../../test-support/drizzle-reset.js");
    const { createDrizzleRepositoriesForTest } = await import(
      "../../threads/adapters/drizzle/repositories.js"
    );
    const { defineThreadHistoryContract } = await import("./thread-history-contract.js");
    const { defineThreadLsContract } = await import("./thread-ls-contract.js");
    const database = useRollbackTestDatabase(DATABASE_URL, {
      max: 4,
      prepareSuite: (db) => deleteDrizzleRows(db, [schema.users]),
    });
    const userId = "00000000-0000-4000-8000-000000000b01" as UserId;
    const projectId = "00000000-0000-4000-8000-000000000b02" as ProjectId;
    beforeEach(async () => {
      const db = database.current;
      await db.insert(schema.users).values(conformanceUserValues(userId, "history-tools"));
      await db
        .insert(schema.projects)
        .values({ id: projectId, userId, name: "History tools", slug: "history-tools" });
    });
    const harness = async () => ({
      repos: createDrizzleRepositoriesForTest(database.current),
      projectId,
      userId,
    });
    defineThreadHistoryContract(harness);
    defineThreadLsContract(harness);
  });
