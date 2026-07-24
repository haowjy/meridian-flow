/** Drizzle conformance tests for thread-upload backing documents against the real documents table constraints. */
import { beforeEach, describe, expect, it } from "vitest";

const DATABASE_URL = process.env.DATABASE_URL;
const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("drizzle internal upload document store (postgres)", () => {
    it("requires DATABASE_URL", () => {});
  });
} else {
  describe("drizzle internal upload document store (postgres)", async () => {
    const schema = await import("@meridian/database/schema");
    const { useRollbackTestDatabase } = await import(
      "../../../../../test-support/rollback-test-database.js"
    );
    const { truncateDrizzleTables } = await import("../../../../../test-support/drizzle-reset.js");
    const { createDrizzleInternalUploadDocumentStore } = await import(
      "../internal-upload-document-store.js"
    );

    const database = useRollbackTestDatabase(DATABASE_URL, {
      max: 1,
      prepareSuite: (db) => truncateDrizzleTables(db, [schema.users]),
    });
    let db = database.current;

    beforeEach(async () => {
      db = database.current;
      const { conformanceUserValues } = await import(
        "@meridian/database/__test-support__/db-fixtures"
      );
      await db
        .insert(schema.users)
        .values(
          conformanceUserValues("00000000-0000-4000-8000-000000000901", "upload-conformance"),
        );
      await db.insert(schema.projects).values({
        id: "00000000-0000-4000-8000-000000000902",
        userId: "00000000-0000-4000-8000-000000000901",
        name: "Upload conformance",
        slug: "upload-conformance",
      });
    });

    it("persists generic binary uploads through the real documents.file_type constraint", async () => {
      const store = createDrizzleInternalUploadDocumentStore(db);

      const row = await store.createThreadUploadDocument({
        id: "00000000-0000-4000-8000-000000000903",
        projectId: "00000000-0000-4000-8000-000000000902",
        threadId: "00000000-0000-4000-8000-000000000904",
        filename: "probe.bin",
        name: "probe",
        extension: "bin",
        filetype: null,
        mimeType: "application/octet-stream",
        sizeBytes: 15,
        markdownProjection: "",
        storageUrl: "object://meridian/uploads/project/thread/document/bin",
      });

      expect(row).toMatchObject({
        id: "00000000-0000-4000-8000-000000000903",
        fileType: "binary",
        mimeType: "application/octet-stream",
        storageUrl: "object://meridian/uploads/project/thread/document/bin",
      });
    });
  });
}
