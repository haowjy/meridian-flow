import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { asGrantedWriter, testFileGrant } from "../../test-support/file-grants.js";
import { treeSeeder } from "../../test-support/tree-seed.js";
import { writeMarkdown } from "./test-support/bound-writes.js";
import { createTestDocumentLinkScopes } from "./test-support/document-link-scopes.js";
import { modelWrite } from "./test-support/model-write.js";
import {
  createWorkDraftFixture,
  DOC_ID,
  PROJECT_ID,
  SOURCE_ID,
  THREAD_ID,
  TURN_2_ID,
  TURN_ID,
  USER_ID,
} from "./test-support/work-draft-fixture.js";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("collab domain reverseTurn (postgres)", () => {});
} else {
  describe("collab domain reverseTurn (postgres)", async () => {
    const { createDb } = await import("@meridian/database");
    const { documentBlockRooms, documentBlocks, documentEdits, documents, modelResponses } =
      await import("@meridian/database/schema");
    const db = createDb(DATABASE_URL, { max: 4 });
    const { createTestCollab, reset, dispose } = createWorkDraftFixture(db);
    afterEach(dispose);

    beforeEach(reset);

    afterAll(async () => {
      await db.$client.end();
    });

    it("ContextFS cannot republish a stale write return over the certified projection", async () => {
      const { ContextFS } = await import("../context/adapters/context-fs/context-fs.js");
      const { DrizzleContextDocumentStore } = await import(
        "../context/adapters/context-fs/drizzle-store.js"
      );
      const { createSourceTree } = await import("../context/adapters/context-fs/tree-writes.js");
      const collab = createTestCollab();
      await db.insert(modelResponses).values({
        id: TURN_ID,
        turnId: TURN_ID,
        sequence: 0,
        provider: "mock",
        model: "mock",
        requestMessageCount: 0,
        predictedCacheState: "cold",
        predictedCacheReason: "facts_unavailable",
      });
      const context = new ContextFS({
        placement: { kind: "live" },
        holder: { projectId: PROJECT_ID },
        links: createTestDocumentLinkScopes(db),
        scheme: "manuscript",
        store: new DrizzleContextDocumentStore({ db, contextSourceId: SOURCE_ID }),
        writes: createSourceTree({
          store: treeSeeder(db).store,
          db,
          sourceId: async () => SOURCE_ID,
        }),
        userId: USER_ID,
        documentCreation: collab,
        documentSync: {
          ...collab,
          async writeDocument(input) {
            const result = await collab.writeDocument(input);
            return { ...result, markdown: "stale return value" };
          },
        },
      });
      try {
        const created = await context.createTrackedDocument("fresh.md", "Seed.");
        expect(created.ok).toBe(true);
        if (!created.ok || !created.value.documentId) throw new Error("Missing created document");
        await expect(
          asGrantedWriter(() =>
            context.write("fresh.md", "Current café.", {
              origin: {
                type: "agent",
                agentSlug: "writer",
                turnId: TURN_ID as never,
                threadId: THREAD_ID as never,
              },
            }),
          ),
        ).resolves.toMatchObject({
          ok: true,
        });
        const [row] = await db
          .select({ sizeBytes: documents.sizeBytes, text: documentBlocks.text })
          .from(documents)
          .leftJoin(documentBlockRooms, eq(documentBlockRooms.documentId, documents.id))
          .leftJoin(documentBlocks, eq(documentBlocks.roomId, documentBlockRooms.roomId))
          .where(eq(documents.id, created.value.documentId));
        expect(row?.text).toBe("Current café.");
        expect(row?.sizeBytes).toBe(Buffer.byteLength("Current café.", "utf8"));
      } finally {
        await collab.documentDerivations.stop();
      }
    });

    it("keeps distinct responses that reuse a provider-local tool id", async () => {
      const collab = createTestCollab();
      await writeMarkdown(collab, {
        documentId: DOC_ID as never,
        markdown: "Base.",
        origin: { type: "user", actorUserId: USER_ID as never },
        threadId: THREAD_ID as never,
      });
      const [responseA, responseB] = [
        "00000000-0000-4000-8000-0000000007a1",
        "00000000-0000-4000-8000-0000000007a2",
      ];
      await db.insert(modelResponses).values(
        [
          [responseA, TURN_ID],
          [responseB, TURN_2_ID],
        ].map(([id, turnId]) => ({
          id: id as never,
          turnId: turnId as never,
          sequence: 0,
          provider: "mock",
          model: "mock",
          requestMessageCount: 0,
          predictedCacheState: "cold" as const,
          predictedCacheReason: "facts_unavailable" as const,
        })),
      );

      await expect(
        modelWrite(
          collab.modelEdits(),
          {
            command: "insert",
            file: "chapter.md",
            documentId: DOC_ID,
            content: "First reused tool id.",
            tool_use_id: "call_mock_write_1",
          },
          {
            sessionId: "session-reused-provider-tool-id-db",
            grant: testFileGrant({ kind: "live" }, DOC_ID),
            threadId: THREAD_ID,
            turnId: TURN_ID,
            responseIdentity: {
              modelResponseId: responseA,
            },
          },
          { accountId: USER_ID, projectId: PROJECT_ID },
        ),
      ).resolves.toMatchObject({ status: "success" });

      await expect(
        modelWrite(
          collab.modelEdits(),
          {
            command: "insert",
            file: "chapter.md",
            documentId: DOC_ID,
            content: "Second reused tool id.",
            tool_use_id: "call_mock_write_1",
          },
          {
            sessionId: "session-reused-provider-tool-id-db",
            grant: testFileGrant({ kind: "live" }, DOC_ID),
            threadId: THREAD_ID,
            turnId: TURN_2_ID,
            responseIdentity: {
              modelResponseId: responseB,
            },
          },
          { accountId: USER_ID, projectId: PROJECT_ID },
        ),
      ).resolves.toMatchObject({ status: "success" });

      const rows = await db
        .select({ responseId: documentEdits.responseId, toolCallId: documentEdits.toolCallId })
        .from(documentEdits)
        .where(
          and(eq(documentEdits.documentId, DOC_ID as never), eq(documentEdits.actor, "agent")),
        );
      expect(rows.map((row) => row.responseId).sort()).toEqual([responseA, responseB]);
    });
  });
}
