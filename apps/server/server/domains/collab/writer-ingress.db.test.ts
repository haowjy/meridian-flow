/** PostgreSQL contract for atomic live-journal append and settlement join. */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("writer ingress (postgres)", () => {
    it("requires RUN_DB_TESTS and DATABASE_URL", () => {});
  });
} else {
  describe("writer ingress (postgres)", async () => {
    const { createDb } = await import("@meridian/database");
    const {
      branchPushOutboxUpdates,
      branchPushSettlementOutbox,
      contextSources,
      documents,
      documentYjsUpdates,
      projects,
      pushLineage,
      users,
    } = await import("@meridian/database/schema");
    const { conformanceUserValues } = await import(
      "@meridian/database/__test-support__/db-fixtures"
    );
    const { truncateDrizzleTables } = await import("../../test-support/drizzle-reset.js");
    const { createDrizzleJournal } = await import("./adapters/drizzle-journal.js");

    const USER_ID = "00000000-0000-4000-8000-000000000701";
    const PROJECT_ID = "00000000-0000-4000-8000-000000000702";
    const SOURCE_ID = "00000000-0000-4000-8000-000000000703";
    const DOCUMENT_ID = "00000000-0000-4000-8000-000000000704";
    const db = createDb(DATABASE_URL, { max: 2 });
    const journal = createDrizzleJournal(db);

    beforeEach(async () => {
      await truncateDrizzleTables(db, [
        branchPushSettlementOutbox,
        documentYjsUpdates,
        pushLineage,
        documents,
        contextSources,
        projects,
        users,
      ]);
      await db.insert(users).values(conformanceUserValues(USER_ID, "writer-ingress"));
      await db.insert(projects).values({
        id: PROJECT_ID,
        userId: USER_ID,
        name: "Writer ingress",
        slug: "writer-ingress",
      });
      await db.insert(contextSources).values({
        id: SOURCE_ID,
        projectId: PROJECT_ID,
        name: "Manuscript",
        slug: "manuscript",
        scope: "project",
        isPrimary: true,
      });
      await db.insert(documents).values({
        id: DOCUMENT_ID,
        contextSourceId: SOURCE_ID,
        name: "chapter",
        extension: "md",
        fileType: "markdown",
      });
    });

    afterAll(async () => {
      await db.$client.end();
    });

    it("joins every unresolved settlement in the same admitted append", async () => {
      const pushes = await db
        .insert(pushLineage)
        .values([
          {
            documentId: DOCUMENT_ID as never,
            pushKind: "whole",
            journalIds: [],
            idempotencyKey: "writer-join-1",
          },
          {
            documentId: DOCUMENT_ID as never,
            pushKind: "whole",
            journalIds: [],
            idempotencyKey: "writer-join-2",
          },
        ])
        .returning({ id: pushLineage.id });
      const emptyDoc = new Y.Doc();
      const emptyState = Y.encodeStateAsUpdate(emptyDoc);
      await db.insert(branchPushSettlementOutbox).values(
        pushes.map((push) => ({
          pushId: push.id,
          documentId: DOCUMENT_ID as never,
          documentTitle: "chapter",
          lockCutUpdate: Buffer.from(emptyState),
          pushUpdate: Buffer.from(emptyState),
          lineageEvidence: { version: 2, items: [] },
          trailSeed: {},
        })),
      );
      const writerDoc = new Y.Doc();
      writerDoc.getText("content").insert(0, "writer");
      const update = Y.encodeStateAsUpdate(writerDoc);
      expect(update).toContain(0);

      const result = await journal.appendWriterUpdate?.(DOCUMENT_ID, update, {
        origin: `human:${USER_ID}`,
        seq: 0,
      });

      expect(result).toMatchObject({ joinedSettlement: true });
      const settlements = await db
        .select({
          joinVersion: branchPushSettlementOutbox.joinVersion,
        })
        .from(branchPushSettlementOutbox);
      expect(settlements).toEqual(expect.arrayContaining([{ joinVersion: 1 }, { joinVersion: 1 }]));
      const joined = await db.select().from(branchPushOutboxUpdates);
      expect(joined).toHaveLength(2);
      expect(joined.every((row) => row.update.equals(Buffer.from(update)))).toBe(true);
    });
  });
}
