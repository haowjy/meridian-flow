/**
 * Production-composed `write` `move` and `delete` on live documents: identity,
 * content and links follow a move, a delete leaves `ls` and `read`, uploads
 * and a stale read are refused, and a rolled-back reply puts both back (D66).
 */

import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("production-composed move and delete (postgres)", () => {});
} else {
  describe("production-composed move and delete (postgres)", async () => {
    const schema = await import("@meridian/database/schema");
    const { conformanceUserValues } = await import(
      "@meridian/database/__test-support__/db-fixtures"
    );
    const { useRollbackTestDatabase, deleteDrizzleRows } = await import(
      "../test-support/drizzle-reset.js"
    );
    const { useComposedRuntimes } = await import("../test-support/composed-runtime.js");

    const USER_ID = "00000000-0000-4000-8000-000000000f01";
    const PROJECT_ID = "00000000-0000-4000-8000-000000000f02";
    const SOURCE_ID = "00000000-0000-4000-8000-000000000f03";
    const WORK_ID = "00000000-0000-4000-8000-000000000f04";
    const THREAD = {
      threadId: "00000000-0000-4000-8000-000000000f05",
      turnId: "00000000-0000-4000-8000-000000000f06",
    };
    const DOC_ID = "00000000-0000-4000-8000-000000000f07";
    const UPLOADS_SOURCE_ID = "00000000-0000-4000-8000-000000000f08";
    const UPLOAD_ID = "00000000-0000-4000-8000-000000000f09";
    const CHAPTER = "manuscript://chapter.md";
    const RENAMED = "manuscript://renamed.md";
    const HOLDER = "manuscript://holder.md";
    const database = useRollbackTestDatabase(DATABASE_URL, {
      max: 4,
      prepareSuite: (db) => deleteDrizzleRows(db, [schema.users]),
    });
    let db = database.current;
    const runtimes = useComposedRuntimes(() => db);

    beforeEach(async () => {
      db = database.current;
      await db.insert(schema.users).values(conformanceUserValues(USER_ID, "namespace-tools"));
      await db.insert(schema.projects).values({
        id: PROJECT_ID,
        userId: USER_ID,
        name: "Namespace tools",
        slug: "namespace-tools",
      });
      await db.insert(schema.works).values([
        { projectId: PROJECT_ID, createdByUserId: USER_ID, name: "No Work", isNoWork: true },
        {
          id: WORK_ID,
          projectId: PROJECT_ID,
          createdByUserId: USER_ID,
          name: "Rewrite",
          slug: "rewrite",
          aiWriteMode: "direct",
        },
      ]);
      await db.insert(schema.contextSources).values([
        {
          id: SOURCE_ID,
          projectId: PROJECT_ID,
          name: "Manuscript",
          slug: "manuscript",
          scope: "project",
          isPrimary: true,
        },
        { id: UPLOADS_SOURCE_ID, workId: WORK_ID, name: "Uploads", slug: "uploads", scope: "work" },
      ]);
      await db.insert(schema.documents).values([
        {
          id: DOC_ID,
          contextSourceId: SOURCE_ID,
          name: "chapter",
          extension: "md",
          fileType: "markdown",
        },
        {
          id: UPLOAD_ID,
          contextSourceId: UPLOADS_SOURCE_ID,
          name: "notes",
          extension: "md",
          fileType: "markdown",
        },
      ]);
      await db.insert(schema.threads).values({
        rootThreadId: THREAD.threadId,
        id: THREAD.threadId,
        projectId: PROJECT_ID,
        createdByUserId: USER_ID,
        title: "Namespace tools",
        kind: "primary",
        status: "idle",
      });
      await db.insert(schema.turns).values({
        id: THREAD.turnId,
        threadId: THREAD.threadId,
        position: 1,
        role: "assistant",
        origin: "assistant",
        status: "complete",
      });
      await db.insert(schema.threadWorks).values({
        threadId: THREAD.threadId,
        workId: WORK_ID,
        projectId: PROJECT_ID,
        isPrimary: true,
      });
    });

    /** A composed runtime with the writer's chapter live, and a chapter that links to it. */
    async function start() {
      const runtime = await runtimes.compose();
      await runtime.ports.documentSync.writeDocument({
        documentId: DOC_ID,
        markdown: "Chapter one text.",
        origin: { type: "user", actorUserId: USER_ID },
        threadId: THREAD.threadId,
      });
      await runtime.ports.documentSync.recordManifestDocumentCreated(DOC_ID, {
        projectId: PROJECT_ID,
      });
      const holder = await runtime.app.contextPorts
        .forProject(PROJECT_ID, USER_ID, new Map())
        .createTrackedDocument(HOLDER, `[One](${CHAPTER}).`);
      if (!holder.ok) throw new Error(JSON.stringify(holder.error));
      return { runtime, script: runtimes.script(runtime, THREAD) };
    }

    const text = (result: { output: unknown }) =>
      typeof result.output === "string" ? result.output : JSON.stringify(result.output);

    async function documentRow(id: string) {
      const [row] = await db.select().from(schema.documents).where(eq(schema.documents.id, id));
      return row;
    }

    it("moves a chapter: same document and content, and a link to it follows", async () => {
      const { runtime, script } = await start();
      const reply = await script.begin();
      const moved = await reply.call("write", {
        command: "move",
        from: { path: CHAPTER },
        path: RENAMED,
      });
      expect(moved.isError).toBeFalsy();
      expect(text(moved)).toMatch(
        /^status: success; path: manuscript:\/\/renamed\.md; write: w\d+; version: live; moved from manuscript:\/\/chapter\.md/,
      );
      await reply.save();

      expect(await documentRow(DOC_ID)).toMatchObject({ name: "renamed", deletedAt: null });
      expect(await script.text(RENAMED)).toContain("Chapter one text.");
      const old = await (await script.begin()).call("read", { path: CHAPTER });
      expect(old.isError).toBe(true);

      await runtime.app.linkUpdates.sweep();
      expect(await script.text(HOLDER)).toContain(`[One](${RENAMED})`);
    });

    it("deletes a chapter: it leaves ls and read", async () => {
      const { script } = await start();
      const reply = await script.begin();
      const deleted = await reply.call("write", { command: "delete", path: CHAPTER });
      expect(text(deleted)).toMatch(
        /^status: success; path: manuscript:\/\/chapter\.md; write: w\d+; version: live; deleted/,
      );
      await reply.save();

      expect((await documentRow(DOC_ID))?.deletedAt).not.toBeNull();
      const { call } = await script.begin();
      expect(text(await call("ls", { path: "manuscript://" }))).not.toContain("chapter.md");
      expect((await call("read", { path: CHAPTER })).isError).toBe(true);
    });

    it("refuses uploads for every agent (D15)", async () => {
      const { script } = await start();
      const { call } = await script.begin();
      const deleted = await call("write", { command: "delete", path: "uploads://notes.md" });
      expect(deleted.result).toMatchObject({
        status: "permission_denied",
        reason: "uploads_read_only",
      });
      const moved = await call("write", {
        command: "move",
        from: { path: "uploads://notes.md" },
        path: "manuscript://notes.md",
      });
      expect(moved.result).toMatchObject({
        status: "permission_denied",
        reason: "uploads_read_only",
      });
      expect(await documentRow(UPLOAD_ID)).toMatchObject({ name: "notes", deletedAt: null });
    });

    it("refuses in a draft-mode Work, and after the mode changes until the model reads again (D41)", async () => {
      await db
        .update(schema.works)
        .set({ aiWriteMode: "draft" })
        .where(eq(schema.works.id, WORK_ID));
      const { script } = await start();
      const drafted = await script.begin();
      await drafted.call("read", { path: CHAPTER });
      const refused = await drafted.call("write", { command: "delete", path: CHAPTER });
      expect(refused.isError).toBe(true);
      expect(text(refused)).toContain("@rewrite's draft");
      await drafted.save();

      await db
        .update(schema.works)
        .set({ aiWriteMode: "direct" })
        .where(eq(schema.works.id, WORK_ID));
      const live = await script.begin();
      const stale = await live.call("write", { command: "delete", path: CHAPTER });
      expect(stale.result).toMatchObject({ status: "read_required" });
      expect((await documentRow(DOC_ID))?.deletedAt).toBeNull();
      await live.call("read", { path: CHAPTER });
      const deleted = await live.call("write", { command: "delete", path: CHAPTER });
      expect(deleted.isError).toBeFalsy();
    });

    it("puts a move and a delete back when their reply rolls back", async () => {
      const { script } = await start();
      const reply = await script.begin();
      await reply.call("write", { command: "move", from: { path: CHAPTER }, path: RENAMED });
      await reply.call("write", { command: "delete", path: HOLDER });
      await reply.rollback();

      expect(await documentRow(DOC_ID)).toMatchObject({ name: "chapter", deletedAt: null });
      expect(await script.text(CHAPTER)).toContain("Chapter one text.");
      expect(await script.text(HOLDER)).toContain(`[One](${CHAPTER})`);
      expect(await db.select().from(schema.agentNamespaceChanges)).toEqual([]);
    });
  });
}
