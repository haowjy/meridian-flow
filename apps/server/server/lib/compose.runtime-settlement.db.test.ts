/** Production-composition regression for response credit and staged-push completion. */

import { Hocuspocus } from "@hocuspocus/server";
import {
  createAgentEditCodec,
  digestRenderedContent,
  snapshotBlocks,
  toDocHandle,
  yProsemirrorModel,
} from "@meridian/agent-edit";
import { mdxCodec } from "@meridian/markup";
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("production-composed branch settlement (postgres)", () => {
    it("requires RUN_DB_TESTS and DATABASE_URL", () => {});
  });
} else {
  describe("production-composed branch settlement (postgres)", async () => {
    const { createDb } = await import("@meridian/database");
    const schema = await import("@meridian/database/schema");
    const { conformanceUserValues } = await import(
      "@meridian/database/__test-support__/db-fixtures"
    );
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
    const CUT_ID = "00000000-0000-4000-8000-000000000909";
    const db = createDb(DATABASE_URL, { max: 4 });
    const documentSchema = buildDocumentSchema();
    const model = yProsemirrorModel(documentSchema);
    const codec = createAgentEditCodec(mdxCodec({ schema: documentSchema }));
    beforeEach(async () => {
      await truncateDrizzleTables(db, [
        schema.turnTrailWork,
        schema.changeTrailDeliveryOutbox,
        schema.changeTrailDocumentDetails,
        schema.changeTrailShells,
        schema.pendingNoticeDeliveries,
        schema.pendingNotices,
        schema.agentEditMutations,
        schema.branchWriteJournal,
        schema.pushLineage,
        schema.documentBranches,
        schema.documentYjsCheckpoints,
        schema.documentYjsHeads,
        schema.documentYjsUpdates,
        schema.threadWorks,
        schema.turns,
        schema.threads,
        schema.folders,
        schema.documents,
        schema.contextSources,
        schema.works,
        schema.projects,
        schema.users,
      ]);
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
        title: "Runtime settlement",
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

    afterAll(async () => {
      await db.$client.end();
    });

    it("S2 Restore and S10 hard-delete evidence survive cold composition", () => runScenario(true));

    it("does not warn when the production response observed the overwritten prose", () =>
      runScenario(false));

    async function runScenario(writerAfterObservation: boolean): Promise<void> {
      let runtime = await composeRuntime();
      let { ports, app } = runtime;

      await ports.documentSync.writeDocument({
        documentId: DOC_ID,
        markdown: "Writer V1 observed.",
        origin: { type: "user", actorUserId: USER_ID },
        threadId: THREAD_ID,
      });
      await sealObservation();
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
      if (writerAfterObservation) {
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
          find: writerAfterObservation ? "Writer V2 unseen." : "Writer V1 observed.",
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
      expect(trail?.sweptChangeCount).toBe(writerAfterObservation ? 1 : 0);
      const [details] = await db.select().from(schema.changeTrailDocumentDetails);
      const sweptBodies = (
        (details?.changes ?? []) as Array<{
          writerProtection?: { kind: string; body?: { markdown?: string } };
        }>
      ).flatMap((change) =>
        change.writerProtection?.kind === "sweep"
          ? [change.writerProtection.body?.markdown?.trim()]
          : [],
      );
      expect(sweptBodies).toEqual(writerAfterObservation ? ["Writer V2 unseen."] : []);
      const [branchRow] = await db.select().from(schema.branchWriteJournal);
      expect(branchRow?.updateMeta).toMatchObject({
        sealedWriterLineage: { responseCausalCutId: CUT_ID },
      });
      await room.disconnect();
      await unloadRuntime(runtime.hocuspocus);

      if (writerAfterObservation) {
        // Drop every warm composition object; the next assertions can only use
        // the journal, settlement, and trail rows in PostgreSQL.
        runtime = await composeRuntime();
        ({ ports, app } = runtime);
        const cold = await ports.documentSync.readAsMarkdown(DOC_ID);
        expect(cold.ok && cold.value).toContain("Agent final.");

        const coldRoom = await runtime.hocuspocus.openDirectConnection(DOC_ID);
        if (!coldRoom.document) throw new Error("cold production room is unavailable");
        const intervening = new Y.Doc({ gc: false });
        Y.applyUpdate(intervening, Y.encodeStateAsUpdate(coldRoom.document));
        const before = Y.encodeStateVector(intervening);
        const paragraph = new Y.XmlElement("paragraph");
        paragraph.push([new Y.XmlText("Intervening writer edit.")]);
        intervening.getXmlFragment("prosemirror").push([paragraph]);
        const update = Y.encodeStateAsUpdate(intervening, before);
        await ports.documentSync.admitLiveWriterUpdate({
          documentId: DOC_ID,
          update,
          origin: { type: "user", userId: USER_ID },
          expectedGeneration: 1n,
        });
        Y.applyUpdate(coldRoom.document, update);
        intervening.destroy();

        const change = ((details?.changes ?? []) as Array<{ changeId: string }>)[0];
        if (!trail || !change) throw new Error("S2 trail has no restorable swept change");
        const action = {
          threadId: THREAD_ID,
          trailId: trail.id,
          changeId: change.changeId,
          action: "restore" as const,
          userId: USER_ID,
        };
        await expect(ports.documentSync.applyTrailForwardAction(action)).resolves.toEqual({
          status: "applied",
        });
        await expect(ports.documentSync.applyTrailForwardAction(action)).resolves.toEqual({
          status: "already_applied",
        });
        const restored = await ports.documentSync.readAsMarkdown(DOC_ID);
        if (!restored.ok) throw new Error(JSON.stringify(restored.error));
        expect(restored.value).toContain("Intervening writer edit.");
        expect(restored.value.match(/Writer V2 unseen\./g)).toHaveLength(1);
        await coldRoom.disconnect();
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
          unavailable?: boolean;
          changes?: Array<{
            writerProtection?: { body?: { markdown?: string } };
            forwardActions?: { restore?: { status?: string } };
          }>;
        };
        expect(retained.unavailable).toBe(true);
        expect(retained.changes?.[0]?.writerProtection?.body?.markdown?.trim()).toBe(
          "Writer V2 unseen.",
        );
        expect(retained.changes?.[0]?.forwardActions?.restore?.status).toBe("applied");
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

    async function sealObservation(): Promise<void> {
      const state = await portsState();
      const doc = new Y.Doc({ gc: false });
      Y.applyUpdate(doc, state.update);
      const blocks = snapshotBlocks(toDocHandle(doc), model, codec);
      await db.insert(schema.modelResponses).values({
        id: RESPONSE_ID,
        turnId: TURN_ID,
        sequence: 1,
        provider: "runtime-test",
        model: "runtime-test",
      });
      await db.insert(schema.modelResponseObservationSnapshots).values({ responseId: RESPONSE_ID });
      await db.insert(schema.modelResponseCausalCuts).values({
        id: CUT_ID,
        responseId: RESPONSE_ID,
        documentId: DOC_ID,
        authorityId: state.authorityId,
        generation: state.generation,
        admittedThrough: state.admittedThrough,
      });
      await db.insert(schema.modelResponseObservationEntries).values(
        blocks.flatMap((block) =>
          block.clientID === undefined || block.clock === undefined || !block.renderedContent
            ? []
            : [
                {
                  responseId: RESPONSE_ID,
                  documentId: DOC_ID,
                  clientId: block.clientID,
                  clock: block.clock,
                  kind: "rendered" as const,
                  contentDigest: digestRenderedContent(block.renderedContent),
                },
              ],
        ),
      );
      doc.destroy();
    }

    async function portsState() {
      const [head] = await db
        .select()
        .from(schema.documentYjsHeads)
        .where(eq(schema.documentYjsHeads.documentId, DOC_ID));
      const [row] = await db
        .select({ update: schema.documentYjsUpdates.updateData })
        .from(schema.documentYjsUpdates)
        .where(eq(schema.documentYjsUpdates.documentId, DOC_ID));
      if (!head || !row) throw new Error("document authority was not initialized");
      const update = await db
        .select({ value: schema.documentYjsUpdates.updateData })
        .from(schema.documentYjsUpdates)
        .where(eq(schema.documentYjsUpdates.documentId, DOC_ID));
      const doc = new Y.Doc({ gc: false });
      for (const item of update) Y.applyUpdate(doc, item.value);
      const state = Y.encodeStateAsUpdate(doc);
      doc.destroy();
      return {
        update: state,
        authorityId: head.authorityId,
        generation: head.authorityGeneration,
        admittedThrough: head.nextAdmissionSequence - 1n,
      };
    }
  });
}
