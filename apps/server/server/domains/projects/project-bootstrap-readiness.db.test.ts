/** Postgres coverage for bootstrap readiness fast and repair paths. */

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createTestWorkProjectionMutation } from "../../test-support/work-projection.js";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("project bootstrap readiness (postgres)", () => {});
} else {
  describe("project bootstrap readiness (postgres)", async () => {
    const { Hocuspocus } = await import("@hocuspocus/server");
    const { createDb } = await import("@meridian/database");
    const schema = await import("@meridian/database/schema");
    const { conformanceUserValues } = await import(
      "@meridian/database/__test-support__/db-fixtures"
    );
    const { createCollabDomain } = await import("../collab/composition.js");
    const { createDrizzleDocumentAccess } = await import("../../lib/document-access.js");
    const { createDrizzleProjectBootstrapRepository, createDrizzleProjectWorkAuthorityResolver } =
      await import("./index.js");
    const { truncateDrizzleTables } = await import("../../test-support/drizzle-reset.js");
    const { eq } = await import("drizzle-orm");
    const { default: postgres } = await import("postgres");

    const USER_ID = "00000000-0000-4000-8000-000000000358";
    const db = createDb(DATABASE_URL, { max: 4 });
    const lockClient = postgres(DATABASE_URL, { max: 1 });
    const probeClient = postgres(DATABASE_URL, { max: 1 });

    beforeEach(async () => {
      await truncateDrizzleTables(db, [schema.users]);
      await db.insert(schema.users).values(conformanceUserValues(USER_ID, "bootstrap-readiness"));
    });

    afterAll(async () => {
      await db.$client.end();
      await lockClient.end();
      await probeClient.end();
    });

    function createBoundCollab() {
      const collab = createCollabDomain({
        db,
        workProjectionMutation: createTestWorkProjectionMutation(db),
        workAuthorityResolver: createDrizzleProjectWorkAuthorityResolver(db),
        documentAccess: createDrizzleDocumentAccess(db),
      });
      const hocuspocus = new Hocuspocus({
        yDocOptions: { gc: false, gcFilter: () => true },
        onStoreDocument: ({ documentName, document }) =>
          collab.storeHocuspocusDocument(documentName, document),
      });
      collab.bindHocuspocus(hocuspocus);
      return collab;
    }

    it("provisions the cold path, then stays lock-free and out of collab when ready", async () => {
      const collab = createBoundCollab();
      let seedCalls = 0;
      const coldRepository = createDrizzleProjectBootstrapRepository({
        db,
        documents: {
          ...collab,
          async seedFromMarkdown(...args: Parameters<typeof collab.seedFromMarkdown>) {
            seedCalls += 1;
            return collab.seedFromMarkdown(...args);
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
          db.select({ id: schema.works.id }).from(schema.works),
          db.select({ id: schema.contextSources.id }).from(schema.contextSources),
          db.select({ id: schema.documents.id }).from(schema.documents),
          db.select({ id: schema.threads.id }).from(schema.threads),
        ]).then((rows) => rows.map((row) => row.length)),
      ).resolves.toEqual([1, 1, 3, 2, 0]);

      const [project] = await db
        .select({ ready: schema.projects.defaultBootstrapReady })
        .from(schema.projects);
      expect(project?.ready).toBe(true);

      let lockHeld = false;
      let probeLockAcquired = false;
      try {
        await lockClient`
          select pg_advisory_lock(hashtextextended(${USER_ID}, 0::bigint))
        `;
        lockHeld = true;
        const [competingLock] = await probeClient`
          select pg_try_advisory_lock(hashtextextended(${USER_ID}, 0::bigint)) as acquired
        `;
        probeLockAcquired = competingLock?.acquired === true;
        expect(competingLock?.acquired).toBe(false);

        const warmCall = coldRepository.ensureDefaultBootstrapReady(USER_ID as never);
        let watchdog: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            warmCall,
            new Promise<never>((_, reject) => {
              watchdog = setTimeout(
                () => reject(new Error("Ready bootstrap waited on advisory lock")),
                10_000,
              );
            }),
          ]);
        } finally {
          if (watchdog) clearTimeout(watchdog);
        }

        await expect(warmCall).resolves.toBe(true);
        expect(seedCalls).toBe(1);
      } finally {
        if (probeLockAcquired) {
          await probeClient`
            select pg_advisory_unlock(hashtextextended(${USER_ID}, 0::bigint))
          `;
        }
        if (lockHeld) {
          await lockClient`
            select pg_advisory_unlock(hashtextextended(${USER_ID}, 0::bigint))
          `;
        }
      }
    });

    it("isolates atomic bootstrap failure and provisions cleanly on a later request", async () => {
      const collab = createBoundCollab();
      const interrupted = createDrizzleProjectBootstrapRepository({
        db,
        documents: {
          ...collab,
          async seedFromMarkdown() {
            throw new Error("transient seed failure");
          },
        },
      });

      await expect(interrupted.ensureDefaultBootstrapReady(USER_ID as never)).resolves.toBe(false);
      await expect(db.select().from(schema.projects)).resolves.toHaveLength(0);
      await expect(db.select().from(schema.documents)).resolves.toHaveLength(0);

      const repaired = createDrizzleProjectBootstrapRepository({
        db,
        documents: collab,
      });
      await expect(repaired.ensureDefaultBootstrapReady(USER_ID as never)).resolves.toBe(true);

      const [ready] = await db
        .select({ ready: schema.projects.defaultBootstrapReady })
        .from(schema.projects);
      expect(ready?.ready).toBe(true);
      const [document] = await db
        .select({ id: schema.documents.id })
        .from(schema.documents)
        .where(eq(schema.documents.kind, "content"));
      expect(await collab.readAsMarkdown(document?.id as never)).toEqual({
        ok: true,
        value: "# Chapter 1\n",
      });
    });
  });
}
