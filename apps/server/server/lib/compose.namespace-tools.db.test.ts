/**
 * Production-composed `write` `move` and `delete` on live documents: identity,
 * content and links follow a move, a delete leaves `ls` and `read`, uploads
 * and a stale read are refused, and a rolled-back reply puts both back (D66).
 * `undo` and `redo` count them with content writes, an undone create goes, and
 * the writer restores an agent's delete or undoes its whole turn.
 */

import { randomUUID } from "node:crypto";
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
    const { restoreAgentDelete } = await import("./thread-context-route.js");

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
    const FRESH = "manuscript://fresh.md";
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

    it("the link update a move makes doesn't reach the model as the writer's edit", async () => {
      const { runtime, script } = await start();
      const notes = "manuscript://notes.md";
      const created = await runtime.app.contextPorts
        .forProject(PROJECT_ID, USER_ID, new Map())
        .createTrackedDocument(notes, `Intro.\n\nSee [One](${CHAPTER}).`);
      if (!created.ok) throw new Error(JSON.stringify(created.error));
      const reply = await script.begin();
      await reply.call("read", { path: notes });
      await reply.call("write", { command: "move", from: { path: CHAPTER }, path: RENAMED });
      await runtime.app.linkUpdates.sweep();
      await reply.call("write", {
        command: "insert",
        path: notes,
        find: "Intro.",
        content: " More.",
      });
      const saved = await reply.save();
      if (saved.status !== "committed") throw new Error(saved.status);
      // Neither the link update nor the model's own write is anyone's concurrent edit.
      expect(saved.documents.map((document) => document.concurrentEdits)).toEqual([undefined]);
      expect(await script.text(notes)).toContain(`See [One](${RENAMED}).`);
    });

    it("refuses uploads for every agent (D15), and a folder", async () => {
      const { runtime, script } = await start();
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
      await call("read", { path: CHAPTER });
      const intoUploads = await call("write", {
        command: "move",
        from: { path: CHAPTER },
        path: "uploads://x.md",
      });
      expect(intoUploads.result).toMatchObject({
        status: "permission_denied",
        reason: "uploads_read_only",
      });
      expect(await documentRow(UPLOAD_ID)).toMatchObject({ name: "notes", deletedAt: null });
      expect(await documentRow(DOC_ID)).toMatchObject({ name: "chapter", deletedAt: null });

      const inArc = await runtime.app.contextPorts
        .forProject(PROJECT_ID, USER_ID, new Map())
        .createTrackedDocument("manuscript://arc/one.md", "One.");
      if (!inArc.ok) throw new Error(JSON.stringify(inArc.error));
      const folder = await call("write", { command: "delete", path: "manuscript://arc" });
      expect(text(folder)).toContain(
        "manuscript://arc is a folder; `move` and `delete` take a document.",
      );
      const missing = await call("write", { command: "delete", path: "manuscript://missing.md" });
      expect(missing.result).toMatchObject({ status: "document_not_found" });
    });

    it("refuses in a draft-mode Work, a half-drafted move (D45), and after the mode changes until the model reads again (D41)", async () => {
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
      // Scratch stays live in draft mode, so a move into the manuscript is half of each (D45).
      const note = await drafted.call("write", {
        command: "create",
        path: "scratch://note.md",
        content: "A note.",
      });
      expect(note.isError).toBeFalsy();
      const mixed = await drafted.call("write", {
        command: "move",
        from: { path: "scratch://note.md" },
        path: "manuscript://note.md",
      });
      expect(text(mixed)).toBe(
        "status: invalid_write\n\n@rewrite is in draft mode, so this move would be half drafted and half live. Copy the document, then delete the original, or ask the user to switch @rewrite to auto-apply.",
      );
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

    it("a rollback that can't put the delete back still puts the move back, and forgets both", async () => {
      const { runtime, script } = await start();
      const reply = await script.begin();
      await reply.call("write", { command: "move", from: { path: CHAPTER }, path: RENAMED });
      await reply.call("write", { command: "delete", path: HOLDER });
      const squatter = await runtime.app.contextPorts
        .forProject(PROJECT_ID, USER_ID, new Map())
        .createTrackedDocument(HOLDER, "The writer's own.");
      if (!squatter.ok) throw new Error(JSON.stringify(squatter.error));
      await reply.rollback();

      expect(await documentRow(DOC_ID)).toMatchObject({ name: "chapter", deletedAt: null });
      expect(await script.text(HOLDER)).toContain("The writer's own.");
      expect(await db.select().from(schema.agentNamespaceChanges)).toEqual([]);
    });

    it("undo last: 1 after a move moves it back, not the content write before it, and links follow", async () => {
      const { runtime, script } = await start();
      await script.reply(async (call) => {
        await call("read", { path: CHAPTER });
        await call("write", { command: "insert", path: CHAPTER, find: "text.", content: " More." });
      });
      await script.reply(async (call) => {
        await call("read", { path: CHAPTER });
        await call("write", { command: "move", from: { path: CHAPTER }, path: RENAMED });
      });
      await runtime.app.linkUpdates.sweep();
      expect(await script.text(HOLDER)).toContain(`[One](${RENAMED})`);

      const reply = await script.begin();
      const undone = await reply.call("write", { command: "undo", path: RENAMED, last: 1 });
      expect(text(undone)).toBe(
        "status: reversed; path: manuscript://chapter.md; moved from manuscript://renamed.md; undo: w2",
      );
      await reply.save();

      expect(await documentRow(DOC_ID)).toMatchObject({ name: "chapter", deletedAt: null });
      expect(await script.text(CHAPTER)).toContain("Chapter one text. More.");
      await runtime.app.linkUpdates.sweep();
      expect(await script.text(HOLDER)).toContain(`[One](${CHAPTER})`);
    });

    it("after a switch to draft mode, undo takes the drafted write first, then moves the live move back live", async () => {
      const { script } = await start();
      await script.reply(async (call) => {
        await call("read", { path: CHAPTER });
        await call("write", { command: "move", from: { path: CHAPTER }, path: RENAMED });
      });
      await db
        .update(schema.works)
        .set({ aiWriteMode: "draft" })
        .where(eq(schema.works.id, WORK_ID));
      await script.reply(async (call) => {
        await call("read", { path: RENAMED });
        const drafted = await call("write", {
          command: "insert",
          path: RENAMED,
          find: "text.",
          content: " Drafted.",
        });
        expect(drafted).toContain("write: w2; version: draft");
      });

      const draftUndo = await script.begin();
      const undoneDraft = await draftUndo.call("write", {
        command: "undo",
        path: RENAMED,
        last: 1,
      });
      expect(text(undoneDraft)).toMatch(/^status: reversed; .*undo: w2/);
      await draftUndo.save();
      expect(await documentRow(DOC_ID)).toMatchObject({ name: "renamed", deletedAt: null });

      const liveUndo = await script.begin();
      const undoneMove = await liveUndo.call("write", { command: "undo", path: RENAMED, last: 1 });
      expect(text(undoneMove)).toBe(
        "status: reversed; path: manuscript://chapter.md; moved from manuscript://renamed.md; undo: w1",
      );
      await liveUndo.save();
      expect(await documentRow(DOC_ID)).toMatchObject({ name: "chapter", deletedAt: null });
    });

    it("after a save boundary, a reply undoes and moves under its rotated edit id", async () => {
      const { runtime, script } = await start();
      const reply = await script.begin();
      await reply.call("read", { path: CHAPTER });
      await reply.call("write", {
        command: "insert",
        path: CHAPTER,
        find: "text.",
        content: " More.",
      });
      await reply.save();
      // The orchestrator's save boundary: the rest of the reply runs under a new edit id.
      const rotated = randomUUID();
      const call = (args: Record<string, unknown>) =>
        runtime.app.toolExecutor.executeTool(
          { id: randomUUID(), name: "write", arguments: args },
          { ...THREAD, responseId: rotated, agentSlug: null },
        );
      const undone = await call({ command: "undo", path: CHAPTER });
      expect(text(undone)).toMatch(/^status: reversed; path: manuscript:\/\/chapter\.md; undo: w1/);
      const moved = await call({ command: "move", from: { path: CHAPTER }, path: RENAMED });
      expect(text(moved)).toMatch(/^status: success; path: manuscript:\/\/renamed\.md/);
      await runtime.ports.documentSync.finalizeResponseCommit(rotated, THREAD as never);
      expect(await documentRow(DOC_ID)).toMatchObject({ name: "renamed", deletedAt: null });
    });

    it("refuses to undo a move whose old path is taken", async () => {
      const { runtime, script } = await start();
      await script.reply(async (call) => {
        await call("read", { path: CHAPTER });
        await call("write", { command: "move", from: { path: CHAPTER }, path: RENAMED });
      });
      const squatter = await runtime.app.contextPorts
        .forProject(PROJECT_ID, USER_ID, new Map())
        .createTrackedDocument(CHAPTER, "Another chapter.");
      if (!squatter.ok) throw new Error(JSON.stringify(squatter.error));

      const { call } = await script.begin();
      const refused = await call("write", { command: "undo", path: RENAMED });
      expect(refused.isError).toBe(true);
      expect(text(refused)).toContain(
        "Can't undo w1: manuscript://chapter.md already exists. Move or rename that document first.",
      );
      expect(await documentRow(DOC_ID)).toMatchObject({ name: "renamed", deletedAt: null });
      const [change] = await db.select().from(schema.agentNamespaceChanges);
      expect(change?.status).toBe("active");
    });

    it("deletes a chapter so it leaves ls and read, undoes the delete, then redoes it", async () => {
      const { script } = await start();
      const reply = await script.begin();
      await reply.call("read", { path: CHAPTER });
      const deleted = await reply.call("write", { command: "delete", path: CHAPTER });
      expect(text(deleted)).toMatch(
        /^status: success; path: manuscript:\/\/chapter\.md; write: w1; version: live; deleted/,
      );
      await reply.save();
      expect((await documentRow(DOC_ID))?.deletedAt).not.toBeNull();
      const { call } = await script.begin();
      expect(text(await call("ls", { path: "manuscript://" }))).not.toContain("chapter.md");
      expect((await call("read", { path: CHAPTER })).isError).toBe(true);

      const undo = await script.begin();
      const undone = await undo.call("write", { command: "undo", path: CHAPTER });
      expect(text(undone)).toBe(
        "status: reversed; path: manuscript://chapter.md; restored; undo: w1",
      );
      await undo.save();
      expect((await documentRow(DOC_ID))?.deletedAt).toBeNull();
      expect(await script.text(CHAPTER)).toContain("Chapter one text.");

      const redo = await script.begin();
      const redone = await redo.call("write", { command: "redo", path: CHAPTER });
      expect(text(redone)).toBe(
        "status: reversed; path: manuscript://chapter.md; deleted; redo: w1",
      );
      await redo.save();
      expect((await documentRow(DOC_ID))?.deletedAt).not.toBeNull();
    });

    it("undo of a create leaves no document, and redo brings it back", async () => {
      const { script } = await start();
      await script.reply(async (call) => {
        await call("write", { command: "create", path: FRESH, content: "Fresh." });
      });
      const [fresh] = await db
        .select()
        .from(schema.documents)
        .where(eq(schema.documents.name, "fresh"));
      if (!fresh) throw new Error("create missing");

      const undo = await script.begin();
      const undone = await undo.call("write", { command: "undo", path: FRESH });
      expect(text(undone)).toBe("status: reversed; path: manuscript://fresh.md; deleted; undo: w1");
      await undo.save();
      expect((await documentRow(fresh.id))?.deletedAt).not.toBeNull();
      const { call } = await script.begin();
      expect((await call("read", { path: FRESH })).isError).toBe(true);

      const redo = await script.begin();
      const redone = await redo.call("write", { command: "redo", path: FRESH });
      expect(text(redone)).toMatch(
        /^status: reversed; path: manuscript:\/\/fresh\.md; restored; redo: w1/,
      );
      await redo.save();
      expect((await documentRow(fresh.id))?.deletedAt).toBeNull();
      expect(await script.text(FRESH)).toContain("Fresh.");
    });

    it("lets the writer restore the agent's delete from its turn, unless its path is taken", async () => {
      const { runtime, script } = await start();
      await script.reply(async (call) => {
        await call("read", { path: CHAPTER });
        await call("write", { command: "delete", path: CHAPTER });
      });
      const app = runtime.app;
      const deps = {
        contextPorts: app.contextPorts,
        fileAccess: app.fileAccess,
        threads: app.threadRepos.threads,
        threadWorks: app.threadRepos.threadWorks,
        works: app.workRepo,
        workAuthorityResolver: app.workAuthorityResolver,
        namespaceChanges: app.documentSync.namespaceChanges,
      };
      const restore = () =>
        restoreAgentDelete(deps, {
          threadId: THREAD.threadId as never,
          turnId: THREAD.turnId,
          documentId: DOC_ID,
          userId: USER_ID as never,
        });
      const port = app.contextPorts.forProject(PROJECT_ID, USER_ID, new Map());
      const squatter = await port.createTrackedDocument(CHAPTER, "Another chapter.");
      if (!squatter.ok) throw new Error(JSON.stringify(squatter.error));

      await expect(restore()).resolves.toEqual({ status: "location_taken", uri: CHAPTER });
      expect((await documentRow(DOC_ID))?.deletedAt).not.toBeNull();

      const removed = await port.delete(CHAPTER, {
        expected: { kind: "file", documentId: squatter.value.documentId ?? "" },
      });
      expect(removed.ok).toBe(true);
      await expect(restore()).resolves.toEqual({
        status: "restored",
        documentId: DOC_ID,
        uri: CHAPTER,
      });
      expect((await documentRow(DOC_ID))?.deletedAt).toBeNull();
      expect(await script.text(CHAPTER)).toContain("Chapter one text.");
      const { call } = await script.begin();
      expect(text(await call("ls", { path: "manuscript://" }))).toContain("chapter.md");
      await expect(restore()).resolves.toEqual({ status: "not_applied" });
    });

    it("the writer's turn undo names a taken path, then puts back the turn's move and delete, and redo makes them again", async () => {
      const { runtime, script } = await start();
      await script.reply(async (call) => {
        await call("read", { path: CHAPTER });
        await call("read", { path: HOLDER });
        await call("write", { command: "move", from: { path: CHAPTER }, path: RENAMED });
        await call("write", { command: "delete", path: HOLDER });
      });
      const [holder] = await db
        .select()
        .from(schema.documents)
        .where(eq(schema.documents.name, "holder"));
      const reverse = (direction: "undo" | "redo") =>
        runtime.app.documentSync.reverseThreadContext({
          threadId: THREAD.threadId as never,
          turnId: THREAD.turnId as never,
          userId: USER_ID as never,
          direction,
          scope: "turn",
          selection: THREAD.turnId,
        });

      const port = runtime.app.contextPorts.forProject(PROJECT_ID, USER_ID, new Map());
      const squatter = await port.createTrackedDocument(HOLDER, "The writer's own.");
      if (!squatter.ok) throw new Error(JSON.stringify(squatter.error));
      await expect(reverse("undo")).resolves.toEqual({
        status: "location_taken",
        documents: [{ uri: HOLDER, status: "location_taken" }],
      });
      expect(await documentRow(DOC_ID)).toMatchObject({ name: "renamed", deletedAt: null });
      await port.delete(HOLDER, {
        expected: { kind: "file", documentId: squatter.value.documentId ?? "" },
      });

      await expect(reverse("undo")).resolves.toMatchObject({ status: "reversed" });
      expect(await documentRow(DOC_ID)).toMatchObject({ name: "chapter", deletedAt: null });
      expect((await documentRow(holder?.id ?? ""))?.deletedAt).toBeNull();

      await expect(reverse("redo")).resolves.toMatchObject({ status: "reversed" });
      expect(await documentRow(DOC_ID)).toMatchObject({ name: "renamed", deletedAt: null });
      expect((await documentRow(holder?.id ?? ""))?.deletedAt).not.toBeNull();
    });

    it("after the writer's turn undo, the model's redo all redoes the turn's edits and move once each", async () => {
      const { runtime, script } = await start();
      await script.reply(async (call) => {
        await call("read", { path: CHAPTER });
        await call("write", { command: "insert", path: CHAPTER, find: "text.", content: " One." });
        await call("write", { command: "move", from: { path: CHAPTER }, path: RENAMED });
        await call("read", { path: RENAMED });
        await call("write", { command: "insert", path: RENAMED, find: "One.", content: " Two." });
      });
      await expect(
        runtime.app.documentSync.reverseThreadContext({
          threadId: THREAD.threadId as never,
          turnId: THREAD.turnId as never,
          userId: USER_ID as never,
          direction: "undo",
          scope: "turn",
          selection: THREAD.turnId,
        }),
      ).resolves.toMatchObject({ status: "reversed" });
      expect(await documentRow(DOC_ID)).toMatchObject({ name: "chapter" });

      const redo = await script.begin();
      const redone = await redo.call("write", { command: "redo", path: CHAPTER, all: true });
      expect(text(redone)).toMatch(
        /^status: reversed; path: manuscript:\/\/renamed\.md; .*redo: w1, w2, w3/,
      );
      await redo.save();
      expect(await documentRow(DOC_ID)).toMatchObject({ name: "renamed" });
      expect(await script.text(RENAMED)).toContain("Chapter one text. One. Two.");
    });

    it("cleans up a document created then moved in a reply whose save refuses it", async () => {
      const { script } = await start();
      const reply = await script.begin();
      const created = await reply.call("write", {
        command: "create",
        path: "manuscript://fresh.md",
        content: "Fresh.",
      });
      expect(created.isError).toBeFalsy();
      const moved = await reply.call("write", {
        command: "move",
        from: { path: "manuscript://fresh.md" },
        path: "manuscript://kept.md",
      });
      expect(moved.isError).toBeFalsy();
      // Rebound read-only before the save: the save refuses the manuscript create.
      const [binding] = await db.select().from(schema.threadAgentBindings);
      await db
        .update(schema.threadAgentBindings)
        .set({ configuration: { ...binding?.configuration, permission: "read" } as never })
        .where(eq(schema.threadAgentBindings.threadId, THREAD.threadId));

      const saved = await script.runtime.app.responseWrites.commitResponse(
        reply.responseId,
        THREAD,
      );
      expect(saved).toMatchObject({ status: "committed", refused: [expect.anything()] });
      const [kept] = await db
        .select()
        .from(schema.documents)
        .where(eq(schema.documents.name, "kept"));
      expect(kept?.deletedAt).not.toBeNull();
      expect(await db.select().from(schema.agentNamespaceChanges)).toEqual([]);
    });
  });
}
