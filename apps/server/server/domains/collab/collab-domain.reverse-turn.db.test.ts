/**
 * Public collab-domain reverseTurn coverage over Drizzle draft infrastructure.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - the certified projection as the sole publisher of stored Markdown
 */

import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { asGrantedWriter, testFileGrant } from "../../test-support/file-grants.js";
import { treeSeeder } from "../../test-support/tree-seed.js";
import { writeMarkdown } from "./test-support/bound-writes.js";
import { createTestDocumentLinkScopes } from "./test-support/document-link-scopes.js";
import { modelWrite } from "./test-support/model-write.js";
import {
  createWorkBranchFixture,
  DOC_ID,
  DRAFT_DESTINATION,
  PROJECT_ID,
  SOURCE_ID,
  THREAD_ID,
  TURN_2_ID,
  TURN_ID,
  USER_ID,
} from "./test-support/work-branch-fixture.js";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("collab domain reverseTurn (postgres)", () => {});
} else {
  describe("collab domain reverseTurn (postgres)", async () => {
    const { createDb } = await import("@meridian/database");
    const { draftWriteJournal, documentBlockRooms, documentBlocks, documents, modelResponses } =
      await import("@meridian/database/schema");
    const db = createDb(DATABASE_URL, { max: 4 });
    const { hocuspocus, createTestCollab, reset, dispose } = createWorkBranchFixture(db);
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
      collab.bindHocuspocus(hocuspocus as never);
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
        actor: `user:${USER_ID}`,
        documentCreation: collab,
        documentSync: {
          ...collab,
          async writeDocument(input) {
            const result = await collab.writeDocument(input);
            // Reproduce the old publisher boundary without claiming a socket race:
            // the returned serialization must never overwrite a certified cut.
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
      collab.bindHocuspocus(hocuspocus as never);
      await writeMarkdown(collab, {
        documentId: DOC_ID as never,
        markdown: "Base.",
        origin: { type: "user", actorUserId: USER_ID as never },
        threadId: THREAD_ID as never,
      });

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
            grant: testFileGrant(DRAFT_DESTINATION),
            threadId: THREAD_ID,
            turnId: TURN_ID,
            responseIdentity: {
              modelResponseId: "response-reused-provider-tool-id-db-a",
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
            grant: testFileGrant(DRAFT_DESTINATION),
            threadId: THREAD_ID,
            turnId: TURN_2_ID,
            responseIdentity: {
              modelResponseId: "response-reused-provider-tool-id-db-b",
            },
          },
          { accountId: USER_ID, projectId: PROJECT_ID },
        ),
      ).resolves.toMatchObject({ status: "success" });

      const rows = await db
        .select({ id: draftWriteJournal.id })
        .from(draftWriteJournal)
        .orderBy(draftWriteJournal.id);
      expect(rows).toHaveLength(2);
    });
  });
}

async function _expectMarkdown(
  collab: {
    readAsMarkdown(documentId: string): Promise<{ ok: true; value: string } | { ok: false }>;
  },
  documentId: string,
  expected: string,
) {
  const read = await collab.readAsMarkdown(documentId);
  expect(read.ok ? read.value : "").toContain(expected);
}

async function _readMarkdown(
  collab: {
    readAsMarkdown(documentId: string): Promise<{ ok: true; value: string } | { ok: false }>;
  },
  documentId: string,
): Promise<string> {
  const read = await collab.readAsMarkdown(documentId);
  return read.ok ? read.value : "";
}
