/**
 * The file and action policies at the production-composed model tools
 * (file-access §4, §6, §9; D34, D35): `ls` reports each file's real access, and
 * a `read` agent has `write` but edits only its own scratch and changes no Work.
 */

import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("file access at the model tools (postgres)", () => {});
} else {
  describe("file access at the model tools (postgres)", async () => {
    const schema = await import("@meridian/database/schema");
    const { conformanceUserValues } = await import(
      "@meridian/database/__test-support__/db-fixtures"
    );
    const { useRollbackTestDatabase, deleteDrizzleRows } = await import(
      "../test-support/drizzle-reset.js"
    );
    const { useComposedRuntimes } = await import("../test-support/composed-runtime.js");
    const { resolveAgentThreadTurnContext } = await import("../domains/runtime/index.js");

    const USER_ID = "00000000-0000-4000-8000-000000000f01";
    const PROJECT_ID = "00000000-0000-4000-8000-000000000f02";
    const MANUSCRIPT_ID = "00000000-0000-4000-8000-000000000f03";
    const WORK_ID = "00000000-0000-4000-8000-000000000f04";
    const SCRATCH_ID = "00000000-0000-4000-8000-000000000f05";
    const CHAPTER_ID = "00000000-0000-4000-8000-000000000f06";
    const NOTES_ID = "00000000-0000-4000-8000-000000000f07";
    const THREAD = {
      threadId: "00000000-0000-4000-8000-000000000f08",
      turnId: "00000000-0000-4000-8000-000000000f09",
    };
    const database = useRollbackTestDatabase(DATABASE_URL, {
      max: 4,
      prepareSuite: (db) => deleteDrizzleRows(db, [schema.users]),
    });
    let db = database.current;
    const runtimes = useComposedRuntimes(() => db);

    beforeEach(async () => {
      db = database.current;
      await db.insert(schema.users).values(conformanceUserValues(USER_ID, "file-access-tools"));
      await db.insert(schema.projects).values({
        id: PROJECT_ID,
        userId: USER_ID,
        name: "File access tools",
        slug: "file-access-tools",
      });
      await db.insert(schema.works).values({
        id: WORK_ID,
        projectId: PROJECT_ID,
        createdByUserId: USER_ID,
        name: "Rewrite",
        slug: "rewrite",
      });
      await db.insert(schema.contextSources).values([
        {
          id: MANUSCRIPT_ID,
          projectId: PROJECT_ID,
          name: "Manuscript",
          slug: "manuscript",
          scope: "project",
          isPrimary: true,
        },
        { id: SCRATCH_ID, workId: WORK_ID, name: "Scratch", slug: "scratch", scope: "work" },
      ]);
      await db.insert(schema.documents).values([
        {
          id: CHAPTER_ID,
          contextSourceId: MANUSCRIPT_ID,
          name: "chapter",
          extension: "md",
          fileType: "markdown",
        },
        {
          id: NOTES_ID,
          contextSourceId: SCRATCH_ID,
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
        title: "File access tools",
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

    async function start() {
      const runtime = await runtimes.compose();
      await runtime.ports.documentSync.writeDocument({
        documentId: CHAPTER_ID,
        markdown: "Writer chapter.",
        origin: { type: "user", actorUserId: USER_ID },
        threadId: THREAD.threadId,
      });
      for (const documentId of [CHAPTER_ID, NOTES_ID]) {
        await runtime.ports.documentSync.recordManifestDocumentCreated(documentId as never, {
          projectId: PROJECT_ID as never,
        });
      }
      return runtimes.script(runtime, THREAD);
    }

    type Listed = { uri: string; readonly?: boolean; editable?: unknown; wordCount?: number };
    const listed = (result: { result: unknown }) =>
      (result.result as { entries: Listed[] }).entries;

    it("lists an archived Work's scratch read-only and the manuscript editable", async () => {
      const script = await start();
      await db
        .update(schema.works)
        .set({ archivedAt: new Date() })
        .where(eq(schema.works.id, WORK_ID));
      const { call } = await script.begin();

      const scratchCall = await call("ls", { path: "scratch://" });
      const scratch = listed(scratchCall);
      expect(scratch).toEqual([
        expect.objectContaining({ uri: "scratch://@rewrite/notes.md", readonly: true }),
      ]);
      expect(scratch[0]).not.toHaveProperty("editable");
      expect(scratch[0]).not.toHaveProperty("documentId");
      expect(scratchCall.output).toBe("scratch://@rewrite/\n  notes.md (read-only)");
      const manuscriptCall = await call("ls", { path: "manuscript://" });
      expect(listed(manuscriptCall)).toEqual([
        expect.objectContaining({ uri: "manuscript://chapter.md", readonly: false }),
      ]);
      expect(manuscriptCall.output).toBe("manuscript://\n  chapter.md");
    });

    // D37, D51: a switch that couldn't happen says why instead of asking for approval.
    it("resolves a switch's target before asking for the user's approval", async () => {
      await db.insert(schema.works).values([
        { projectId: PROJECT_ID, createdByUserId: USER_ID, name: "Other", slug: "other" },
        {
          projectId: PROJECT_ID,
          createdByUserId: USER_ID,
          name: "Frozen",
          slug: "frozen",
          archivedAt: new Date(),
        },
      ]);
      const script = await start();
      const { call } = await script.begin();
      const switchTo = async (work: string) =>
        (await call("work", { command: "switch", work })).output;

      expect(await switchTo("ghost")).toMatchObject({
        code: "work_not_found",
        message: 'Unknown Work @ghost. List Works with work({"command":"list"}).',
      });
      expect(await switchTo("frozen")).toMatchObject({
        code: "work_archived",
        message:
          "Work @frozen is archived, so this chat can't switch to it until the user unarchives it.",
      });
      expect(await switchTo("@rewrite")).toEqual({
        message: "This chat is already in @rewrite.",
      });
      expect(await switchTo("other")).toMatchObject({
        code: "permission_denied",
        message:
          "Switching this chat's Work needs the user's approval. Ask them to switch it to @other from the chat.",
      });
    });

    it("gives a read agent write, refuses the manuscript and Work changes, and lets it write its own scratch", async () => {
      const script = await start();
      await script.runtime.ports.agentRevisions.bindThread(
        THREAD.threadId,
        null,
        {
          model: "mock-model",
          skills: { load: [], available: [] },
          namedTargets: [],
          permission: "read",
        },
        null,
      );
      const thread = await script.runtime.ports.threadRepos.threads.findById(THREAD.threadId);
      if (!thread) throw new Error("thread missing");
      const context = await resolveAgentThreadTurnContext({
        thread,
        agentRevisions: script.runtime.ports.agentRevisions,
        threads: script.runtime.ports.threadRepos.threads,
        toolRegistry: script.runtime.app.toolRegistry,
        baseTools: script.runtime.app.toolExecutor.getDefinitions?.(),
      });
      expect(context.tools.map((tool) => (tool.type === "function" ? tool.name : ""))).toContain(
        "write",
      );
      const { call, save } = await script.begin();

      const archive = await call("work", { command: "archive", work: "rewrite" });
      expect(archive.isError).toBe(true);
      expect(archive.output).toMatchObject({
        code: "permission_denied",
        message: "This agent can read but can't change Works. Ask the user to make this change.",
        details: { reason: "action_denied" },
      });

      const root = listed(await call("ls", {}));
      expect(root).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ uri: "manuscript://", readonly: true }),
          expect.objectContaining({ uri: "scratch://", readonly: false }),
        ]),
      );

      await call("read", { path: "manuscript://chapter.md" });
      const refused = await call("write", {
        command: "replace",
        path: "manuscript://chapter.md",
        find: "Writer chapter.",
        content: "Agent chapter.",
      });
      expect(refused.isError).toBe(true);
      expect(refused.result).toMatchObject({
        status: "permission_denied",
        reason: "agent_read_only",
      });
      expect(String(refused.output)).toContain(
        "Your permission is read, so you can change only scratch://.",
      );

      const notes = await call("write", {
        command: "create",
        path: "scratch://ideas.md",
        content: "Agent ideas.",
      });
      expect(notes.isError).toBeFalsy();
      await save();

      const chapter = await script.runtime.ports.documentSync.readAsMarkdown(CHAPTER_ID);
      expect(chapter.ok && chapter.value).toContain("Writer chapter.");
      expect(await script.text("scratch://ideas.md")).toContain("Agent ideas.");
      const { call: next } = await script.begin();
      expect(listed(await next("ls", { path: "scratch://", verbose: true }))).toContainEqual(
        expect.objectContaining({ uri: "scratch://@rewrite/ideas.md", wordCount: 2 }),
      );
    });
  });
}
