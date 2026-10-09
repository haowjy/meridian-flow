/**
 * Production-composed model undo and redo of writes that went live (D19):
 * their history is the live journal, since no thread-peer branch exists.
 * Before the fix every live undo failed with `internal_error`.
 */

import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { writeMarkdown } from "../domains/collab/test-support/bound-writes.js";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("production-composed live reversal (postgres)", () => {});
} else {
  describe("production-composed live reversal (postgres)", async () => {
    const schema = await import("@meridian/database/schema");
    const { conformanceUserValues } = await import(
      "@meridian/database/__test-support__/db-fixtures"
    );
    const { useRollbackTestDatabase, deleteDrizzleRows } = await import(
      "../test-support/drizzle-reset.js"
    );
    const { unloadHocuspocus, useComposedRuntimes } = await import(
      "../test-support/composed-runtime.js"
    );

    const USER_ID = "00000000-0000-4000-8000-000000000c01";
    const PROJECT_ID = "00000000-0000-4000-8000-000000000c02";
    const SOURCE_ID = "00000000-0000-4000-8000-000000000c03";
    const WORK_ID = "00000000-0000-4000-8000-000000000c04";
    const LIVE = {
      threadId: "00000000-0000-4000-8000-000000000c06",
      turnId: "00000000-0000-4000-8000-000000000c07",
    };
    const DOC_ID = "00000000-0000-4000-8000-000000000c08";
    const CHAPTER = "manuscript://chapter.md";
    const database = useRollbackTestDatabase(DATABASE_URL, {
      max: 4,
      prepareSuite: (db) => deleteDrizzleRows(db, [schema.users]),
    });
    let db = database.current;
    const runtimes = useComposedRuntimes(() => db);
    beforeEach(async () => {
      db = database.current;
      await db.insert(schema.users).values(conformanceUserValues(USER_ID, "live-reversal"));
      await db.insert(schema.projects).values({
        id: PROJECT_ID,
        userId: USER_ID,
        name: "Live reversal",
        slug: "live-reversal",
      });
      await db.insert(schema.works).values({
        id: WORK_ID,
        projectId: PROJECT_ID,
        createdByUserId: USER_ID,
        name: "Rewrite",
        slug: "rewrite",
        aiWriteMode: "direct",
      });
      await db.insert(schema.contextSources).values({
        id: SOURCE_ID,
        projectId: PROJECT_ID,
        name: "Manuscript",
        slug: "manuscript",
        scope: "project",
        isPrimary: true,
      });
      await db.insert(schema.documents).values({
        id: DOC_ID,
        contextSourceId: SOURCE_ID,
        name: "chapter",
        extension: "md",
        fileType: "markdown",
      });
      await db.insert(schema.threads).values({
        rootThreadId: LIVE.threadId,
        id: LIVE.threadId,
        projectId: PROJECT_ID,
        createdByUserId: USER_ID,
        title: "Live reversal",
        kind: "primary",
        status: "idle",
      });
      await db.insert(schema.turns).values({
        id: LIVE.turnId,
        threadId: LIVE.threadId,
        position: 1,
        role: "assistant",
        origin: "assistant",
        status: "complete",
      });
      await db.insert(schema.threadWorks).values({
        threadId: LIVE.threadId,
        workId: WORK_ID,
        projectId: PROJECT_ID,
        isPrimary: true,
      });
    });

    it("undoes and redoes direct-mode writes through the live journal", async () => {
      const runtime = await runtimes.compose();
      await writeMarkdown(runtime.ports.documentSync, {
        documentId: DOC_ID,
        markdown: "Writer opening.",
        origin: { type: "user", actorUserId: USER_ID },
        threadId: LIVE.threadId,
      });
      await runtime.ports.documentSync.recordManifestDocumentCreated(DOC_ID, {
        projectId: PROJECT_ID,
      });
      const script = runtimes.script(runtime, LIVE);
      try {
        // Separate replies: one reply's edits to one block share a write handle.
        await script.reply(async (call) => {
          await call("read", { path: CHAPTER });
          await call("write", {
            command: "insert",
            path: CHAPTER,
            find: "opening.",
            content: " One.",
          });
        });
        await script.reply(async (call) => {
          await call("write", { command: "insert", path: CHAPTER, find: "One.", content: " Two." });
        });
        await expect(
          runtime.ports.documentSync.agentEdit().getAvailability(DOC_ID, LIVE.threadId),
        ).resolves.toMatchObject({ undo: true, redo: false });

        await script.reply(async (call) => {
          await call("write", { command: "undo", path: CHAPTER, last: 1 });
        });
        expect(await script.text(CHAPTER)).toMatch(/\|Writer opening\. One\.$/);
        await script.reply(async (call) => {
          await call("write", { command: "redo", path: CHAPTER, last: 1 });
        });
        expect(await script.text(CHAPTER)).toContain("Writer opening. One. Two.");

        const branches = await db
          .select({ id: schema.documentBranches.id })
          .from(schema.documentBranches)
          .where(
            and(
              eq(schema.documentBranches.documentId, DOC_ID),
              eq(schema.documentBranches.threadId, LIVE.threadId),
            ),
          );
        expect(branches).toEqual([]);
      } finally {
        await unloadHocuspocus(runtime.hocuspocus);
      }
    });
  });
}
