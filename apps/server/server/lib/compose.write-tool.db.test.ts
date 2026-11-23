/**
 * Production-composed model `write` tool in a Work's chat: a Draft chat's writes land in its draft
 * (the chapter's fork, a drafted create) while scratch stays live; copies of a section, of a text
 * file's properties and of a binary file; and a write that changes nothing, against real
 * repositories.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - no-op write suppression
 */

import { splitHashline } from "@meridian/agent-edit";
import { type ToolContentPart, toolContentText } from "@meridian/contracts/threads";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { writeMarkdown } from "../domains/collab/test-support/bound-writes.js";
import { treeSeeder } from "../test-support/tree-seed.js";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("production-composed write tool (postgres)", () => {});
} else {
  describe("production-composed write tool (postgres)", async () => {
    const schema = await import("@meridian/database/schema");
    const { conformanceUserValues } = await import(
      "@meridian/database/__test-support__/db-fixtures"
    );
    const { createDb } = await import("@meridian/database");
    const { deleteDrizzleRows } = await import("../test-support/drizzle-reset.js");
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
    const CHAPTER = "manuscript://chapter";
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
        handle: "w1",
      });
      await db.insert(schema.contextSources).values({
        id: SOURCE_ID,
        projectId: PROJECT_ID,
        slug: "manuscript",
        scope: "project",
      });
      await db.insert(schema.contextSources).values([
        { projectId: PROJECT_ID, slug: "kb", scope: "project" },
        { workId: WORK_ID, slug: "scratch", scope: "work" },
      ]);
      await treeSeeder(db).document(SOURCE_ID, "chapter", { id: DOC_ID });
      await db.insert(schema.threads).values({
        rootThreadId: THREAD.threadId,
        id: THREAD.threadId,
        projectId: PROJECT_ID,
        createdByUserId: USER_ID,
        title: "Draft-mode tools",
        kind: "primary",
        aiWriteMode: "draft",
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
      return runtimes.script(runtime, THREAD);
    }

    const text = (result: { content: ToolContentPart[] }) => toolContentText(result.content);

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
        path: "kb://lore",
        content: "Drafted lore needle.",
      });
      expect(lore.result).toMatchObject({ destination: "draft" });
      // Scratch is live in every Work.
      const notes = await call("write", {
        command: "create",
        path: "scratch://notes",
        content: "Scratch needle notes.",
      });
      expect(notes.result).toMatchObject({ destination: "live" });

      call = (await script.begin()).call;
      const draftRead = await call("read", { path: CHAPTER });
      expect(draftRead.result).toMatchObject({ read: { version: "draft" } });
      expect(toolContentText(draftRead.content)).toContain("Model draft content.");
      const liveRead = await call("read", { path: CHAPTER, version: "live" });
      expect(toolContentText(liveRead.content)).toContain("Writer live content.");
      expect(toolContentText(liveRead.content)).not.toContain("Model draft content.");

      // The last read was the draft, so the stale live hash reaches the resolver.
      await call("read", { path: CHAPTER });
      const stale = await call("write", {
        command: "replace",
        path: CHAPTER,
        in: liveHash,
        content: "Never lands.",
      });
      expect(stale.isError).toBe(true);

      const loreHits = await call("grep", { pattern: "lore needle" });
      expect(text(loreHits)).toContain("kb://lore");
      const listedLive = await call("ls", { path: "kb://", version: "live" });
      expect(text(listedLive)).toMatch(/^kb:\/\//);
      expect(text(listedLive)).not.toContain("lore");
    });

    it("copies the section a #fragment names", async () => {
      const script = await startWithChapter(
        "# Opening\n\nDawn.\n\n# The Midnight Duel\n\nSteel rang.\n\n# Aftermath\n\nQuiet.",
      );
      const first = await script.begin();
      const bySection = await first.call("write", {
        command: "copy",
        from: { path: `${CHAPTER}.md#the-midnight-duel` },
        path: "scratch://duel",
      });
      expect(bySection.isError).toBeFalsy();
      expect(text(bySection)).toContain(`${CHAPTER}#the-midnight-duel`);
      expect(text(bySection)).not.toContain(".md");

      const { call: next } = await script.begin();
      const duel = text(await next("read", { path: "scratch://duel" }));
      expect(duel).toContain("Steel rang.");
      expect(duel).not.toContain("Dawn.");
      expect(duel).not.toContain("Quiet.");
    });

    // I1: imported frontmatter travels with a model copy, so the copy is not a lesser document.
    it("carries the source's properties and aliases to a text copy", async () => {
      const properties = {
        format: "yaml",
        text: "# kept as written\naliases: [Gate]\nstatus: revised\n",
      };
      await db
        .update(schema.documents)
        .set({ metadata: { properties, aliases: ["Gate"] } })
        .where(eq(schema.documents.id, DOC_ID));
      const script = await startWithChapter("Writer live content.");
      const { call } = await script.begin();

      // v1: the model never sees properties; it only copies them along.
      for (const seen of [
        await call("read", { path: CHAPTER }),
        await call("ls", { path: "manuscript://" }),
        await call("search", { pattern: "revised" }),
      ]) {
        expect(text(seen)).not.toContain("status: revised");
        expect(text(seen)).not.toContain("kept as written");
      }

      const copied = await call("write", {
        command: "copy",
        from: { path: CHAPTER },
        path: "manuscript://gate-copy",
      });

      expect(copied.isError).toBeFalsy();
      // A Draft chat's copy is a drafted create.
      const [copy] = await db
        .select({ metadata: schema.documents.metadata })
        .from(schema.draftTreeNodes)
        .innerJoin(schema.documents, eq(schema.documents.id, schema.draftTreeNodes.id))
        .where(eq(schema.draftTreeNodes.name, "gate-copy"));
      expect(copy?.metadata).toMatchObject({
        properties,
        aliases: ["Gate"],
        copiedFrom: { uri: CHAPTER },
      });
    });

    it("stages nothing for a write that leaves the chapter unchanged", async () => {
      await db
        .update(schema.threads)
        .set({ aiWriteMode: "direct" })
        .where(eq(schema.threads.id, THREAD.threadId));
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

    // A binary copy duplicates the stored object, so the copy and its source never share one.
    it("copies a binary file as its own stored object", async () => {
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

      const { call } = await runtimes.script(runtime, THREAD).begin();
      const copied = await call("write", {
        command: "copy",
        from: { path: "manuscript://scan.pdf" },
        path: "kb://scan-copy.pdf",
      });

      expect(copied.result).toMatchObject({ status: "success", destination: "draft" });
      const [copy] = await db
        .select({ storageUrl: schema.documents.storageUrl })
        .from(schema.draftTreeNodes)
        .innerJoin(schema.documents, eq(schema.documents.id, schema.draftTreeNodes.id))
        .where(eq(schema.draftTreeNodes.name, "scan-copy.pdf"));
      expect(copy?.storageUrl).not.toBe(put.value.storageUrl);
      const key = copy?.storageUrl?.replace("object://meridian/", "") ?? "";
      const stored = await runtime.ports.objectStore.get(key);
      expect(stored.ok && [...stored.value.bytes]).toEqual([...bytes]);
    });
  });
}
