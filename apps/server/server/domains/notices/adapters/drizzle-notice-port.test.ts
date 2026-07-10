/** Postgres coverage for safety-notice fan-out and destructive drains. */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;

const USER_ID = "00000000-0000-4000-8000-000000000301";
const PROJECT_ID = "00000000-0000-4000-8000-000000000302";
const CONTEXT_SOURCE_ID = "00000000-0000-4000-8000-000000000303";
const DOCUMENT_ID = "00000000-0000-4000-8000-000000000304";
const THREAD_ID = "00000000-0000-4000-8000-000000000305";
const OTHER_THREAD_ID = "00000000-0000-4000-8000-000000000306";

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("drizzle notice port (postgres)", () => {
    it("requires RUN_DB_TESTS and DATABASE_URL", () => {});
  });
} else {
  describe("drizzle notice port (postgres)", async () => {
    const { createDb } = await import("@meridian/database");
    const schema = await import("@meridian/database/schema");
    const { assertThrowawayDatabaseForRunDbTests, conformanceUserValues } = await import(
      "@meridian/database/__test-support__/db-fixtures"
    );
    const { truncateDrizzleTables } = await import("../../../test-support/drizzle-reset.js");
    const { createDrizzleNoticePort } = await import("./drizzle-notice-port.js");

    assertThrowawayDatabaseForRunDbTests(DATABASE_URL);
    const db = createDb(DATABASE_URL, { max: 1 });

    beforeEach(async () => {
      await truncateDrizzleTables(db, [
        schema.pendingNoticeDeliveries,
        schema.pendingNotices,
        schema.threadDocuments,
        schema.threads,
        schema.documents,
        schema.contextSources,
        schema.projects,
        schema.users,
      ]);
      await db.insert(schema.users).values(conformanceUserValues(USER_ID, "pending-notices"));
      await db.insert(schema.projects).values({
        id: PROJECT_ID,
        userId: USER_ID,
        name: "Notice Project",
        slug: "notice-project",
      });
      await db.insert(schema.contextSources).values({
        id: CONTEXT_SOURCE_ID,
        projectId: PROJECT_ID,
        name: "Manuscript",
        slug: "manuscript",
        scope: "project",
      });
      await db.insert(schema.documents).values({
        id: DOCUMENT_ID,
        contextSourceId: CONTEXT_SOURCE_ID,
        name: "chapter-one",
      });
      await db.insert(schema.threads).values([
        {
          id: THREAD_ID,
          projectId: PROJECT_ID,
          createdByUserId: USER_ID,
          title: "Thread",
          kind: "primary",
          status: "idle",
        },
        {
          id: OTHER_THREAD_ID,
          projectId: PROJECT_ID,
          createdByUserId: USER_ID,
          title: "Other Thread",
          kind: "primary",
          status: "idle",
        },
      ]);
      await db.insert(schema.threadDocuments).values([
        { threadId: THREAD_ID, documentId: DOCUMENT_ID, relationship: "editing" },
        { threadId: OTHER_THREAD_ID, documentId: DOCUMENT_ID, relationship: "editing" },
      ]);
    });

    afterAll(async () => {
      await db.close();
    });

    it("fans a document-scoped notice out to both active threads", async () => {
      const port = createDrizzleNoticePort(db);
      const writerListener = vi.fn();
      port.subscribeWriterVisible(writerListener);
      await port.record({
        kind: "checkpoint_sweep",
        scope: { kind: "document", documentId: DOCUMENT_ID },
        message: "Checkpoint content was discarded",
        data: {
          documentId: DOCUMENT_ID,
          affectedBlockHashes: ["hash-a"],
          capturedDeletedBodies: [{ hash: "hash-a", body: "Writer paragraph." }],
          beforeContentRef: 42,
        },
        writerVisible: true,
      });

      await expect(port.drainForModelContext(THREAD_ID, [DOCUMENT_ID])).resolves.toMatchObject([
        { kind: "checkpoint_sweep" },
      ]);
      await expect(
        port.drainForModelContext(OTHER_THREAD_ID, [DOCUMENT_ID]),
      ).resolves.toMatchObject([{ kind: "checkpoint_sweep" }]);
      await expect(port.drainForModelContext(THREAD_ID, [DOCUMENT_ID])).resolves.toEqual([]);
      expect(writerListener).toHaveBeenCalledWith(
        expect.objectContaining({ documentId: DOCUMENT_ID, kind: "checkpoint_sweep" }),
      );
      await expect(port.drainForWriter(DOCUMENT_ID)).resolves.toMatchObject([
        { kind: "checkpoint_sweep" },
      ]);
    });

    it("emits a display-ready writer event and drains it independently", async () => {
      const port = createDrizzleNoticePort(db);
      const listener = vi.fn();
      port.subscribeWriterVisible(listener);

      await port.record({
        kind: "late_sweep",
        scope: { kind: "thread", threadId: THREAD_ID },
        message: "Content was modified — View change",
        data: {
          documentId: DOCUMENT_ID,
          affectedBlockHashes: ["hash-a"],
          capturedDeletedBodies: [{ hash: "hash-a", body: "Writer paragraph." }],
          beforeContentRef: 42,
        },
        writerVisible: true,
      });

      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          documentId: DOCUMENT_ID,
          kind: "late_sweep",
          message: "Content was modified — View change",
        }),
      );
      await expect(port.drainForWriter(DOCUMENT_ID)).resolves.toMatchObject([
        { kind: "late_sweep" },
      ]);
      await expect(port.drainForWriter(DOCUMENT_ID)).resolves.toEqual([]);
    });
  });
}
