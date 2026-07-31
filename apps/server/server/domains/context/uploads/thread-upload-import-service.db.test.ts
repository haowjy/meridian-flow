/** Postgres-backed proof that thread imports, uploads://, the rail, deletion, and image resolution agree. */

import { beforeEach, describe, expect, it } from "vitest";

const DATABASE_URL = process.env.DATABASE_URL;
const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("work-scoped thread uploads (postgres)", () => {});
} else {
  describe("work-scoped thread uploads (postgres)", async () => {
    const schema = await import("@meridian/database/schema");
    const { conformanceUserValues } = await import(
      "@meridian/database/__test-support__/db-fixtures"
    );
    const { createDrizzleFigureDocumentRepository } = await import(
      "../adapters/figures/drizzle-figure-document-repository.js"
    );
    const { createContextImageAssetAdapter } = await import(
      "../../runtime/adapters/context-image-assets.js"
    );
    const { createInMemoryEventSink } = await import("../../observability/index.js");
    const { createInMemoryObjectStore } = await import("../../storage/index.js");
    const { createDrizzleRepositories } = await import("../../threads/adapters/drizzle/index.js");
    const { useRollbackTestDatabase } = await import(
      "../../../test-support/rollback-test-database.js"
    );
    const { truncateDrizzleTables } = await import("../../../test-support/drizzle-reset.js");
    const { createProductionUnifiedContextPortFactory } = await import(
      "../unified-context-port-factory.js"
    );
    const { deleteThreadUpload } = await import("./thread-upload-delete-service.js");
    const { createDrizzleThreadUploadDocumentStore } = await import("./thread-upload-documents.js");
    const { createThreadUploadImportService } = await import("./thread-upload-import-service.js");

    const USER_ID = "00000000-0000-4000-8000-000000000b01";
    const PROJECT_ID = "00000000-0000-4000-8000-000000000b02";
    const WORK_ID = "00000000-0000-4000-8000-000000000b03";
    const THREAD_ID = "00000000-0000-4000-8000-000000000b04";
    const database = useRollbackTestDatabase(DATABASE_URL, {
      max: 4,
      prepareSuite: (db) => truncateDrizzleTables(db, [schema.users]),
    });
    let db = database.current;

    beforeEach(async () => {
      db = database.current;
      await db.insert(schema.users).values(conformanceUserValues(USER_ID, "work-upload"));
      await db.insert(schema.projects).values({
        id: PROJECT_ID,
        userId: USER_ID,
        name: "Work upload",
        slug: "work-upload",
      });
      await db.insert(schema.works).values({
        id: WORK_ID,
        projectId: PROJECT_ID,
        createdByUserId: USER_ID,
        title: "Work upload",
      });
      await db.insert(schema.threads).values({
        id: THREAD_ID,
        projectId: PROJECT_ID,
        createdByUserId: USER_ID,
        title: "Work upload",
      });
      await db.insert(schema.threadWorks).values({
        threadId: THREAD_ID,
        workId: WORK_ID,
        projectId: PROJECT_ID,
        isPrimary: true,
      });
    });

    it("imports into uploads://, suffixes collisions, resolves images, and soft-deletes by attachment", async () => {
      const repos = createDrizzleRepositories(db);
      const objectStore = createInMemoryObjectStore();
      const eventSink = createInMemoryEventSink();
      const contextPorts = createProductionUnifiedContextPortFactory({
        db,
        documentSync: {} as never,
        manifestMembership: {
          async recordManifestDocumentCreated() {},
          async recordManifestDocumentDeleted() {},
        },
      });
      const uploadDocuments = createDrizzleThreadUploadDocumentStore(db, repos.threadDocuments);
      const imports = createThreadUploadImportService({
        repos,
        contextPorts,
        uploadDocuments,
        objectStore,
        eventSink,
      });
      const input = {
        projectId: PROJECT_ID,
        threadId: THREAD_ID,
        filename: "image.png",
        bytes: Uint8Array.from([137, 80, 78, 71]),
        mimeType: "image/png",
      };

      const first = await imports.importUpload(input);
      const second = await imports.importUpload(input);
      expect(first).toMatchObject({
        ok: true,
        value: { name: "image", extension: "png", fileType: "image" },
      });
      expect(second).toMatchObject({
        ok: true,
        value: { name: "image-2", extension: "png", fileType: "image" },
      });
      if (!first.ok || !second.ok) throw new Error("upload import failed");

      const context = contextPorts.forWork(
        WORK_ID,
        PROJECT_ID,
        USER_ID,
        new Set([WORK_ID]),
        THREAD_ID,
      );
      const listed = await context.list("uploads://");
      expect(listed).toMatchObject({
        ok: true,
        value: [
          {
            documentId: first.value.documentId,
            uri: `uploads://${WORK_ID}/image.png`,
          },
          {
            documentId: second.value.documentId,
            uri: `uploads://${WORK_ID}/image-2.png`,
          },
        ],
      });
      await expect(uploadDocuments.listUploads(THREAD_ID)).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ documentId: first.value.documentId, name: "image" }),
          expect.objectContaining({ documentId: second.value.documentId, name: "image-2" }),
        ]),
      );

      const imageAssets = createContextImageAssetAdapter({
        figures: createDrizzleFigureDocumentRepository({ db }),
        uploads: uploadDocuments,
        objectStore,
        eventSink,
      });
      await expect(
        imageAssets.resolve(
          { projectId: PROJECT_ID, threadId: THREAD_ID },
          {
            type: "image_reference",
            documentId: first.value.documentId,
            uri: `uploads://${WORK_ID}/image.png`,
          },
          { maxBytes: 1024 },
        ),
      ).resolves.toEqual({
        mediaType: "image/png",
        data: "iVBORw==",
        sizeBytes: 4,
      });

      await expect(
        deleteThreadUpload(
          { repos, contextPorts, uploadDocuments },
          { threadId: THREAD_ID, documentId: first.value.documentId, userId: USER_ID },
        ),
      ).resolves.toEqual({ ok: true });
      await expect(context.stat(`uploads://${WORK_ID}/image.png`)).resolves.toMatchObject({
        ok: false,
        error: { code: "not_found" },
      });
      await expect(uploadDocuments.listUploads(THREAD_ID)).resolves.toEqual([
        expect.objectContaining({ documentId: second.value.documentId, name: "image-2" }),
      ]);
      await expect(repos.threadDocuments.listByThread(THREAD_ID)).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ documentId: first.value.documentId }),
          expect.objectContaining({ documentId: second.value.documentId }),
        ]),
      );
    });
  });
}
