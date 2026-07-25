/**
 * Postgres regression for #290: a non-UUID id (e.g. a project slug landing in a
 * `:projectId` route) must resolve to not-found at the repository boundary,
 * never a Postgres uuid-parse 500 leaking out of `findById`.
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("slug routing (postgres)", () => {
    it("requires RUN_DB_TESTS and DATABASE_URL", () => {});
  });
} else {
  describe("slug routing (postgres)", async () => {
    const { createDb } = await import("@meridian/database");
    const schema = await import("@meridian/database/schema");
    const { createDrizzleProjectRepository } = await import(
      "./adapters/project-repository/drizzle.js"
    );
    const { createDrizzleWorkRepository } = await import("./adapters/work-repository/drizzle.js");
    const { truncateDrizzleTables } = await import("../../test-support/drizzle-reset.js");

    const db = createDb(DATABASE_URL, { max: 4 });

    beforeEach(async () => {
      await truncateDrizzleTables(db, [schema.users, schema.projects, schema.works]);
    });
    afterAll(async () => db.$client.end());

    it("project findById on a non-UUID slug resolves to null", async () => {
      const repo = createDrizzleProjectRepository({ db });
      await expect(repo.findById("probe-rowmenu-not-a-uuid" as never)).resolves.toBeNull();
    });

    it("work findById on a non-UUID slug resolves to null", async () => {
      const repo = createDrizzleWorkRepository({ db });
      await expect(repo.findById("also-a-slug" as never)).resolves.toBeNull();
    });

    it("create and find accept canonical UUIDs regardless of version or variant bits", async () => {
      const userId = "93b1f764-1234-f678-0712-123456789ab0";
      const projectId = "93b1f764-1234-f678-0712-123456789ab1";
      const workId = "93b1f764-1234-9678-f712-123456789ab2";
      await db.insert(schema.users).values({
        id: userId,
        externalId: "slug-routing-uuid-grammar",
        email: "uuid-grammar@example.com",
      });

      const projects = createDrizzleProjectRepository({ db });
      const works = createDrizzleWorkRepository({ db });
      await projects.create({ id: projectId, userId, title: "UUID grammar" });
      await works.create({ id: workId, projectId, createdByUserId: userId, title: "Work" });

      await expect(projects.findById(projectId.toUpperCase() as never)).resolves.toMatchObject({
        id: projectId,
      });
      await expect(works.findById(workId as never)).resolves.toMatchObject({ id: workId });
    });
  });
}
