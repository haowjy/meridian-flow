/** Production-composition regression for response credit and staged-push completion. */

import { Hocuspocus } from "@hocuspocus/server";
import { renderAgentEditResult, splitHashline } from "@meridian/agent-edit";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("production-composed branch settlement (postgres)", () => {});
} else {
  describe("production-composed branch settlement (postgres)", async () => {
    const schema = await import("@meridian/database/schema");
    const { conformanceUserValues } = await import(
      "@meridian/database/__test-support__/db-fixtures"
    );
    const { useRollbackTestDatabase, deleteDrizzleRows } = await import(
      "../test-support/drizzle-reset.js"
    );
    const { createInMemoryEventSink, createNoopEventSink } = await import(
      "../domains/observability/index.js"
    );
    const { composeAppServices, createProductionAppPorts } = await import("./compose.js");

    const USER_ID = "00000000-0000-4000-8000-000000000901";
    const PROJECT_ID = "00000000-0000-4000-8000-000000000902";
    const SOURCE_ID = "00000000-0000-4000-8000-000000000903";
    const WORK_ID = "00000000-0000-4000-8000-000000000904";
    const NO_WORK_ID = "00000000-0000-4000-8000-000000000911";
    const THREAD_ID = "00000000-0000-4000-8000-000000000905";
    const TURN_ID = "00000000-0000-4000-8000-000000000906";
    const DOC_ID = "00000000-0000-4000-8000-000000000907";
    const RESPONSE_ID = "00000000-0000-4000-8000-000000000908";
    const database = useRollbackTestDatabase(DATABASE_URL, {
      max: 4,
      prepareSuite: (db) => deleteDrizzleRows(db, [schema.users]),
    });
    let db = database.current;
    const composedApps: Array<{ shutdown(): Promise<void> }> = [];
    afterEach(async () => {
      await Promise.all(composedApps.splice(0).map((app) => app.shutdown()));
    });
    beforeEach(async () => {
      db = database.current;
      await db.insert(schema.users).values(conformanceUserValues(USER_ID, "runtime-settlement"));
      await db.insert(schema.projects).values({
        id: PROJECT_ID,
        userId: USER_ID,
        name: "Runtime settlement",
        slug: "runtime-settlement",
      });
      await db.insert(schema.works).values({
        id: WORK_ID,
        projectId: PROJECT_ID,
        createdByUserId: USER_ID,
        name: "Runtime settlement",
        slug: "runtime-settlement",
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
        name: "runtime-settlement",
        extension: "md",
        fileType: "markdown",
      });
      await db.insert(schema.threads).values({
        rootThreadId: THREAD_ID,
        id: THREAD_ID,
        projectId: PROJECT_ID,
        createdByUserId: USER_ID,
        title: "Runtime settlement",
        kind: "primary",
        status: "idle",
      });
      await db.insert(schema.turns).values({
        id: TURN_ID,
        threadId: THREAD_ID,
        position: 1,
        role: "assistant",
        origin: "assistant",
        status: "complete",
      });
      await db.insert(schema.threadWorks).values({
        threadId: THREAD_ID,
        workId: WORK_ID,
        projectId: PROJECT_ID,
        isPrimary: true,
      });
    });

    it("returns a structured history tool error for a removed bound model", async () => {
      const runtime = await composeRuntime();
      try {
        await runtime.app.agentRevisions.bindThread(
          THREAD_ID,
          null,
          {
            model: "removed-history-model",
            skills: { load: [], available: [] },
            namedTargets: [],
          },
          null,
        );
        const result = await runtime.app.toolExecutor.executeTool(
          {
            id: "history-unavailable",
            name: "thread_history",
            arguments: {},
          },
          { threadId: THREAD_ID, turnId: TURN_ID, agentSlug: null },
        );
        // The refusal keeps its typed shape beside the rendered text.
        expect(result).toMatchObject({
          isError: true,
          result: { code: "model_unavailable", message: "Model not found: removed-history-model" },
        });
        expect(result.output).toBe("Model not found: removed-history-model (model_unavailable)");
      } finally {
        await unloadRuntime(runtime.hocuspocus);
      }
    });

    it("S10 hard-delete evidence survives cold composition", () => runScenario(true));

    it("reports writer prose overwritten without a concurrent edit", () => runScenario(false));

    it("keeps scratch live in a draft-mode Work and names the draft on drafted writes", async () => {
      await db
        .update(schema.works)
        .set({ aiWriteMode: "draft" })
        .where(eq(schema.works.id, WORK_ID));
      const runtime = await composeRuntime();
      try {
        await runtime.ports.documentSync.writeDocument({
          documentId: DOC_ID,
          markdown: "Writer live content.",
          origin: { type: "user", actorUserId: USER_ID },
          threadId: THREAD_ID,
        });
        await runtime.ports.documentSync.recordManifestDocumentCreated(DOC_ID, {
          projectId: PROJECT_ID,
        });
        await db.insert(schema.modelResponses).values({
          id: RESPONSE_ID,
          turnId: TURN_ID,
          sequence: 1,
          provider: "runtime-test",
          model: "runtime-test",
          requestMessageCount: 1,
          predictedCacheState: "cold",
          predictedCacheReason: "facts_unavailable",
        });
        const toolContext = {
          threadId: THREAD_ID,
          turnId: TURN_ID,
          responseId: RESPONSE_ID,
          agentSlug: null,
        } as const;
        const call = (id: string, name: string, args: Record<string, unknown>) =>
          runtime.app.toolExecutor.executeTool({ id, name, arguments: args }, toolContext);

        const notes = await call("00000000-0000-4000-8000-000000000920", "write", {
          command: "create",
          path: "scratch://notes.md",
          content: "Scratch notes.",
        });
        expect(notes.isError).toBeFalsy();
        expect(notes.output).toMatch(
          /^status: success; path: scratch:\/\/notes\.md; write: w\d+\n/,
        );
        expect(notes.result).toMatchObject({ destination: "live" });

        await call("00000000-0000-4000-8000-000000000921", "read", {
          path: "manuscript://runtime-settlement.md",
        });
        const chapter = await call("00000000-0000-4000-8000-000000000922", "write", {
          command: "replace",
          path: "manuscript://runtime-settlement.md",
          find: "Writer live content.",
          content: "Model draft content.",
          all: true,
        });
        expect(chapter.isError).toBeFalsy();
        expect(chapter.output).toMatch(/write: w\d+ \(drafted in @runtime-settlement\)/);
        expect(chapter.result).toMatchObject({
          destination: "draft",
          draftWork: "runtime-settlement",
        });

        await runtime.ports.documentSync.finalizeResponseCommit(RESPONSE_ID, {
          threadId: THREAD_ID,
          turnId: TURN_ID,
        });
        const branches = await db
          .select({ documentId: schema.documentBranches.documentId })
          .from(schema.documentBranches);
        expect([...new Set(branches.map((branch) => branch.documentId))]).not.toContain(
          (notes.metadata as { documentId?: string } | undefined)?.documentId,
        );
        const scratchRead = await call("00000000-0000-4000-8000-000000000923", "read", {
          path: "scratch://notes.md",
        });
        expect(scratchRead.output).toContain("Scratch notes.");
        const live = await runtime.ports.documentSync.readAsMarkdown(DOC_ID);
        expect(live.ok && live.value.trim()).toBe("Writer live content.");
      } finally {
        await unloadRuntime(runtime.hocuspocus);
      }
    });

    it("reads, searches and lists the version your writes change in a draft-mode Work", async () => {
      await db
        .update(schema.works)
        .set({ aiWriteMode: "draft" })
        .where(eq(schema.works.id, WORK_ID));
      const runtime = await composeRuntime();
      try {
        await runtime.ports.documentSync.writeDocument({
          documentId: DOC_ID,
          markdown: "Writer live content.\n\nWriter aside.",
          origin: { type: "user", actorUserId: USER_ID },
          threadId: THREAD_ID,
        });
        await runtime.ports.documentSync.recordManifestDocumentCreated(DOC_ID, {
          projectId: PROJECT_ID,
        });
        await db.insert(schema.modelResponses).values({
          id: RESPONSE_ID,
          turnId: TURN_ID,
          sequence: 1,
          provider: "runtime-test",
          model: "runtime-test",
          requestMessageCount: 1,
          predictedCacheState: "cold",
          predictedCacheReason: "facts_unavailable",
        });
        const toolContext = {
          threadId: THREAD_ID,
          turnId: TURN_ID,
          responseId: RESPONSE_ID as string,
          agentSlug: null,
        };
        let callCount = 930;
        const call = (name: string, args: Record<string, unknown>) => {
          callCount += 1;
          return runtime.app.toolExecutor.executeTool(
            { id: `00000000-0000-4000-8000-000000000${callCount}`, name, arguments: args },
            toolContext,
          );
        };
        const chapterPath = "manuscript://runtime-settlement.md";
        const text = (result: { output: unknown }) =>
          typeof result.output === "string" ? result.output : JSON.stringify(result.output);

        const liveBefore = await call("read", { path: chapterPath, version: "live" });
        const asideLine = text(liveBefore)
          .split("\n")
          .find((line: string) => line.endsWith("|Writer aside."));
        const liveHash = splitHashline(asideLine ?? "")?.hash;
        expect(liveHash).toBeTruthy();
        await call("read", { path: chapterPath });
        const removed = await call("write", { command: "remove", path: chapterPath, in: liveHash });
        expect(removed.isError).toBeFalsy();
        const drafted = await call("write", {
          command: "replace",
          path: chapterPath,
          find: "Writer live content.",
          content: "Model draft content.",
          all: true,
        });
        expect(drafted.output).toMatch(/\(drafted in @runtime-settlement\)/);
        // Scratch is live in every Work (D9); a search in the same reply sees the new notes.
        const notes = await call("write", {
          command: "create",
          path: "scratch://notes.md",
          content: "Scratch needle notes.",
        });
        expect(notes.result).toMatchObject({ destination: "live" });
        const scratchHits = await call("search", { pattern: "Scratch needle" });
        expect(text(scratchHits)).toContain("scratch://@runtime-settlement/notes.md");
        expect(text(scratchHits)).toContain('"version":"live"');
        const qualifiedHits = await call("search", {
          pattern: "Scratch needle",
          scope: "scratch://@runtime-settlement",
        });
        expect(text(qualifiedHits)).toContain('"version":"live"');
        const qualifiedList = await call("ls", { path: "scratch://@runtime-settlement" });
        expect(text(qualifiedList)).toContain("notes.md");

        await runtime.ports.documentSync.finalizeResponseCommit(RESPONSE_ID, {
          threadId: THREAD_ID,
          turnId: TURN_ID,
        });
        const nextResponseId = "00000000-0000-4000-8000-000000000929";
        await db.insert(schema.modelResponses).values({
          id: nextResponseId,
          turnId: TURN_ID,
          sequence: 2,
          provider: "runtime-test",
          model: "runtime-test",
          requestMessageCount: 1,
          predictedCacheState: "cold",
          predictedCacheReason: "facts_unavailable",
        });
        toolContext.responseId = nextResponseId;

        const draftRead = await call("read", { path: chapterPath });
        expect(draftRead.output).toContain("version: draft");
        expect(draftRead.output).toContain("Model draft content.");
        expect(draftRead.result).toMatchObject({ read: { version: "draft" } });
        const liveRead = await call("read", { path: chapterPath, version: "live" });
        expect(liveRead.output).toContain("version: live");
        expect(liveRead.output).toContain("Writer live content.");
        expect(liveRead.output).toContain("Writer aside.");
        expect(liveRead.output).not.toContain("Model draft content.");

        // The last read was the draft, so the stale live hash reaches the resolver.
        await call("read", { path: chapterPath });
        const stale = await call("write", {
          command: "replace",
          path: chapterPath,
          in: liveHash,
          content: "Never lands.",
        });
        expect(stale.isError).toBe(true);
        expect(text(stale)).toContain(
          `Block hash "${liveHash}" was not found in the version your writes change. Hashes from \`version: "live"\` can't target it; read again without \`version\`.`,
        );

        const draftHits = await call("search", { pattern: "Model draft" });
        expect(text(draftHits)).toContain('"version":"draft"');
        expect(text(draftHits)).toContain(chapterPath);
        const liveHits = await call("search", { pattern: "Model draft", version: "live" });
        expect(text(liveHits)).not.toContain(chapterPath);
        const publishedHits = await call("search", { pattern: "Writer live", version: "live" });
        expect(text(publishedHits)).toContain('"version":"live"');

        const lore = await call("write", {
          command: "create",
          path: "kb://lore.md",
          content: "Drafted lore needle.",
        });
        expect(lore.isError).toBeFalsy();
        expect(lore.output).toMatch(/\(drafted in @runtime-settlement\)/);
        const loreHits = await call("search", { pattern: "lore needle" });
        expect(text(loreHits)).toContain("kb://lore.md");
        expect(text(loreHits)).toContain('"version":"draft"');
        const listed = await call("ls", { path: "kb://" });
        expect(text(listed)).toContain("kb://lore.md");
        const listedLive = await call("ls", { path: "kb://", version: "live" });
        expect(text(listedLive)).not.toContain("kb://lore.md");
      } finally {
        await unloadRuntime(runtime.hocuspocus);
      }
    });

    it("copies into the draft for manuscript and live for scratch in a draft-mode Work", async () => {
      await db
        .update(schema.works)
        .set({ aiWriteMode: "draft" })
        .where(eq(schema.works.id, WORK_ID));
      const runtime = await composeRuntime();
      try {
        await runtime.ports.documentSync.writeDocument({
          documentId: DOC_ID,
          markdown: "Writer live content.\n\nWriter aside.",
          origin: { type: "user", actorUserId: USER_ID },
          threadId: THREAD_ID,
        });
        await runtime.ports.documentSync.recordManifestDocumentCreated(DOC_ID, {
          projectId: PROJECT_ID,
        });
        const responseValues = (id: string, sequence: number) => ({
          id,
          turnId: TURN_ID,
          sequence,
          provider: "runtime-test",
          model: "runtime-test",
          requestMessageCount: 1,
          predictedCacheState: "cold" as const,
          predictedCacheReason: "facts_unavailable" as const,
        });
        await db.insert(schema.modelResponses).values(responseValues(RESPONSE_ID, 1));
        const toolContext = {
          threadId: THREAD_ID,
          turnId: TURN_ID,
          responseId: RESPONSE_ID as string,
          agentSlug: null,
        };
        let callCount = 950;
        const call = (name: string, args: Record<string, unknown>) => {
          callCount += 1;
          return runtime.app.toolExecutor.executeTool(
            { id: `00000000-0000-4000-8000-000000000${callCount}`, name, arguments: args },
            toolContext,
          );
        };
        const chapterPath = "manuscript://runtime-settlement.md";

        const draftCopy = await call("write", {
          command: "copy",
          from: { path: chapterPath },
          path: "manuscript://chapter-copy.md",
        });
        expect(draftCopy.isError).toBeFalsy();
        expect(draftCopy.output).toMatch(
          /^status: success; path: manuscript:\/\/chapter-copy\.md; write: w\d+ \(drafted in @runtime-settlement\); copied: 2 blocks from manuscript:\/\/runtime-settlement\.md$/,
        );
        expect(draftCopy.result).toMatchObject({ destination: "draft", command: "copy" });

        const scratchCopy = await call("write", {
          command: "copy",
          from: { path: chapterPath },
          path: "scratch://chapter-copy.md",
        });
        expect(scratchCopy.isError).toBeFalsy();
        expect(scratchCopy.result).toMatchObject({ destination: "live" });
        expect(scratchCopy.output).not.toContain("Writer live content.");

        // Block copies: from the scratch copy staged in this reply into the drafted chapter,
        // and from the chapter into scratch.
        await call("read", { path: chapterPath });
        const intoChapter = await call("write", {
          command: "insert",
          path: chapterPath,
          from: { path: "scratch://chapter-copy.md", in: 2 },
        });
        expect(intoChapter.isError).toBeFalsy();
        expect(intoChapter.output).toMatch(
          /\(drafted in @runtime-settlement\); copied: 1 block from scratch:\/\/chapter-copy\.md\n\n[0-9a-f]+\|Writer aside\.$/,
        );
        const intoScratch = await call("write", {
          command: "insert",
          path: "scratch://chapter-copy.md",
          from: { path: chapterPath, in: 1, version: "live" },
        });
        expect(intoScratch.isError).toBeFalsy();
        expect(intoScratch.result).toMatchObject({ destination: "live" });

        await runtime.ports.documentSync.finalizeResponseCommit(RESPONSE_ID, {
          threadId: THREAD_ID,
          turnId: TURN_ID,
        });
        const nextResponseId = "00000000-0000-4000-8000-000000000949";
        await db.insert(schema.modelResponses).values(responseValues(nextResponseId, 2));
        toolContext.responseId = nextResponseId;

        const live = await runtime.ports.documentSync.readAsMarkdown(DOC_ID);
        expect(live.ok && live.value.trim()).toBe("Writer live content.\n\nWriter aside.");
        const draftChapter = await call("read", { path: chapterPath });
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
            copiedFrom: {
              uri: chapterPath,
              version: "draft",
              revision: expect.any(String),
            },
          });
        }
      } finally {
        await unloadRuntime(runtime.hocuspocus);
      }
    });

    it("rolls a copy back with its reply", async () => {
      const runtime = await composeRuntime();
      try {
        await runtime.ports.documentSync.writeDocument({
          documentId: DOC_ID,
          markdown: "Writer live content.",
          origin: { type: "user", actorUserId: USER_ID },
          threadId: THREAD_ID,
        });
        await runtime.ports.documentSync.recordManifestDocumentCreated(DOC_ID, {
          projectId: PROJECT_ID,
        });
        await db.insert(schema.modelResponses).values({
          id: RESPONSE_ID,
          turnId: TURN_ID,
          sequence: 1,
          provider: "runtime-test",
          model: "runtime-test",
          requestMessageCount: 1,
          predictedCacheState: "cold",
          predictedCacheReason: "facts_unavailable",
        });
        const copied = await runtime.app.toolExecutor.executeTool(
          {
            id: "00000000-0000-4000-8000-000000000960",
            name: "write",
            arguments: {
              command: "copy",
              from: { path: "manuscript://runtime-settlement.md" },
              path: "manuscript://rolled-back.md",
            },
          },
          { threadId: THREAD_ID, turnId: TURN_ID, responseId: RESPONSE_ID, agentSlug: null },
        );
        expect(copied.isError).toBeFalsy();
        const documentId = (copied.metadata as { documentId?: string } | undefined)?.documentId;
        expect(documentId).toBeTruthy();

        const rolledBack = await runtime.ports.documentSync.finalizeResponseRollback(RESPONSE_ID, {
          threadId: THREAD_ID,
          turnId: TURN_ID,
        });

        expect(rolledBack.stagedCreates.discarded).toContain(documentId);
        const content = await runtime.ports.documentSync.readAsMarkdown(documentId as string);
        expect(content.ok ? content.value.trim() : "").toBe("");
      } finally {
        await unloadRuntime(runtime.hocuspocus);
      }
    });

    it("copies a binary file as a new stored object with its provenance", async () => {
      const runtime = await composeRuntime();
      try {
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

        const copied = await runtime.app.toolExecutor.executeTool(
          {
            id: "00000000-0000-4000-8000-000000000970",
            name: "write",
            arguments: {
              command: "copy",
              from: { path: "manuscript://scan.pdf" },
              path: "scratch://scan-copy.pdf",
            },
          },
          { threadId: THREAD_ID, turnId: TURN_ID, agentSlug: null },
        );

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

        const again = await runtime.app.toolExecutor.executeTool(
          {
            id: "00000000-0000-4000-8000-000000000971",
            name: "write",
            arguments: {
              command: "copy",
              from: { path: "manuscript://scan.pdf" },
              path: "scratch://scan-copy.pdf",
            },
          },
          { threadId: THREAD_ID, turnId: TURN_ID, agentSlug: null },
        );
        expect(again.isError).toBe(true);
        expect(again.output).toContain("A binary copy can't replace an existing file.");

        const binaryRead = await runtime.app.toolExecutor.executeTool(
          {
            id: "00000000-0000-4000-8000-000000000972",
            name: "read",
            arguments: { path: "manuscript://scan.pdf" },
          },
          { threadId: THREAD_ID, turnId: TURN_ID, agentSlug: null },
        );
        expect(binaryRead.isError).toBe(true);
        expect(binaryRead.output).toBe(
          "status: binary_file; path: manuscript://scan.pdf\n\nThe file is binary, so it can't be read as text.",
        );

        const binaryWrite = await runtime.app.toolExecutor.executeTool(
          {
            id: "00000000-0000-4000-8000-000000000974",
            name: "write",
            arguments: { command: "insert", path: "manuscript://scan.pdf", content: "Text." },
          },
          { threadId: THREAD_ID, turnId: TURN_ID, agentSlug: null },
        );
        expect(binaryWrite.isError).toBe(true);
        expect(binaryWrite.output).toBe(
          "status: binary_file; path: manuscript://scan.pdf\n\nThe file is binary, so it can't be edited as text.",
        );

        const binaryBlockCopy = await runtime.app.toolExecutor.executeTool(
          {
            id: "00000000-0000-4000-8000-000000000975",
            name: "write",
            arguments: {
              command: "insert",
              path: "scratch://notes.md",
              from: { path: "manuscript://scan.pdf", in: 1 },
            },
          },
          { threadId: THREAD_ID, turnId: TURN_ID, agentSlug: null },
        );
        expect(binaryBlockCopy.isError).toBe(true);
        expect(binaryBlockCopy.output).toBe(
          "status: binary_file\n\nfrom manuscript://scan.pdf: The file is binary, so its blocks can't be copied.",
        );

        const missingSource = await runtime.app.toolExecutor.executeTool(
          {
            id: "00000000-0000-4000-8000-000000000973",
            name: "write",
            arguments: {
              command: "copy",
              from: { path: "manuscript://no-such-source.md" },
              path: "scratch://from-missing.md",
            },
          },
          { threadId: THREAD_ID, turnId: TURN_ID, agentSlug: null },
        );
        expect(missingSource.isError).toBe(true);
        expect(missingSource.output).toBe(
          "status: document_not_found\n\nfrom manuscript://no-such-source.md: File not found. Read the project to find the right path.",
        );
      } finally {
        await unloadRuntime(runtime.hocuspocus);
      }
    });

    it("writes a No Work draft onto a branch keyed by the locked Work", async () => {
      await db.insert(schema.works).values({
        id: NO_WORK_ID,
        projectId: PROJECT_ID,
        createdByUserId: USER_ID,
        name: "No Work",
        slug: null,
        isNoWork: true,
        aiWriteMode: "draft",
      });
      await db.delete(schema.threadWorks).where(eq(schema.threadWorks.threadId, THREAD_ID));
      await db.insert(schema.threadWorks).values({
        threadId: THREAD_ID,
        workId: NO_WORK_ID,
        projectId: PROJECT_ID,
        isPrimary: true,
      });
      const eventSink = createInMemoryEventSink();
      const runtime = await composeRuntime(eventSink);
      await runtime.ports.documentSync.writeDocument({
        documentId: DOC_ID,
        markdown: "Writer live content.",
        origin: { type: "user", actorUserId: USER_ID },
        threadId: THREAD_ID,
      });
      await runtime.ports.documentSync.recordManifestDocumentCreated(DOC_ID, {
        projectId: PROJECT_ID,
      });
      await db.insert(schema.modelResponses).values({
        id: RESPONSE_ID,
        turnId: TURN_ID,
        sequence: 1,
        provider: "runtime-test",
        model: "runtime-test",
        requestMessageCount: 1,
        predictedCacheState: "cold",
        predictedCacheReason: "facts_unavailable",
      });

      const toolContext = {
        threadId: THREAD_ID,
        turnId: TURN_ID,
        responseId: RESPONSE_ID,
        agentSlug: null,
      } as const;
      const read = await runtime.app.toolExecutor.executeTool(
        {
          id: "00000000-0000-4000-8000-000000000910",
          name: "read",
          arguments: { path: "manuscript://runtime-settlement.md" },
        },
        toolContext,
      );
      if (read.isError) throw new Error(JSON.stringify(read.output));

      const result = await runtime.app.toolExecutor.executeTool(
        {
          id: "00000000-0000-4000-8000-000000000909",
          name: "write",
          arguments: {
            command: "replace",
            path: "manuscript://runtime-settlement.md",
            find: "Writer live content.",
            content: "Model draft content.",
            all: true,
          },
        },
        toolContext,
      );

      if (result.isError) {
        throw new Error(JSON.stringify({ output: result.output, events: eventSink.events }));
      }
      await runtime.ports.documentSync.finalizeResponseCommit(RESPONSE_ID, {
        threadId: THREAD_ID,
        turnId: TURN_ID,
      });
      const live = await runtime.ports.documentSync.readAsMarkdown(DOC_ID);
      expect(live.ok && live.value.trim()).toBe("Writer live content.");
      const drafts = await db
        .select({
          documentId: schema.documentBranches.documentId,
          workId: schema.documentBranches.workId,
        })
        .from(schema.documentBranches)
        .where(
          and(
            eq(schema.documentBranches.kind, "work_draft"),
            eq(schema.documentBranches.documentId, DOC_ID),
          ),
        );
      expect(drafts).toEqual([{ documentId: DOC_ID, workId: NO_WORK_ID }]);
      expect(await db.select().from(schema.threadWorks)).toEqual([
        expect.objectContaining({
          threadId: THREAD_ID,
          workId: NO_WORK_ID,
          isPrimary: true,
        }),
      ]);
      await unloadRuntime(runtime.hocuspocus);
    });

    async function runScenario(writerAfterRead: boolean): Promise<void> {
      let runtime = await composeRuntime();
      let { ports, app } = runtime;

      await ports.documentSync.writeDocument({
        documentId: DOC_ID,
        markdown: "Writer V1 observed.",
        origin: { type: "user", actorUserId: USER_ID },
        threadId: THREAD_ID,
      });
      await db.insert(schema.modelResponses).values({
        id: RESPONSE_ID,
        turnId: TURN_ID,
        sequence: 1,
        provider: "runtime-test",
        model: "runtime-test",
        requestMessageCount: 1,
        predictedCacheState: "cold",
        predictedCacheReason: "facts_unavailable",
      });
      await ports.documentSync.agentEdit().read(
        { file: "runtime-settlement.md", documentId: DOC_ID },
        {
          sessionId: "runtime-settlement",
          destination: { kind: "draft", workId: WORK_ID, workSlug: "runtime-settlement" },
          threadId: THREAD_ID,
          turnId: TURN_ID,
          responseId: RESPONSE_ID,
        },
      );

      const room = await runtime.hocuspocus.openDirectConnection(DOC_ID);
      if (!room.document) throw new Error("live production room is unavailable");
      if (writerAfterRead) {
        const writerReplica = new Y.Doc({ gc: false });
        Y.applyUpdate(writerReplica, Y.encodeStateAsUpdate(room.document));
        const fragment = writerReplica.getXmlFragment("prosemirror");
        fragment.delete(0, fragment.length);
        const left = new Y.XmlElement("paragraph");
        left.push([new Y.XmlText("Writer V2")]);
        const right = new Y.XmlElement("paragraph");
        right.push([new Y.XmlText(" unseen.")]);
        fragment.push([left, right]);
        // Rejoin after a real split so the repeated full-state sync contains both
        // tombstoned and current structs instead of a fixture-shaped text delta.
        fragment.delete(0, fragment.length);
        const rejoined = new Y.XmlElement("paragraph");
        rejoined.push([new Y.XmlText("Writer V2 unseen.")]);
        fragment.push([rejoined]);
        const repeatedFullSync = Y.encodeStateAsUpdate(writerReplica);
        await ports.documentSync.admitLiveWriterUpdate({
          documentId: DOC_ID,
          document: room.document,
          update: repeatedFullSync,
          origin: { type: "user", userId: USER_ID },
          // B2 generation fence (R6b): this test admits against the freshly
          // created document's initial authority generation.
          expectedGeneration: 1n,
        });
        Y.applyUpdate(room.document, repeatedFullSync);
        writerReplica.destroy();
      }

      const insert = await ports.documentSync.agentEdit().write(
        {
          command: "insert",
          file: "runtime-settlement.md",
          documentId: DOC_ID,
          content: "Agent prelude.",
        },
        {
          sessionId: "runtime-settlement",
          destination: { kind: "draft", workId: WORK_ID, workSlug: "runtime-settlement" },
          threadId: THREAD_ID,
          turnId: TURN_ID,
          responseId: RESPONSE_ID,
        },
      );
      if (insert.status !== "success") throw new Error(renderAgentEditResult(insert.result));
      const write = await ports.documentSync.agentEdit().write(
        {
          command: "replace",
          file: "runtime-settlement.md",
          documentId: DOC_ID,
          content: "Agent final.",
          find: writerAfterRead ? "Writer V2 unseen." : "Writer V1 observed.",
          all: true,
        },
        {
          sessionId: "runtime-settlement",
          destination: { kind: "draft", workId: WORK_ID, workSlug: "runtime-settlement" },
          threadId: THREAD_ID,
          turnId: TURN_ID,
          responseId: RESPONSE_ID,
        },
      );
      if (write.status !== "success") throw new Error(renderAgentEditResult(write.result));
      await ports.documentSync.finalizeResponseCommit(RESPONSE_ID, {
        threadId: THREAD_ID,
        turnId: TURN_ID,
      });
      await app.changeTrailDelivery.drain();

      const live = await ports.documentSync.readAsMarkdown(DOC_ID);
      expect(live.ok && live.value.trim()).toBe("Agent final.\n\nAgent prelude.");
      const [settlement] = await db.select().from(schema.branchPushSettlementOutbox);
      expect(settlement).toMatchObject({ state: "completed" });
      const trails = await db.select().from(schema.changeTrailShells);
      expect(trails).toHaveLength(1);
      const [trail] = trails;
      expect(trail?.changeCount).toBeGreaterThan(0);
      const [details] = await db.select().from(schema.changeTrailDocumentDetails);
      const beforeBodies = (
        (details?.changes ?? []) as Array<{ beforeText?: string | null }>
      ).flatMap((change) => {
        if (!change.beforeText) return [];
        return [(splitHashline(change.beforeText)?.body ?? change.beforeText).trim()];
      });
      expect(beforeBodies).toContain(writerAfterRead ? "Writer V2 unseen." : "Writer V1 observed.");
      expect(details?.changes).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ writerImpact: expect.anything() })]),
      );
      await room.disconnect();
      await unloadRuntime(runtime.hocuspocus);

      if (writerAfterRead) {
        // Drop every warm composition object; the next assertions can only use
        // the journal, settlement, and trail rows in PostgreSQL.
        runtime = await composeRuntime();
        ({ ports, app } = runtime);
        const cold = await ports.documentSync.readAsMarkdown(DOC_ID);
        expect(cold.ok && cold.value).toContain("Agent final.");

        await unloadRuntime(runtime.hocuspocus);

        await db
          .update(schema.documents)
          .set({ deletedAt: new Date() })
          .where(eq(schema.documents.id, DOC_ID));
        runtime = await composeRuntime();
        ({ ports, app } = runtime);
        const [reloaded] = await app.changeTrails.readDetails({
          threadId: THREAD_ID,
          trailId: trail.id,
          userId: USER_ID,
        });
        const retained = reloaded as {
          anchorState?: "available" | "deleted";
          changes?: Array<{ beforeText?: string | null }>;
        };
        const retainedChange = retained.changes?.find((candidate) =>
          candidate.beforeText?.includes("Writer V2 unseen."),
        );
        expect(retained.anchorState).toBe("deleted");
        expect(retainedChange?.beforeText).toContain("Writer V2 unseen.");
        await unloadRuntime(runtime.hocuspocus);
      }
    }

    async function composeRuntime(eventSink = createNoopEventSink()) {
      const ports = await createProductionAppPorts({
        db,
        eventSink,
        environment: { OPENAI_API_KEY: "sk-test-runtime-composition" },
      });
      const server = new Hocuspocus({
        yDocOptions: { gc: false, gcFilter: () => true },
        async onLoadDocument({ documentName, document }) {
          const state = await ports.documentSync.loadHocuspocusDocument(documentName);
          if (state) Y.applyUpdate(document, state);
        },
        onStoreDocument: ({ documentName, document }) =>
          ports.documentSync.storeHocuspocusDocument(documentName, document),
      });
      ports.documentSync.bindHocuspocus(server);
      const app = composeAppServices(ports);
      composedApps.push(app);
      return { ports, hocuspocus: server, app };
    }

    async function unloadRuntime(server: Hocuspocus): Promise<void> {
      for (let pass = 0; pass < 3; pass += 1) {
        await Promise.all(server.loadingDocuments.values());
        await Promise.all(
          [...server.documents.values()].map((document) => server.unloadDocument(document)),
        );
        await Promise.all(server.unloadingDocuments.values());
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
  });
}
