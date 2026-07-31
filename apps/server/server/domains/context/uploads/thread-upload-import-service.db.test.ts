/** Postgres-backed proof that thread imports, uploads://, the rail, deletion, and image resolution agree. */

import { afterAll, beforeEach, describe, expect, it } from "vitest";

const DATABASE_URL = process.env.DATABASE_URL;
const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("work-scoped thread uploads (postgres)", () => {});
} else {
  describe("work-scoped thread uploads (postgres)", async () => {
    const schema = await import("@meridian/database/schema");
    const { createDb } = await import("@meridian/database");
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
    const db = createDb(DATABASE_URL, { max: 4 });

    beforeEach(async () => {
      await truncateDrizzleTables(db, [schema.users]);
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

    afterAll(async () => db.$client.end());

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

      const results = await Promise.all([imports.importUpload(input), imports.importUpload(input)]);
      const successful = results.flatMap((result) => (result.ok ? [result] : []));
      const first = successful.find((result) => result.value.name === "image");
      const second = successful.find((result) => result.value.name === "image-2");
      expect(first).toMatchObject({
        ok: true,
        value: { name: "image", extension: "png", fileType: "image" },
      });
      expect(second).toMatchObject({
        ok: true,
        value: { name: "image-2", extension: "png", fileType: "image" },
      });
      if (!first || !second) throw new Error("upload import failed");

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
        threadWorks: repos.threadWorks,
        objectStore,
        eventSink,
      });
      await expect(
        imageAssets.resolve(
          { projectId: PROJECT_ID, threadId: THREAD_ID },
          {
            type: "image_reference",
            documentId: first.value.documentId,
            uri: "uploads://image.png",
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

    it("rolls back the context document and attachment when rail confirmation fails", async () => {
      const repos = createDrizzleRepositories(db);
      const objectStore = createInMemoryObjectStore();
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
        uploadDocuments: {
          ...uploadDocuments,
          async getUpload() {
            return null;
          },
        },
        objectStore,
        eventSink: createInMemoryEventSink(),
      });

      await expect(
        imports.importUpload({
          projectId: PROJECT_ID,
          threadId: THREAD_ID,
          filename: "rollback.png",
          bytes: Uint8Array.from([137, 80, 78, 71]),
          mimeType: "image/png",
        }),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: "repository_error" },
      });
      const context = contextPorts.forWork(
        WORK_ID,
        PROJECT_ID,
        USER_ID,
        new Set([WORK_ID]),
        THREAD_ID,
      );
      await expect(context.list("uploads://")).resolves.toEqual({ ok: true, value: [] });
      await expect(repos.threadDocuments.listByThread(THREAD_ID)).resolves.toEqual([]);
      await expect(objectStore.list("uploads/")).resolves.toEqual({
        ok: true,
        value: { keys: [] },
      });
    });

    it("never lets failed-import cleanup delete a concurrent winner at the same path", async () => {
      const repos = createDrizzleRepositories(db);
      const objectStore = createInMemoryObjectStore();
      const contextPorts = createProductionUnifiedContextPortFactory({
        db,
        documentSync: {} as never,
        manifestMembership: {
          async recordManifestDocumentCreated() {},
          async recordManifestDocumentDeleted() {},
        },
      });
      const uploadDocuments = createDrizzleThreadUploadDocumentStore(db, repos.threadDocuments);
      let failedDocumentId: string | null = null;
      let enterFailure!: () => void;
      const failureEntered = new Promise<void>((resolve) => {
        enterFailure = resolve;
      });
      let releaseFailure!: () => void;
      const failureReleased = new Promise<void>((resolve) => {
        releaseFailure = resolve;
      });
      const failedImports = createThreadUploadImportService({
        repos,
        contextPorts,
        uploadDocuments: {
          ...uploadDocuments,
          async getUpload(_threadId, documentId) {
            failedDocumentId = documentId;
            enterFailure();
            await failureReleased;
            return null;
          },
        },
        objectStore,
        eventSink: createInMemoryEventSink(),
      });
      let enterWinnerWrite!: () => void;
      const winnerWriteEntered = new Promise<void>((resolve) => {
        enterWinnerWrite = resolve;
      });
      const winningContextPorts = {
        forProject: contextPorts.forProject.bind(contextPorts),
        forWork(...args: Parameters<typeof contextPorts.forWork>) {
          const port = contextPorts.forWork(...args);
          return {
            ...port,
            async writeBinary(...writeArgs: Parameters<typeof port.writeBinary>) {
              enterWinnerWrite();
              return port.writeBinary(...writeArgs);
            },
          };
        },
      };
      const winningImports = createThreadUploadImportService({
        repos,
        contextPorts: winningContextPorts,
        uploadDocuments,
        objectStore,
        eventSink: createInMemoryEventSink(),
      });
      const input = {
        projectId: PROJECT_ID,
        threadId: THREAD_ID,
        filename: "race.png",
        bytes: Uint8Array.from([137, 80, 78, 71]),
        mimeType: "image/png",
      };

      const failed = failedImports.importUpload(input);
      await failureEntered;
      const winning = winningImports.importUpload(input);
      await winnerWriteEntered;
      releaseFailure();
      const [failedResult, winningResult] = await Promise.all([failed, winning]);

      expect(failedResult).toMatchObject({
        ok: false,
        error: { code: "repository_error" },
      });
      expect(winningResult).toMatchObject({
        ok: true,
        value: { name: "race", extension: "png" },
      });
      if (!winningResult.ok) throw new Error("concurrent winner failed");
      expect(winningResult.value.documentId).not.toBe(failedDocumentId);
      await expect(uploadDocuments.listUploads(THREAD_ID)).resolves.toEqual([
        expect.objectContaining({
          documentId: winningResult.value.documentId,
          name: "race",
        }),
      ]);
      const context = contextPorts.forWork(
        WORK_ID,
        PROJECT_ID,
        USER_ID,
        new Set([WORK_ID]),
        THREAD_ID,
      );
      await expect(context.stat(`uploads://${WORK_ID}/race.png`)).resolves.toMatchObject({
        ok: true,
        value: { documentId: winningResult.value.documentId },
      });
      await expect(objectStore.list("uploads/")).resolves.toMatchObject({
        ok: true,
        value: { keys: [expect.objectContaining({ key: expect.any(String) })] },
      });
    });
  });
}
