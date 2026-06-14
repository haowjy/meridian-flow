// @ts-nocheck
/** Drizzle conformance tests for thread-upload backing documents against the real documents table constraints. */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  describe.skip("drizzle internal upload document store (postgres)", () => {
    it("requires DATABASE_URL", () => {});
  });
} else {
  describe("drizzle internal upload document store (postgres)", async () => {
    const { createDb } = await import("@meridian/database");
    const schema = await import("@meridian/database/schema");
    const { truncateDrizzleTables } = await import("../../../../../test-support/drizzle-reset.js");
    const { createDrizzleInternalUploadDocumentStore } = await import(
      "../internal-upload-document-store.js"
    );

    const db = createDb(DATABASE_URL, { max: 1 });

    beforeEach(async () => {
      await truncateDrizzleTables(db, [
        schema.documents,
        schema.folders,
        schema.contextSources,
        schema.projects,
        schema.authUsers,
      ]);
      await db.insert(schema.authUsers).values({
        id: "00000000-0000-4000-8000-000000000901",
      });
      await db.insert(schema.projects).values({
        id: "00000000-0000-4000-8000-000000000902",
        userId: "00000000-0000-4000-8000-000000000901",
        name: "Upload conformance",
        slug: "upload-conformance",
      });
    });

    afterAll(async () => {
      await db.close();
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
