/** Production-composition regression for response credit and staged-push completion. */

import { Hocuspocus } from "@hocuspocus/server";
import { splitHashline } from "@meridian/agent-edit";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
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
    const { useRollbackTestDatabase } = await import("../test-support/rollback-test-database.js");
    const { truncateDrizzleTables } = await import("../test-support/drizzle-reset.js");
    const { createNoopEventSink } = await import("../domains/observability/index.js");
    const { composeAppServices, createProductionAppPorts } = await import("./compose.js");

    const USER_ID = "00000000-0000-4000-8000-000000000901";
    const PROJECT_ID = "00000000-0000-4000-8000-000000000902";
    const SOURCE_ID = "00000000-0000-4000-8000-000000000903";
    const WORK_ID = "00000000-0000-4000-8000-000000000904";
    const THREAD_ID = "00000000-0000-4000-8000-000000000905";
    const TURN_ID = "00000000-0000-4000-8000-000000000906";
    const DOC_ID = "00000000-0000-4000-8000-000000000907";
    const RESPONSE_ID = "00000000-0000-4000-8000-000000000908";
    const database = useRollbackTestDatabase(DATABASE_URL, {
      max: 4,
      prepareSuite: (db) => truncateDrizzleTables(db, [schema.users]),
    });
    let db = database.current;
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
        id: THREAD_ID,
        projectId: PROJECT_ID,
        createdByUserId: USER_ID,
        title: "Runtime settlement",
        kind: "primary",
        status: "active",
      });
      await db.insert(schema.turns).values({
        id: TURN_ID,
        threadId: THREAD_ID,
        role: "assistant",
        status: "complete",
      });
      await db.insert(schema.threadWorks).values({
        threadId: THREAD_ID,
        workId: WORK_ID,
        projectId: PROJECT_ID,
        isPrimary: true,
      });
    });

    it("S10 hard-delete evidence survives cold composition", () => runScenario(true));

    it("reports writer prose overwritten without a concurrent edit", () => runScenario(false));

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
      });
      await ports.documentSync.agentEdit().write(
        { command: "read", file: "runtime-settlement.md", documentId: DOC_ID },
        {
          sessionId: "runtime-settlement",
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
          threadId: THREAD_ID,
          turnId: TURN_ID,
          responseId: RESPONSE_ID,
        },
      );
      if (insert.status !== "success") throw new Error(insert.text);
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
          threadId: THREAD_ID,
          turnId: TURN_ID,
          responseId: RESPONSE_ID,
        },
      );
      if (write.status !== "success") throw new Error(write.text);
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

    async function composeRuntime() {
      const ports = await createProductionAppPorts({
        db,
        eventSink: createNoopEventSink(),
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
      return { ports, hocuspocus: server, app: composeAppServices(ports) };
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
