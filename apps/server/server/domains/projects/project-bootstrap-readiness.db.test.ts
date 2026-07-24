/** Postgres coverage for the default-workspace readiness fast and repair paths. */

import { afterAll, beforeEach, describe, expect, it } from "vitest";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("project bootstrap readiness (postgres)", () => {
    it("requires RUN_DB_TESTS and DATABASE_URL", () => {});
  });
} else {
  describe("project bootstrap readiness (postgres)", async () => {
    const { Hocuspocus } = await import("@hocuspocus/server");
    const { createDb } = await import("@meridian/database");
    const schema = await import("@meridian/database/schema");
    const { conformanceUserValues } = await import(
      "@meridian/database/__test-support__/db-fixtures"
    );
    const { createCollabDomain } = await import("../collab/composition.js");
    const { createDrizzleProjectBootstrapRepository } = await import("./index.js");
    const { truncateDrizzleTables } = await import("../../test-support/drizzle-reset.js");
    const { eq } = await import("drizzle-orm");
    const { default: postgres } = await import("postgres");

    const USER_ID = "00000000-0000-4000-8000-000000000358";
    const db = createDb(DATABASE_URL, { max: 4 });
    const lockClient = postgres(DATABASE_URL, { max: 1 });

    beforeEach(async () => {
      await truncateDrizzleTables(db, [schema.users]);
      await db.insert(schema.users).values(conformanceUserValues(USER_ID, "bootstrap-readiness"));
    });

    afterAll(async () => {
      await db.$client.end();
      await lockClient.end();
    });

    function createBoundCollab() {
      const collab = createCollabDomain({ db, threads: { findById: async () => null } });
      const hocuspocus = new Hocuspocus({
        yDocOptions: { gc: false, gcFilter: () => true },
        onStoreDocument: ({ documentName, document }) =>
          collab.storeHocuspocusDocument(documentName, document),
      });
      collab.bindHocuspocus(hocuspocus);
      return collab;
    }

    it("provisions the cold path, then stays lock-free and out of collab when ready", async () => {
      let seedCalls = 0;
      const coldRepository = createDrizzleProjectBootstrapRepository({
        db,
        documents: {
          async seedFromMarkdown() {
            seedCalls += 1;
            return { ok: true, value: null };
          },
        },
      });

      await expect(coldRepository.ensureDefaultBootstrapReady(USER_ID as never)).resolves.toBe(
        true,
      );
      expect(seedCalls).toBe(1);
      await expect(
        Promise.all([
          db.select({ id: schema.projects.id }).from(schema.projects),
          db.select({ id: schema.agentDefinitions.id }).from(schema.agentDefinitions),
          db.select({ id: schema.works.id }).from(schema.works),
          db.select({ id: schema.contextSources.id }).from(schema.contextSources),
          db.select({ id: schema.documents.id }).from(schema.documents),
          db.select({ id: schema.threads.id }).from(schema.threads),
        ]).then((rows) => rows.map((row) => row.length)),
      ).resolves.toEqual([1, 1, 1, 1, 1, 1]);

      const [project] = await db
        .select({ ready: schema.projects.defaultBootstrapReady })
        .from(schema.projects);
      expect(project?.ready).toBe(true);

      let warmSeedCalls = 0;
      const warmRepository = createDrizzleProjectBootstrapRepository({
        db,
        documents: {
          async seedFromMarkdown() {
            warmSeedCalls += 1;
            return { ok: true, value: null };
          },
        },
      });

      await lockClient`
        select pg_advisory_lock(hashtextextended(${USER_ID}, 0::bigint))
      `;
      const warmCall = warmRepository.ensureDefaultBootstrapReady(USER_ID as never);
      try {
        const outcome = await Promise.race([
          warmCall.then(() => "completed" as const),
          new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 250)),
        ]);
        expect(outcome).toBe("completed");
      } finally {
        await lockClient`
          select pg_advisory_unlock(hashtextextended(${USER_ID}, 0::bigint))
        `;
      }

      await expect(warmCall).resolves.toBe(true);
      expect(warmSeedCalls).toBe(0);
    });

    it("isolates seed failure and repairs canonical authority on a later request", async () => {
      const interrupted = createDrizzleProjectBootstrapRepository({
        db,
        documents: {
          async seedFromMarkdown() {
            throw new Error("transient seed failure");
          },
        },
      });

      await expect(interrupted.ensureDefaultBootstrapReady(USER_ID as never)).resolves.toBe(false);
      const [unready] = await db
        .select({
          id: schema.projects.id,
          ready: schema.projects.defaultBootstrapReady,
        })
        .from(schema.projects);
      expect(unready).toMatchObject({ ready: false });

      const collab = createBoundCollab();
      const repaired = createDrizzleProjectBootstrapRepository({
        db,
        documents: collab,
      });
      await expect(repaired.ensureDefaultBootstrapReady(USER_ID as never)).resolves.toBe(true);

      const [ready] = await db
        .select({ ready: schema.projects.defaultBootstrapReady })
        .from(schema.projects)
        .where(eq(schema.projects.id, unready?.id as never));
      expect(ready?.ready).toBe(true);
      const [document] = await db.select({ id: schema.documents.id }).from(schema.documents);
      expect(await collab.readAsMarkdown(document?.id as never)).toEqual({
        ok: true,
        value: "# Chapter 1\n",
      });
    });
  });
}
