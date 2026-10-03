/**
 * Production-composed model tools in a Work: scratch stays live while drafted
 * writes name the draft (D9, D19), read, search and ls follow the version the
 * writes change (D41), and copies of text and binary files (D24).
 */

import { splitHashline } from "@meridian/agent-edit";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

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
    const { useRollbackTestDatabase, deleteDrizzleRows } = await import(
      "../test-support/drizzle-reset.js"
    );
    const { useComposedRuntimes } = await import("../test-support/composed-runtime.js");

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
    const database = useRollbackTestDatabase(DATABASE_URL, {
      max: 4,
      prepareSuite: (db) => deleteDrizzleRows(db, [schema.users]),
    });
    let db = database.current;
    const runtimes = useComposedRuntimes(() => db);

    beforeEach(async () => {
      db = database.current;
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
      await runtime.ports.documentSync.writeDocument({
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

    it("keeps scratch live in a draft-mode Work and names the draft on drafted writes", async () => {
      const script = await startWithChapter("Writer live content.");
      const { call, save } = await script.begin();

      const notes = await call("write", {
        command: "create",
        path: "scratch://notes.md",
        content: "Scratch notes.",
      });
      expect(notes.isError).toBeFalsy();
      expect(notes.output).toMatch(/^status: success; path: scratch:\/\/notes\.md; write: w\d+\n/);
      expect(notes.result).toMatchObject({ destination: "live" });

      await call("read", { path: CHAPTER });
      const chapter = await call("write", {
        command: "replace",
        path: CHAPTER,
        find: "Writer live content.",
        content: "Model draft content.",
        all: true,
      });
      expect(chapter.isError).toBeFalsy();
      expect(chapter.output).toMatch(/write: w\d+ \(drafted in @rewrite\)/);
      expect(chapter.result).toMatchObject({ destination: "draft", draftWork: "rewrite" });

      await save();
      const notesId = (notes.metadata as { documentId?: unknown } | undefined)?.documentId;
      expect(notesId).toEqual(expect.any(String));
      const branches = await db
        .select({ documentId: schema.documentBranches.documentId })
        .from(schema.documentBranches);
      expect(branches.map((branch) => branch.documentId)).toContain(DOC_ID);
      expect(branches.map((branch) => branch.documentId)).not.toContain(notesId);
      expect(await script.text("scratch://notes.md")).toContain("Scratch notes.");
      const live = await script.runtime.ports.documentSync.readAsMarkdown(DOC_ID);
      expect(live.ok && live.value.trim()).toBe("Writer live content.");
    });

    it("reads, searches and lists the version your writes change in a draft-mode Work", async () => {
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
      const removed = await call("write", { command: "remove", path: CHAPTER, in: liveHash });
      expect(removed.isError).toBeFalsy();
      const drafted = await call("write", {
        command: "replace",
        path: CHAPTER,
        find: "Writer live content.",
        content: "Model draft content.",
        all: true,
      });
      expect(drafted.output).toMatch(/\(drafted in @rewrite\)/);
      // Scratch is live in every Work (D9); a search in the same reply sees the new notes.
      const notes = await call("write", {
        command: "create",
        path: "scratch://notes.md",
        content: "Scratch needle notes.",
      });
      expect(notes.result).toMatchObject({ destination: "live" });
      const scratchHits = await call("search", { pattern: "Scratch needle" });
      expect(text(scratchHits)).toContain("scratch://@rewrite/notes.md");
      expect(text(scratchHits)).toContain('"version":"live"');
      const qualifiedHits = await call("search", {
        pattern: "Scratch needle",
        scope: "scratch://@rewrite",
      });
      expect(text(qualifiedHits)).toContain('"version":"live"');
      const qualifiedList = await call("ls", { path: "scratch://@rewrite" });
      expect(text(qualifiedList)).toContain("notes.md");
      await first.save();

      call = (await script.begin()).call;
      const draftRead = await call("read", { path: CHAPTER });
      expect(draftRead.output).toContain("version: draft");
      expect(draftRead.output).toContain("Model draft content.");
      expect(draftRead.result).toMatchObject({ read: { version: "draft" } });
      const liveRead = await call("read", { path: CHAPTER, version: "live" });
      expect(liveRead.output).toContain("version: live");
      expect(liveRead.output).toContain("Writer live content.");
      expect(liveRead.output).toContain("Writer aside.");
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
      expect(text(stale)).toContain(
        `Block hash "${liveHash}" was not found in the version your writes change. Hashes from \`version: "live"\` can't target it; read again without \`version\`.`,
      );

      const draftHits = await call("search", { pattern: "Model draft" });
      expect(text(draftHits)).toContain('"version":"draft"');
      expect(text(draftHits)).toContain(CHAPTER);
      const liveHits = await call("search", { pattern: "Model draft", version: "live" });
      expect(text(liveHits)).not.toContain(CHAPTER);
      const publishedHits = await call("search", { pattern: "Writer live", version: "live" });
      expect(text(publishedHits)).toContain('"version":"live"');

      const lore = await call("write", {
        command: "create",
        path: "kb://lore.md",
        content: "Drafted lore needle.",
      });
      expect(lore.isError).toBeFalsy();
      expect(lore.output).toMatch(/\(drafted in @rewrite\)/);
      const loreHits = await call("search", { pattern: "lore needle" });
      expect(text(loreHits)).toContain("kb://lore.md");
      expect(text(loreHits)).toContain('"version":"draft"');
      const listed = await call("ls", { path: "kb://" });
      expect(text(listed)).toContain("kb://lore.md");
      const listedLive = await call("ls", { path: "kb://", version: "live" });
      expect(text(listedLive)).not.toContain("kb://lore.md");
    });

    it("copies into the draft for manuscript and live for scratch in a draft-mode Work", async () => {
      const script = await startWithChapter("Writer live content.\n\nWriter aside.");
      const first = await script.begin();
      let call = first.call;

      const draftCopy = await call("write", {
        command: "copy",
        from: { path: CHAPTER },
        path: "manuscript://chapter-copy.md",
      });
      expect(draftCopy.isError).toBeFalsy();
      expect(draftCopy.output).toMatch(
        /^status: success; path: manuscript:\/\/chapter-copy\.md; write: w\d+ \(drafted in @rewrite\); copied: 2 blocks from manuscript:\/\/chapter\.md$/,
      );
      expect(draftCopy.result).toMatchObject({ destination: "draft", command: "copy" });

      const scratchCopy = await call("write", {
        command: "copy",
        from: { path: CHAPTER },
        path: "scratch://chapter-copy.md",
      });
      expect(scratchCopy.isError).toBeFalsy();
      expect(scratchCopy.result).toMatchObject({ destination: "live" });
      expect(scratchCopy.output).not.toContain("Writer live content.");

      // Block copies: from the scratch copy staged in this reply into the drafted chapter,
      // and from the chapter into scratch.
      await call("read", { path: CHAPTER });
      const intoChapter = await call("write", {
        command: "insert",
        path: CHAPTER,
        from: { path: "scratch://chapter-copy.md", in: 2 },
      });
      expect(intoChapter.isError).toBeFalsy();
      expect(intoChapter.output).toMatch(
        /\(drafted in @rewrite\); copied: 1 block from scratch:\/\/chapter-copy\.md\n\n[0-9a-f]+\|Writer aside\.$/,
      );
      const intoScratch = await call("write", {
        command: "insert",
        path: "scratch://chapter-copy.md",
        from: { path: CHAPTER, in: 1, version: "live" },
      });
      expect(intoScratch.isError).toBeFalsy();
      expect(intoScratch.result).toMatchObject({ destination: "live" });
      await first.save();

      call = (await script.begin()).call;
      const live = await script.runtime.ports.documentSync.readAsMarkdown(DOC_ID);
      expect(live.ok && live.value.trim()).toBe("Writer live content.\n\nWriter aside.");
      const draftChapter = await call("read", { path: CHAPTER });
      expect(draftChapter.output).toMatch(/Writer aside\.\n[0-9a-f]+\|Writer aside\.$/);
      const copiedDraft = await call("read", { path: "manuscript://chapter-copy.md" });
      expect(copiedDraft.output).toContain("version: draft");
      expect(copiedDraft.output).toContain("Writer aside.");
      const copiedLive = await call("read", {
        path: "manuscript://chapter-copy.md",
        version: "live",
      });
      expect(copiedLive.isError).toBe(true);
      const scratchRead = await call("read", { path: "scratch://chapter-copy.md" });
      expect(scratchRead.output).toContain("blocks: 3; version: live");

      const copies = await db
        .select({ name: schema.documents.name, metadata: schema.documents.metadata })
        .from(schema.documents)
        .where(eq(schema.documents.name, "chapter-copy"));
      expect(copies).toHaveLength(2);
      for (const copy of copies) {
        expect(copy.metadata).toMatchObject({
          copiedFrom: { uri: CHAPTER, version: "draft", revision: expect.any(String) },
        });
      }
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

    it("copies a binary file as a new stored object with its provenance", async () => {
      await db
        .update(schema.works)
        .set({ aiWriteMode: "direct" })
        .where(eq(schema.works.id, WORK_ID));
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
      const call = (name: string, args: Record<string, unknown>) =>
        runtime.app.toolExecutor.executeTool(
          { id: crypto.randomUUID(), name, arguments: args },
          { ...THREAD, agentSlug: null },
        );

      const copied = await call("write", {
        command: "copy",
        from: { path: "manuscript://scan.pdf" },
        path: "scratch://scan-copy.pdf",
      });

      expect(copied.isError).toBeFalsy();
      expect(copied.output).toBe(
        "status: success; path: scratch://scan-copy.pdf; copied from manuscript://scan.pdf",
      );
      const [copy] = await db
        .select()
        .from(schema.documents)
        .where(eq(schema.documents.name, "scan-copy"));
      expect(copy?.storageUrl).toBeTruthy();
      expect(copy?.storageUrl).not.toBe(put.value.storageUrl);
      expect(copy?.metadata).toEqual({
        copiedFrom: { uri: "manuscript://scan.pdf", version: "live", revision: null },
      });
      const key = copy?.storageUrl?.replace("object://meridian/", "") ?? "";
      const stored = await runtime.ports.objectStore.get(key);
      expect(stored.ok && [...stored.value.bytes]).toEqual([...bytes]);

      const again = await call("write", {
        command: "copy",
        from: { path: "manuscript://scan.pdf" },
        path: "scratch://scan-copy.pdf",
      });
      expect(again.isError).toBe(true);
      expect(again.output).toContain("A binary copy can't replace an existing file.");

      const binaryRead = await call("read", { path: "manuscript://scan.pdf" });
      expect(binaryRead.isError).toBe(true);
      expect(binaryRead.output).toBe(
        "status: binary_file; path: manuscript://scan.pdf\n\nThe file is binary, so it can't be read as text.",
      );

      const binaryWrite = await call("write", {
        command: "insert",
        path: "manuscript://scan.pdf",
        content: "Text.",
      });
      expect(binaryWrite.isError).toBe(true);
      expect(binaryWrite.output).toBe(
        "status: binary_file; path: manuscript://scan.pdf\n\nThe file is binary, so it can't be edited as text.",
      );

      const binaryBlockCopy = await call("write", {
        command: "insert",
        path: "scratch://notes.md",
        from: { path: "manuscript://scan.pdf", in: 1 },
      });
      expect(binaryBlockCopy.isError).toBe(true);
      expect(binaryBlockCopy.output).toBe(
        "status: binary_file\n\nfrom manuscript://scan.pdf: The file is binary, so its blocks can't be copied.",
      );

      const missingSource = await call("write", {
        command: "copy",
        from: { path: "manuscript://no-such-source.md" },
        path: "scratch://from-missing.md",
      });
      expect(missingSource.isError).toBe(true);
      expect(missingSource.output).toBe(
        "status: document_not_found\n\nfrom manuscript://no-such-source.md: File not found. Read the project to find the right path.",
      );
    });
  });
}
