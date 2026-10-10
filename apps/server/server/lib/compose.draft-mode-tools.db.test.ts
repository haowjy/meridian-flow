/**
 * Production-composed model tools in a Work: scratch stays live while drafted
 * writes name the draft (D9, D19), read, search and ls follow the version the
 * writes change (D41), and copies of text and binary files (D24).
 */

import { splitHashline } from "@meridian/agent-edit";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { writeMarkdown } from "../domains/collab/test-support/bound-writes.js";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("production-composed model tools in a Work (postgres)", () => {});
} else {
  describe("production-composed model tools in a Work (postgres)", async () => {
    const schema = await import("@meridian/database/schema");
    const { conformanceUserValues } = await import(
      "@meridian/database/__test-support__/db-fixtures"
    );
    const { createDb } = await import("@meridian/database");
    const { deleteDrizzleRows } = await import("../test-support/drizzle-reset.js");
    const { bindEditAgent, useComposedRuntimes } = await import(
      "../test-support/composed-runtime.js"
    );
    const { draftTreeScenario } = await import("../test-support/draft-tree-scenario.js");

    const USER_ID = "00000000-0000-4000-8000-000000000e01";
    const PROJECT_ID = "00000000-0000-4000-8000-000000000e02";
    const SOURCE_ID = "00000000-0000-4000-8000-000000000e03";
    const WORK_ID = "00000000-0000-4000-8000-000000000e04";
    const THREAD = {
      threadId: "00000000-0000-4000-8000-000000000e05",
      turnId: "00000000-0000-4000-8000-000000000e06",
    };
    const DOC_ID = "00000000-0000-4000-8000-000000000e07";
    const CHAPTER = "manuscript://chapter.md";
    // Copies create documents, which repair the project catalog after commit:
    // that background work needs real commits, so this suite doesn't roll back.
    const db = createDb(DATABASE_URL, { max: 6 });
    afterAll(() => db.close());
    const runtimes = useComposedRuntimes(() => db);

    beforeEach(async () => {
      await deleteDrizzleRows(db, [schema.users]);
      await db.insert(schema.users).values(conformanceUserValues(USER_ID, "draft-mode-tools"));
      await db.insert(schema.projects).values({
        id: PROJECT_ID,
        userId: USER_ID,
        name: "Draft-mode tools",
        slug: "draft-mode-tools",
      });
      await db.insert(schema.works).values({
        id: WORK_ID,
        projectId: PROJECT_ID,
        createdByUserId: USER_ID,
        name: "Rewrite",
        slug: "rewrite",
        aiWriteMode: "draft",
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
        rootThreadId: THREAD.threadId,
        id: THREAD.threadId,
        projectId: PROJECT_ID,
        createdByUserId: USER_ID,
        title: "Draft-mode tools",
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

    /** A composed runtime with the writer's chapter already live. */
    async function startWithChapter(markdown: string) {
      const runtime = await runtimes.compose();
      await writeMarkdown(runtime.ports.documentSync, {
        documentId: DOC_ID,
        markdown,
        origin: { type: "user", actorUserId: USER_ID },
        threadId: THREAD.threadId,
      });
      await runtime.ports.documentSync.recordManifestDocumentCreated(DOC_ID, {
        projectId: PROJECT_ID,
      });
      return runtimes.script(runtime, THREAD);
    }

    const text = (result: { output: unknown }) =>
      typeof result.output === "string" ? result.output : JSON.stringify(result.output);

    it("drafts kb and manuscript, keeps scratch live, and reads the version writes change", async () => {
      const script = await startWithChapter("Writer live content.\n\nWriter aside.");
      const first = await script.begin();
      let call = first.call;

      const liveBefore = await call("read", { path: CHAPTER, version: "live" });
      const asideLine = text(liveBefore)
        .split("\n")
        .find((line: string) => line.endsWith("|Writer aside."));
      const liveHash = splitHashline(asideLine ?? "")?.hash;
      expect(liveHash).toBeTruthy();
      await call("read", { path: CHAPTER });
      await call("write", { command: "remove", path: CHAPTER, in: liveHash });
      const drafted = await call("write", {
        command: "replace",
        path: CHAPTER,
        find: "Writer live content.",
        content: "Model draft content.",
      });
      expect(drafted.result).toMatchObject({ destination: "draft" });
      const lore = await call("write", {
        command: "create",
        path: "kb://lore.md",
        content: "Drafted lore needle.",
      });
      expect(lore.result).toMatchObject({ destination: "draft" });
      // Scratch is live in every Work (D9).
      const notes = await call("write", {
        command: "create",
        path: "scratch://notes.md",
        content: "Scratch needle notes.",
      });
      expect(notes.result).toMatchObject({ destination: "live" });
      await first.save();

      call = (await script.begin()).call;
      const draftRead = await call("read", { path: CHAPTER });
      expect(draftRead.result).toMatchObject({ read: { version: "draft" } });
      expect(draftRead.output).toContain("Model draft content.");
      const liveRead = await call("read", { path: CHAPTER, version: "live" });
      expect(liveRead.output).toContain("Writer live content.");
      expect(liveRead.output).not.toContain("Model draft content.");

      // The last read was the draft, so the stale live hash reaches the resolver.
      await call("read", { path: CHAPTER });
      const stale = await call("write", {
        command: "replace",
        path: CHAPTER,
        in: liveHash,
        content: "Never lands.",
      });
      expect(stale.isError).toBe(true);

      const loreHits = await call("search", { pattern: "lore needle" });
      expect(text(loreHits)).toContain("kb://lore.md");
      const listedLive = await call("ls", { path: "kb://", version: "live" });
      expect(text(listedLive)).toMatch(/^kb:\/\//);
      expect(text(listedLive)).not.toContain("lore.md");
    });

    // D40: auto-apply writes live, but an explicit `draft` still reads what the Work kept.
    it("reads a kept draft when asked for draft in auto-apply, and live otherwise", async () => {
      const script = await startWithChapter("Writer live content.");
      const first = await script.begin();
      await first.call("read", { path: CHAPTER });
      await first.call("write", {
        command: "replace",
        path: CHAPTER,
        find: "Writer live content.",
        content: "Kept draft content.",
      });
      await first.save();
      await db
        .update(schema.works)
        .set({ aiWriteMode: "direct" })
        .where(eq(schema.works.id, WORK_ID));

      const { call } = await script.begin();
      const kept = await call("read", { path: CHAPTER, version: "draft" });
      expect(kept.result).toMatchObject({ read: { version: "draft" } });
      expect(kept.output).toContain("Kept draft content.");
      const destination = await call("read", { path: CHAPTER });
      expect(destination.result).toMatchObject({ read: { version: "live" } });
      expect(destination.output).toContain("Writer live content.");
      const notes = await call("write", {
        command: "create",
        path: "scratch://notes.md",
        content: "Notes.",
      });
      expect(notes.isError).toBeFalsy();
      const noDraft = await call("read", { path: "scratch://notes.md", version: "draft" });
      expect(noDraft.result).toMatchObject({ read: { version: "live" } });
    });

    // D31: a create or copy would make its file in the archived Work's frozen draft.
    it("refuses a create or copy into an archived draft-mode Work with D31's copy", async () => {
      const script = await startWithChapter("Writer live content.");
      await db
        .update(schema.works)
        .set({ archivedAt: new Date() })
        .where(eq(schema.works.id, WORK_ID));
      const { call } = await script.begin();
      const frozen =
        'Work @rewrite is archived, so its draft is frozen and this change wasn\'t made. Unarchive it with `work({"command":"unarchive","work":"rewrite"})`, or ask the user to switch @rewrite to auto-apply.';

      for (const args of [
        { command: "create", path: "manuscript://new.md", content: "Never lands." },
        { command: "copy", from: { path: CHAPTER }, path: "manuscript://copy.md" },
      ]) {
        const refused = await call("write", args);
        expect(refused.isError).toBe(true);
        expect(refused.result).toMatchObject({
          status: "permission_denied",
          reason: "work_archived",
        });
        expect(text(refused)).toContain(frozen);
      }
    });

    it("copies the section a #fragment names (D49)", async () => {
      const script = await startWithChapter(
        "# Opening\n\nDawn.\n\n# The Midnight Duel\n\nSteel rang.\n\n# Aftermath\n\nQuiet.",
      );
      const first = await script.begin();
      const bySection = await first.call("write", {
        command: "copy",
        from: { path: `${CHAPTER}#the-midnight-duel` },
        path: "scratch://duel.md",
      });
      expect(bySection.isError).toBeFalsy();
      await first.save();

      const { call: next } = await script.begin();
      const duel = text(await next("read", { path: "scratch://duel.md" }));
      expect(duel).toContain("Steel rang.");
      expect(duel).not.toContain("Dawn.");
      expect(duel).not.toContain("Quiet.");
    });

    it("rolls a copy back with its reply", async () => {
      await db
        .update(schema.works)
        .set({ aiWriteMode: "direct" })
        .where(eq(schema.works.id, WORK_ID));
      const script = await startWithChapter("Writer live content.");
      const { call, responseId } = await script.begin();

      const copied = await call("write", {
        command: "copy",
        from: { path: CHAPTER },
        path: "manuscript://rolled-back.md",
      });
      expect(copied.isError).toBeFalsy();
      const documentId = (copied.metadata as { documentId?: unknown } | undefined)?.documentId;
      if (typeof documentId !== "string") throw new Error("the copy reported no documentId");

      const rolledBack = await script.runtime.ports.documentSync.finalizeResponseRollback(
        responseId,
        THREAD as never,
      );

      expect(rolledBack.stagedCreates.discarded).toContain(documentId);
      const content = await script.runtime.ports.documentSync.readAsMarkdown(documentId);
      expect(content.ok ? content.value.trim() : "").toBe("");
    });

    // §12.5, O-11: a rolled-back reply retracts its draft create, unless another thread in
    // the Work already committed text to it.
    it("retracts a rolled-back reply's draft create unless another thread committed text to it (C-4)", async () => {
      const runtime = await runtimes.compose();
      const scenario = await draftTreeScenario(db, { runtime, runtimes });
      const work = await scenario.work("Retracting", "draft");
      const documentIdOf = (result: { metadata?: unknown }) => {
        const documentId = (result.metadata as { documentId?: unknown } | undefined)?.documentId;
        if (typeof documentId !== "string") throw new Error("the create reported no documentId");
        return documentId;
      };
      const rowOf = async (id: string) => {
        const [found] = await db
          .select({ hidden: schema.documents.hidden, deletedAt: schema.documents.deletedAt })
          .from(schema.documents)
          .where(eq(schema.documents.id, id));
        return found;
      };
      const usesOf = (id: string) =>
        db
          .select({ draftId: schema.draftTreeChanges.draftId })
          .from(schema.draftTreeChanges)
          .where(eq(schema.draftTreeChanges.nodeId, id));

      const alone = await scenario.model(work).reply();
      const aloneId = documentIdOf(
        await alone.call("write", {
          command: "create",
          path: "manuscript://lore/alone.md",
          content: "Never kept.",
        }),
      );
      await alone.rollback();
      expect.soft(await rowOf(aloneId), "retracted: tombstoned").toMatchObject({
        hidden: true,
        deletedAt: expect.any(Date),
      });
      expect.soft(await usesOf(aloneId), "retracted: no use left").toEqual([]);
      expect
        .soft(
          await db
            .select({ id: schema.documentBranches.id })
            .from(schema.documentBranches)
            .where(eq(schema.documentBranches.documentId, aloneId)),
          "retracted: its empty branches gone",
        )
        .toEqual([]);

      const other = await scenario.thread(work);
      const first = await scenario.model(work).reply();
      const sharedId = documentIdOf(
        await first.call("write", {
          command: "create",
          path: "manuscript://lore/shared.md",
          content: "The first thread's text.",
        }),
      );
      const second = await scenario.model(other).reply();
      await second.call("read", { path: "manuscript://lore/shared.md" });
      const inserted = await second.call("write", {
        command: "insert",
        path: "manuscript://lore/shared.md",
        content: "The second thread's line.",
      });
      expect.soft(inserted.isError ?? false, "the other thread writes").toBe(false);
      await second.save();
      await first.rollback();
      expect.soft(await rowOf(sharedId), "stands: still hidden and live").toMatchObject({
        hidden: true,
        deletedAt: null,
      });
      expect.soft(await usesOf(sharedId), "stands: the draft keeps it").toHaveLength(1);
      const read = await scenario.view(other).read("lore/shared.md");
      expect
        .soft(read.ok && read.value.content, "stands: the other thread's text")
        .toContain("The second thread's line.");

      // Two Works share one hidden identity: retracting A's create retires only A's peers.
      const workA = await scenario.work("Retracting A", "draft");
      const workB = await scenario.work("Surviving B", "draft");
      const replyA = await scenario.model(workA).reply();
      const twoWorkId = documentIdOf(
        await replyA.call("write", {
          command: "create",
          path: "manuscript://lore/two-works.md",
          content: "A's text, never kept.",
        }),
      );
      const replyB = await scenario.model(workB).reply();
      const joined = await replyB.call("write", {
        command: "create",
        path: "manuscript://lore/two-works.md",
        content: "B's unsaved contribution.",
      });
      expect.soft(documentIdOf(joined), "B joins A's hidden identity").toBe(twoWorkId);
      const bPeer = async () => {
        const [peer] = await db
          .select({ status: schema.documentBranches.status })
          .from(schema.documentBranches)
          .where(eq(schema.documentBranches.threadId, workB.threadId));
        return peer?.status;
      };
      expect.soft(await bPeer(), "B's peer before A retracts").toBe("active");
      await replyA.rollback();
      expect.soft(await bPeer(), "B's peer survives A's retraction").toBe("active");
      const saved = (await replyB.save()) as { receipts?: readonly unknown[] };
      expect
        .soft(saved.receipts ?? [], "B's overlapping reply commits with a receipt")
        .toHaveLength(1);
      expect.soft(await rowOf(twoWorkId), "B keeps the identity").toMatchObject({
        hidden: true,
        deletedAt: null,
      });
      const readB = await scenario.view(workB).read("lore/two-works.md");
      expect
        .soft(readB.ok && readB.value.content, "B's saved text")
        .toContain("B's unsaved contribution.");
    });

    it("stages nothing for a write that leaves the chapter unchanged", async () => {
      await db
        .update(schema.works)
        .set({ aiWriteMode: "direct" })
        .where(eq(schema.works.id, WORK_ID));
      const script = await startWithChapter("Writer live content.");
      const { call } = await script.begin();

      const written = await call("write", {
        command: "create",
        path: CHAPTER,
        overwrite: true,
        content: "Writer live content.",
      });

      expect(written.isError).toBeFalsy();
      expect(text(written)).toContain("unchanged:");
      expect((written.metadata as { stagedWrite?: unknown } | undefined)?.stagedWrite).toBe(
        undefined,
      );
    });

    // D24 with 12b-Q2: a binary copy duplicates the stored object; in a draft-mode Work it
    // is the draft's own hidden row, never shared and not live.
    it("copies a binary file into the draft as its own hidden row and stored object", async () => {
      const runtime = await runtimes.compose();
      const bytes = new Uint8Array([37, 80, 68, 70, 45, 49, 46, 55]);
      const put = await runtime.ports.objectStore.put(
        `uploads/${PROJECT_ID}/scan`,
        bytes,
        "application/pdf",
      );
      if (!put.ok) throw new Error(put.error.message);
      const written = await runtime.ports.contextPorts
        .forProject(PROJECT_ID, USER_ID, new Map())
        .writeBinary("manuscript://scan.pdf", {
          fileType: "pdf",
          storageUrl: put.value.storageUrl,
          mimeType: "application/pdf",
          sizeBytes: bytes.byteLength,
        });
      if (!written.ok) throw new Error(JSON.stringify(written.error));

      // Outside a reply, as a tool call with no model response.
      await bindEditAgent(runtime, THREAD.threadId);
      const copied = await runtime.app.toolExecutor.executeTool(
        {
          id: crypto.randomUUID(),
          name: "write",
          arguments: {
            command: "copy",
            from: { path: "manuscript://scan.pdf" },
            path: "kb://scan-copy.pdf",
          },
        },
        { ...THREAD, agentSlug: null },
      );

      expect(copied.result).toMatchObject({
        status: "success",
        destination: "draft",
        draftWork: "rewrite",
      });
      const [copy] = await db
        .select()
        .from(schema.documents)
        .where(eq(schema.documents.name, "scan-copy"));
      expect(copy?.hidden).toBe(true);
      expect(copy?.storageUrl).not.toBe(put.value.storageUrl);
      const created = await db
        .select({ draftId: schema.draftTreeChanges.draftId })
        .from(schema.draftTreeChanges)
        .where(eq(schema.draftTreeChanges.nodeId, copy?.id ?? ""));
      expect(created).toHaveLength(1);
      await expect(
        runtime.ports.contextPorts
          .forProject(PROJECT_ID, USER_ID, new Map())
          .stat("kb://scan-copy.pdf"),
      ).resolves.toMatchObject({ ok: false, error: { code: "not_found" } });
      const key = copy?.storageUrl?.replace("object://meridian/", "") ?? "";
      const stored = await runtime.ports.objectStore.get(key);
      expect(stored.ok && [...stored.value.bytes]).toEqual([...bytes]);
    });
  });
}
