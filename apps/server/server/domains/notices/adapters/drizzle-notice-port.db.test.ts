/** Postgres coverage for safety-notice fan-out and destructive drains. */

import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;

const USER_ID = "00000000-0000-4000-8000-000000000301";
const PROJECT_ID = "00000000-0000-4000-8000-000000000302";
const CONTEXT_SOURCE_ID = "00000000-0000-4000-8000-000000000303";
const DOCUMENT_ID = "00000000-0000-4000-8000-000000000304";
const THREAD_ID = "00000000-0000-4000-8000-000000000305";
const OTHER_THREAD_ID = "00000000-0000-4000-8000-000000000306";
const TURN_ID = "00000000-0000-4000-8000-000000000307";
const OTHER_TURN_ID = "00000000-0000-4000-8000-000000000308";

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("drizzle notice port (postgres)", () => {
    it("requires RUN_DB_TESTS and DATABASE_URL", () => {});
  });
} else {
  describe("drizzle notice port (postgres)", async () => {
    const schema = await import("@meridian/database/schema");
    const { assertThrowawayDatabaseForRunDbTests, conformanceUserValues } = await import(
      "@meridian/database/__test-support__/db-fixtures"
    );
    const { useRollbackTestDatabase } = await import(
      "../../../test-support/rollback-test-database.js"
    );
    const { truncateDrizzleTables } = await import("../../../test-support/drizzle-reset.js");
    const { createDrizzleNoticePort } = await import("./drizzle-notice-port.js");
    const { createDrizzleRepositories } = await import("../../threads/adapters/drizzle/index.js");
    const { createActiveDocumentResolver } = await import(
      "../../threads/domain/active-document-resolver.js"
    );

    assertThrowawayDatabaseForRunDbTests(DATABASE_URL);
    const database = useRollbackTestDatabase(DATABASE_URL, {
      max: 1,
      prepareSuite: (db) => truncateDrizzleTables(db, [schema.users]),
    });
    let db = database.current;
    let threadRepos = createDrizzleRepositories(db);
    let activeDocuments = createActiveDocumentResolver(threadRepos);

    beforeEach(async () => {
      db = database.current;
      threadRepos = createDrizzleRepositories(db);
      activeDocuments = createActiveDocumentResolver(threadRepos);
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

    it("fans a document-scoped notice out to both active threads", async () => {
      const port = createDrizzleNoticePort(db, activeDocuments);
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

    it("delivers an existing document notice to a thread attached after recording", async () => {
      await db
        .delete(schema.threadDocuments)
        .where(eq(schema.threadDocuments.threadId, OTHER_THREAD_ID));
      const port = createDrizzleNoticePort(db, activeDocuments);
      await port.record({
        kind: "checkpoint_sweep",
        scope: { kind: "document", documentId: DOCUMENT_ID },
        message: "Checkpoint content was discarded",
        data: {
          documentId: DOCUMENT_ID,
          affectedBlockHashes: ["hash-a"],
          capturedDeletedBodies: [{ hash: "hash-a", body: "Writer paragraph." }],
        },
        writerVisible: false,
      });
      await expect(port.drainForModelContext(THREAD_ID, [DOCUMENT_ID])).resolves.toHaveLength(1);

      await db.insert(schema.threadDocuments).values({
        threadId: OTHER_THREAD_ID,
        documentId: DOCUMENT_ID,
        relationship: "editing",
      });
      await expect(port.drainForModelContext(OTHER_THREAD_ID, [DOCUMENT_ID])).resolves.toHaveLength(
        1,
      );
    });

    it("emits a display-ready writer event and drains it independently", async () => {
      const port = createDrizzleNoticePort(db, activeDocuments);
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

    it("retains a document notice when the writer drains before its active model thread", async () => {
      await db.delete(schema.threadDocuments);
      await threadRepos.turns.create({ id: TURN_ID, threadId: THREAD_ID, role: "assistant" });
      await threadRepos.documentTouches.recordTouch(TURN_ID, DOCUMENT_ID);
      const port = createDrizzleNoticePort(db, activeDocuments);
      await port.record({
        kind: "late_sweep",
        scope: { kind: "document", documentId: DOCUMENT_ID },
        message: "Content was modified — View change",
        data: {
          documentId: DOCUMENT_ID,
          affectedBlockHashes: ["hash-a"],
          capturedDeletedBodies: [{ hash: "hash-a", body: "Writer paragraph." }],
        },
        writerVisible: true,
      });

      await expect(port.drainForWriter(DOCUMENT_ID)).resolves.toHaveLength(1);
      const activeDocumentIds = await activeDocuments.listDocumentIds(THREAD_ID);
      await expect(port.drainForModelContext(THREAD_ID, activeDocumentIds)).resolves.toMatchObject([
        {
          kind: "late_sweep",
          data: { capturedDeletedBodies: [{ hash: "hash-a", body: "Writer paragraph." }] },
        },
      ]);
      await expect(port.drainForModelContext(THREAD_ID, activeDocumentIds)).resolves.toEqual([]);
      await expect(db.select().from(schema.pendingNotices)).resolves.toEqual([]);
    });

    it("retains a writer-first document notice for a second thread that touches it later", async () => {
      await db.delete(schema.threadDocuments);
      await threadRepos.turns.create({ id: TURN_ID, threadId: THREAD_ID, role: "assistant" });
      await threadRepos.documentTouches.recordTouch(TURN_ID, DOCUMENT_ID);
      const port = createDrizzleNoticePort(db, activeDocuments);
      await port.record({
        kind: "late_sweep",
        scope: { kind: "document", documentId: DOCUMENT_ID },
        message: "Content was modified — View change",
        data: {
          documentId: DOCUMENT_ID,
          affectedBlockHashes: ["hash-a"],
          capturedDeletedBodies: [{ hash: "hash-a", body: "Writer paragraph." }],
        },
        writerVisible: true,
      });
      await expect(port.drainForWriter(DOCUMENT_ID)).resolves.toHaveLength(1);

      await threadRepos.turns.create({
        id: OTHER_TURN_ID,
        threadId: OTHER_THREAD_ID,
        role: "assistant",
      });
      await threadRepos.documentTouches.recordTouch(OTHER_TURN_ID, DOCUMENT_ID);

      for (const threadId of [THREAD_ID, OTHER_THREAD_ID]) {
        const activeDocumentIds = await activeDocuments.listDocumentIds(threadId);
        await expect(port.drainForModelContext(threadId, activeDocumentIds)).resolves.toMatchObject(
          [
            {
              kind: "late_sweep",
              data: { capturedDeletedBodies: [{ hash: "hash-a", body: "Writer paragraph." }] },
            },
          ],
        );
        await expect(port.drainForModelContext(threadId, activeDocumentIds)).resolves.toEqual([]);
      }
      await expect(db.select().from(schema.pendingNotices)).resolves.toEqual([]);
    });

    it("records inside an ambient Drizzle transaction", async () => {
      const { runInDrizzleTransaction } = await import("../../../shared/drizzle-transaction.js");
      const port = createDrizzleNoticePort(db, activeDocuments);
      await expect(
        runInDrizzleTransaction(db, async () => {
          await port.record({
            kind: "awareness_degraded",
            scope: { kind: "thread", threadId: THREAD_ID },
            message: "Document awareness degraded",
            data: { documentIds: [DOCUMENT_ID] },
            writerVisible: false,
          });
          throw new Error("roll back response transaction");
        }),
      ).rejects.toThrow("roll back response transaction");

      await expect(db.select().from(schema.pendingNotices)).resolves.toEqual([]);
    });
  });
}
