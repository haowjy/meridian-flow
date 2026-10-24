/**
 * Production-composition regression for response credit and staged-push settlement.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - current compose runtime settlement persistence protocol
 */

import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { writeMarkdown } from "../domains/collab/test-support/bound-writes.js";

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
    const { createInMemoryEventSink } = await import("../domains/observability/index.js");
    const { bindEditAgent, unloadHocuspocus, useComposedRuntimes } = await import(
      "../test-support/composed-runtime.js"
    );

    const USER_ID = "00000000-0000-4000-8000-000000000901";
    const PROJECT_ID = "00000000-0000-4000-8000-000000000902";
    const SOURCE_ID = "00000000-0000-4000-8000-000000000903";
    const WORK_ID = "00000000-0000-4000-8000-000000000904";
    const NO_WORK_ID = "00000000-0000-4000-8000-000000000911";
    const THREAD_ID = "00000000-0000-4000-8000-000000000905";
    const TURN_ID = "00000000-0000-4000-8000-000000000906";
    const DOC_ID = "00000000-0000-4000-8000-000000000907";
    const database = useRollbackTestDatabase(DATABASE_URL, {
      max: 4,
      prepareSuite: (db) => deleteDrizzleRows(db, [schema.users]),
    });
    let db = database.current;
    const runtimes = useComposedRuntimes(() => db);
    const THREAD = { threadId: THREAD_ID, turnId: TURN_ID };
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
        handle: "w1",
        defaultAiWriteMode: "direct",
      });
      // The Work already has its branch, as if an earlier write ensured it (contract §2.5).
      await db
        .insert(schema.branches)
        .values({ projectId: PROJECT_ID, originWorkId: WORK_ID, createdBy: USER_ID });
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
        extension: "",
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
      const runtime = await runtimes.compose();
      try {
        await runtime.app.agentRevisions.bindThread(
          THREAD_ID,
          null,
          {
            model: "removed-history-model",
            skills: { load: [], available: [] },
            namedTargets: [],
            permission: "edit" as const,
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
        await unloadHocuspocus(runtime.hocuspocus);
      }
    });

    it("writes a No Work draft onto a branch keyed by the locked Work", async () => {
      await db.insert(schema.works).values({
        id: NO_WORK_ID,
        projectId: PROJECT_ID,
        createdByUserId: USER_ID,
        name: "No Work",
        handle: null,
        isNoWork: true,
      });
      await db
        .update(schema.threads)
        .set({ aiWriteMode: "draft" })
        .where(eq(schema.threads.id, THREAD_ID));
      await db.delete(schema.threadWorks).where(eq(schema.threadWorks.threadId, THREAD_ID));
      await db.insert(schema.threadWorks).values({
        threadId: THREAD_ID,
        workId: NO_WORK_ID,
        projectId: PROJECT_ID,
        isPrimary: true,
      });
      const eventSink = createInMemoryEventSink();
      const runtime = await runtimes.compose({ eventSink });
      await writeMarkdown(runtime.ports.documentSync, {
        documentId: DOC_ID,
        markdown: "Writer live content.",
        origin: { type: "user", actorUserId: USER_ID },
        threadId: THREAD_ID,
      });
      const responseId = await runtimes.insertModelResponse(THREAD);
      await bindEditAgent(runtime, THREAD_ID);

      const toolContext = {
        threadId: THREAD_ID,
        turnId: TURN_ID,
        responseId: responseId,
        agentSlug: null,
      } as const;
      const read = await runtime.app.toolExecutor.executeTool(
        {
          id: "00000000-0000-4000-8000-000000000910",
          name: "read",
          arguments: { path: "manuscript://runtime-settlement" },
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
            path: "manuscript://runtime-settlement",
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
      await runtime.ports.documentSync.finalizeResponseCommit(
        { providerResponseId: responseId, editScopeId: responseId },
        {
          threadId: THREAD_ID,
          turnId: TURN_ID,
        },
      );
      const live = await runtime.ports.documentSync.readAsMarkdown(DOC_ID);
      expect(live.ok && live.value.trim()).toBe("Writer live content.");
      const drafts = await db
        .select({
          documentId: schema.documentDrafts.documentId,
          workId: schema.branches.originWorkId,
        })
        .from(schema.documentDrafts)
        .innerJoin(schema.branches, eq(schema.branches.id, schema.documentDrafts.branchId))
        .where(
          and(
            eq(schema.documentDrafts.kind, "work_draft"),
            eq(schema.documentDrafts.documentId, DOC_ID),
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
      await unloadHocuspocus(runtime.hocuspocus);
    });
  });
}
