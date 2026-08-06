/** Postgres coverage for Work handles, restore conflicts, and durable-content deletion guards. */
import { setTimeout as delay } from "node:timers/promises";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;

const USER_ID = "00000000-0000-4000-8000-000000000841";
const PROJECT_ID = "00000000-0000-4000-8000-000000000842";

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("Work repository lifecycle (postgres)", () => {});
} else {
  describe("Work repository lifecycle (postgres)", async () => {
    const { createDb } = await import("@meridian/database");
    const schema = await import("@meridian/database/schema");
    const { assertThrowawayDatabaseForRunDbTests, conformanceUserValues } = await import(
      "@meridian/database/__test-support__/db-fixtures"
    );
    const { truncateDrizzleTables } = await import("../../test-support/drizzle-reset.js");
    const { createDrizzleProjectWorkRepository, WorkDeleteBlockedError, WorkRestoreConflictError } =
      await import("./index.js");

    assertThrowawayDatabaseForRunDbTests(DATABASE_URL);
    const db = createDb(DATABASE_URL, { max: 4 });
    const control = postgres(DATABASE_URL, { max: 1 });
    const works = createDrizzleProjectWorkRepository({
      db,
      hasUnreviewedDraft: async () => false,
    });

    beforeEach(async () => {
      await truncateDrizzleTables(db, [schema.users]);
      await db.insert(schema.users).values(conformanceUserValues(USER_ID, "work-repository"));
      await db.insert(schema.projects).values({
        id: PROJECT_ID,
        userId: USER_ID,
        name: "Work Repository",
        slug: "work-repository",
      });
    });

    afterAll(async () => {
      await control.end();
      await db.close();
    });

    async function waitForLock(waitEvent: string, minimum = 1): Promise<void> {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const [row] = await control<{ count: string }[]>`
          SELECT count(*)::text AS count
          FROM pg_stat_activity
          WHERE datname = current_database()
            AND wait_event = ${waitEvent}
        `;
        if (Number(row?.count ?? 0) >= minimum) return;
        await delay(10);
      }
      throw new Error(`Timed out waiting for ${minimum} PostgreSQL ${waitEvent} lock(s)`);
    }

    it("generates deduplicated handles and keeps them through rename", async () => {
      const first = await works.create({ projectId: PROJECT_ID, name: "Book 2!" });
      const second = await works.create({ projectId: PROJECT_ID, name: "Book 2?" });
      const symbols = await works.create({ projectId: PROJECT_ID, name: "!!!" });

      expect([first.slug, second.slug, symbols.slug]).toEqual(["book-2", "book-2-2", "work"]);
      await expect(works.update(first.id, { name: "Renamed" })).resolves.toMatchObject({
        slug: "book-2",
      });
    });

    it("restores a deleted Work unless its name or slug was reclaimed", async () => {
      const available = await works.create({ projectId: PROJECT_ID, name: "Available" });
      await works.softDelete(available.id);
      await expect(works.restore(available.id)).resolves.toMatchObject({ deletedAt: null });

      const nameOwner = await works.create({ projectId: PROJECT_ID, name: "Reclaimed" });
      await works.softDelete(nameOwner.id);
      await works.create({ projectId: PROJECT_ID, name: "Reclaimed" });
      await expect(works.restore(nameOwner.id)).rejects.toEqual(
        new WorkRestoreConflictError("name"),
      );

      const slugOwner = await works.create({ projectId: PROJECT_ID, name: "Same slug!" });
      await works.softDelete(slugOwner.id);
      await works.create({ projectId: PROJECT_ID, name: "Same slug?" });
      await expect(works.restore(slugOwner.id)).rejects.toEqual(
        new WorkRestoreConflictError("slug"),
      );
    });

    it("allows empty provisioned context sources but blocks live files", async () => {
      const empty = await works.create({ projectId: PROJECT_ID, name: "Empty source" });
      await db.insert(schema.contextSources).values({
        workId: empty.id,
        name: "Scratch",
        slug: "scratch",
        scope: "work",
      });
      await expect(works.softDelete(empty.id)).resolves.toBeUndefined();

      const withFile = await works.create({ projectId: PROJECT_ID, name: "With file" });
      const [source] = await db
        .insert(schema.contextSources)
        .values({ workId: withFile.id, name: "Uploads", slug: "uploads", scope: "work" })
        .returning();
      if (!source) throw new Error("Expected context source");
      await db.insert(schema.documents).values({
        contextSourceId: source.id,
        name: "reference",
      });
      await db
        .update(schema.contextSources)
        .set({ deletedAt: new Date() })
        .where(eq(schema.contextSources.id, source.id));

      await expect(works.softDelete(withFile.id)).rejects.toEqual(
        new WorkDeleteBlockedError("documents"),
      );
    });

    it("blocks live folders but ignores soft-deleted context content", async () => {
      const work = await works.create({ projectId: PROJECT_ID, name: "Folders" });
      const [source] = await db
        .insert(schema.contextSources)
        .values({ workId: work.id, name: "Scratch", slug: "scratch", scope: "work" })
        .returning();
      if (!source) throw new Error("Expected context source");
      const [folder] = await db
        .insert(schema.folders)
        .values({ contextSourceId: source.id, name: "Notes" })
        .returning();
      if (!folder) throw new Error("Expected folder");

      await expect(works.softDelete(work.id)).rejects.toEqual(
        new WorkDeleteBlockedError("folders"),
      );
      await db.update(schema.folders).set({ deletedAt: new Date() });
      await expect(works.softDelete(work.id)).resolves.toBeUndefined();
    });

    it("serializes named and default creation on one project lock", async () => {
      const insertBarrier = 748_210_842;
      await control.unsafe(`
        CREATE FUNCTION test_block_work_insert() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
          PERFORM pg_advisory_xact_lock(${insertBarrier});
          RETURN NEW;
        END;
        $$;
        CREATE TRIGGER test_block_work_insert
        BEFORE INSERT ON works
        FOR EACH ROW EXECUTE FUNCTION test_block_work_insert();
      `);
      await control`SELECT pg_advisory_lock(${insertBarrier})`;
      let barrierHeld = true;

      try {
        const named = works.create({ projectId: PROJECT_ID, name: "Book 1" });
        await waitForLock("advisory");
        const defaulted = works.ensureDefaultForProject(PROJECT_ID, "Book 1");
        await waitForLock("advisory", 2);

        await control`SELECT pg_advisory_unlock(${insertBarrier})`;
        barrierHeld = false;
        const [namedWork, defaultWork] = await Promise.all([named, defaulted]);

        expect(defaultWork.id).toBe(namedWork.id);
        await expect(works.listByProject(PROJECT_ID)).resolves.toHaveLength(1);
      } finally {
        if (barrierHeld) await control`SELECT pg_advisory_unlock(${insertBarrier})`;
        await control.unsafe(`
          DROP TRIGGER IF EXISTS test_block_work_insert ON works;
          DROP FUNCTION IF EXISTS test_block_work_insert();
        `);
      }
    });

    it("serializes Work content creation before deletion", async () => {
      const insertBarrier = 748_210_843;
      const work = await works.create({ projectId: PROJECT_ID, name: "Creation race" });
      const { createWorkContextDocumentStore } = await import("../context/index.js");
      const store = createWorkContextDocumentStore(db, work.id, "uploads");
      await control.unsafe(`
        CREATE FUNCTION test_block_work_document_insert() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
          PERFORM pg_advisory_xact_lock(${insertBarrier});
          RETURN NEW;
        END;
        $$;
        CREATE TRIGGER test_block_work_document_insert
        BEFORE INSERT ON documents
        FOR EACH ROW EXECUTE FUNCTION test_block_work_document_insert();
      `);
      await control`SELECT pg_advisory_lock(${insertBarrier})`;
      let barrierHeld = true;

      try {
        const creation = store.createBinaryDocument({
          folderId: null,
          name: "reference",
          extension: "pdf",
          fileType: "pdf",
          storageUrl: "s3://test/reference.pdf",
          mimeType: "application/pdf",
          sizeBytes: 42,
        });
        await waitForLock("advisory");
        const deletion = works.softDelete(work.id).then(
          () => ({ status: "fulfilled" as const }),
          (reason: unknown) => ({ status: "rejected" as const, reason }),
        );
        await waitForLock("transactionid");

        await control`SELECT pg_advisory_unlock(${insertBarrier})`;
        barrierHeld = false;
        await creation;
        const result = await deletion;

        expect(result.status).toBe("rejected");
        if (result.status === "rejected") {
          expect(result.reason).toEqual(new WorkDeleteBlockedError("documents"));
        }
        await expect(works.findById(work.id)).resolves.toMatchObject({ deletedAt: null });
      } finally {
        if (barrierHeld) await control`SELECT pg_advisory_unlock(${insertBarrier})`;
        await control.unsafe(`
          DROP TRIGGER IF EXISTS test_block_work_document_insert ON documents;
          DROP FUNCTION IF EXISTS test_block_work_document_insert();
        `);
      }
    });
  });
}
