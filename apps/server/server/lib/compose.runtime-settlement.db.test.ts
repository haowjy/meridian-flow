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
    let hocuspocus: Hocuspocus | undefined;

    beforeEach(async () => {
      hocuspocus = undefined;
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

    it("applies a post-observation writer replacement and classifies it from production inputs", () =>
      runScenario(true));

    it("does not warn when the production response observed the overwritten prose", () =>
      runScenario(false));

    async function runScenario(writerAfterObservation: boolean): Promise<void> {
      const ports = await createProductionAppPorts({
        db,
        eventSink: createNoopEventSink(),
        environment: { OPENAI_API_KEY: "sk-test-runtime-composition" },
      });
      hocuspocus = new Hocuspocus({
        yDocOptions: { gc: false, gcFilter: () => true },
        async onLoadDocument({ documentName, document }) {
          const state = await ports.documentSync.loadHocuspocusDocument(documentName);
          if (state) Y.applyUpdate(document, state);
        },
        onStoreDocument: ({ documentName, document }) =>
          ports.documentSync.storeHocuspocusDocument(documentName, document),
      });
      ports.documentSync.bindHocuspocus(hocuspocus);
      const app = composeAppServices(ports);

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

      const room = await hocuspocus.openDirectConnection(DOC_ID);
      if (!room.document) throw new Error("live production room is unavailable");
      if (writerAfterObservation) {
        const writerReplica = new Y.Doc({ gc: false });
        Y.applyUpdate(writerReplica, Y.encodeStateAsUpdate(room.document));
        const fragment = writerReplica.getXmlFragment("prosemirror");
        fragment.delete(0, fragment.length);
        const paragraph = new Y.XmlElement("paragraph");
        paragraph.push([new Y.XmlText("Writer V2 unseen.")]);
        fragment.push([paragraph]);
        const repeatedFullSync = Y.encodeStateAsUpdate(writerReplica);
        await ports.documentSync.admitLiveWriterUpdate({
          documentId: DOC_ID,
          update: repeatedFullSync,
          origin: { type: "user", userId: USER_ID },
        });
        Y.applyUpdate(room.document, repeatedFullSync);
        writerReplica.destroy();
      }

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
      expect(live.ok && live.value.trim()).toBe("Agent final.");
      const [settlement] = await db.select().from(schema.branchPushSettlementOutbox);
      expect(settlement).toMatchObject({ state: "completed" });
      const [trail] = await db.select().from(schema.changeTrailShells);
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
