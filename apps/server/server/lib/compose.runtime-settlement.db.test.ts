/** Production-composition regression for response credit and staged-push settlement. */

import { renderAgentEditResult, splitHashline } from "@meridian/agent-edit";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { testFileGrant } from "../test-support/file-grants.js";

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

    it("S10 hard-delete evidence survives cold composition", () => runScenario(true));

    it("reports writer prose overwritten without a concurrent edit", () => runScenario(false));

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
      const runtime = await runtimes.compose({ eventSink });
      await runtime.ports.documentSync.writeDocument({
        documentId: DOC_ID,
        markdown: "Writer live content.",
        origin: { type: "user", actorUserId: USER_ID },
        threadId: THREAD_ID,
      });
      await runtime.ports.documentSync.recordManifestDocumentCreated(DOC_ID, {
        projectId: PROJECT_ID,
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
      await runtime.ports.documentSync.finalizeResponseCommit(responseId, {
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
      await unloadHocuspocus(runtime.hocuspocus);
    });

    async function runScenario(writerAfterRead: boolean): Promise<void> {
      let runtime = await runtimes.compose();
      let { ports, app } = runtime;

      await ports.documentSync.writeDocument({
        documentId: DOC_ID,
        markdown: "Writer V1 observed.",
        origin: { type: "user", actorUserId: USER_ID },
        threadId: THREAD_ID,
      });
      const responseId = await runtimes.insertModelResponse(THREAD);
      await ports.documentSync.agentEdit().read(
        { file: "runtime-settlement.md", documentId: DOC_ID },
        {
          sessionId: "runtime-settlement",
          grant: testFileGrant({ kind: "draft", workId: WORK_ID, workSlug: "runtime-settlement" }),
          threadId: THREAD_ID,
          turnId: TURN_ID,
          responseId: responseId,
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
          grant: testFileGrant({ kind: "draft", workId: WORK_ID, workSlug: "runtime-settlement" }),
          threadId: THREAD_ID,
          turnId: TURN_ID,
          responseId: responseId,
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
          grant: testFileGrant({ kind: "draft", workId: WORK_ID, workSlug: "runtime-settlement" }),
          threadId: THREAD_ID,
          turnId: TURN_ID,
          responseId: responseId,
        },
      );
      if (write.status !== "success") throw new Error(renderAgentEditResult(write.result));
      await ports.documentSync.finalizeResponseCommit(responseId, {
        threadId: THREAD_ID,
        turnId: TURN_ID,
      });
      // The Work is in auto-apply, but this reply wrote its draft: the writes
      // wait there (D59) until the writer applies them.
      const unapplied = await ports.documentSync.readAsMarkdown(DOC_ID);
      expect(unapplied.ok && unapplied.value.trim()).toBe(
        writerAfterRead ? "Writer V2 unseen." : "Writer V1 observed.",
      );
      const [draft] = await db
        .select({ id: schema.documentBranches.id })
        .from(schema.documentBranches)
        .where(
          and(
            eq(schema.documentBranches.kind, "work_draft"),
            eq(schema.documentBranches.documentId, DOC_ID),
          ),
        );
      if (!draft) throw new Error("the reply's draft is missing");
      await ports.documentSync.pushToLive({ branchId: draft.id, pushedByUserId: USER_ID });
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
      await unloadHocuspocus(runtime.hocuspocus);

      if (writerAfterRead) {
        // Drop every warm composition object; the next assertions can only use
        // the journal, settlement, and trail rows in PostgreSQL.
        runtime = await runtimes.compose();
        ({ ports, app } = runtime);
        const cold = await ports.documentSync.readAsMarkdown(DOC_ID);
        expect(cold.ok && cold.value).toContain("Agent final.");

        await unloadHocuspocus(runtime.hocuspocus);

        await db
          .update(schema.documents)
          .set({ deletedAt: new Date() })
          .where(eq(schema.documents.id, DOC_ID));
        runtime = await runtimes.compose();
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
        await unloadHocuspocus(runtime.hocuspocus);
      }
    }
  });
}
