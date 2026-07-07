/** Public collab-domain reverseTurn coverage over Drizzle branch infrastructure. */
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("collab domain reverseTurn (postgres)", () => {
    it("requires RUN_DB_TESTS and DATABASE_URL", () => {});
  });
} else {
  describe("collab domain reverseTurn (postgres)", async () => {
    const { createDb } = await import("@meridian/database");
    const {
      agentEditMutations,
      branchWriteJournal,
      contextSources,
      documentBranches,
      documentYjsCheckpoints,
      documentYjsHeads,
      documentYjsReversalOps,
      documentYjsReversals,
      documentYjsUpdates,
      documents,
      projects,
      pushLineage,
      threadWorks,
      threads,
      turns,
      users,
      works,
    } = await import("@meridian/database/schema");
    const { conformanceUserValues } = await import(
      "@meridian/database/__test-support__/db-fixtures"
    );
    const { createCollabDomain } = await import("./composition.js");
    const { truncateDrizzleTables } = await import("../../test-support/drizzle-reset.js");

    const USER_ID = "00000000-0000-4000-8000-000000000701";
    const PROJECT_ID = "00000000-0000-4000-8000-000000000702";
    const SOURCE_ID = "00000000-0000-4000-8000-000000000703";
    const WORK_ID = "00000000-0000-4000-8000-000000000704";
    const DOC_ID = "00000000-0000-4000-8000-000000000705";
    const THREAD_ID = "00000000-0000-4000-8000-000000000706";
    const TURN_ID = "00000000-0000-4000-8000-000000000707";

    const db = createDb(DATABASE_URL, { max: 4 });
    const hocuspocus = fakeHocuspocus();

    beforeEach(async () => {
      hocuspocus.documents.clear();
      await truncateDrizzleTables(db, [
        documentYjsReversalOps,
        documentYjsReversals,
        agentEditMutations,
        branchWriteJournal,
        pushLineage,
        documentBranches,
        documentYjsCheckpoints,
        documentYjsHeads,
        documentYjsUpdates,
        threadWorks,
        turns,
        threads,
        documents,
        contextSources,
        works,
        projects,
        users,
      ]);
      await db.insert(users).values(conformanceUserValues(USER_ID, "collab-reverse"));
      await db
        .insert(projects)
        .values({ id: PROJECT_ID, userId: USER_ID, name: "Project", slug: "project" });
      await db.insert(works).values({
        id: WORK_ID,
        projectId: PROJECT_ID,
        createdByUserId: USER_ID,
        title: "Work",
        aiWriteMode: "draft",
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
        id: DOC_ID,
        contextSourceId: SOURCE_ID,
        name: "chapter",
        extension: "md",
        fileType: "markdown",
      });
      await db.insert(threads).values({
        id: THREAD_ID,
        projectId: PROJECT_ID,
        createdByUserId: USER_ID,
        title: "Thread",
        kind: "primary",
        status: "active",
      });
      await db.insert(turns).values({
        id: TURN_ID as never,
        threadId: THREAD_ID as never,
        role: "assistant",
        status: "complete",
      });
      await db
        .insert(threadWorks)
        .values({ threadId: THREAD_ID, workId: WORK_ID, projectId: PROJECT_ID, isPrimary: true });
    });

    afterAll(async () => {
      await db.$client.end();
    });

    it("reverses a pushed draft turn through public reverseTurn without creating branch rows", async () => {
      const collab = createCollabDomain({
        db,
        threads: { findById: async () => ({ id: THREAD_ID }) },
      });
      collab.bindHocuspocus(hocuspocus as never);
      await collab.writeDocument({
        documentId: DOC_ID as never,
        markdown: "Base.",
        origin: { type: "user", actorUserId: USER_ID as never },
        threadId: THREAD_ID as never,
      });

      const write = await collab.agentEdit().write(
        {
          command: "insert",
          file: "chapter.md",
          documentId: DOC_ID,
          content: "Live undo target.",
        },
        { sessionId: "session", threadId: THREAD_ID, turnId: TURN_ID },
      );
      expect(write.status).toBe("success");
      const [workDraft] = await db
        .select()
        .from(documentBranches)
        .where(
          and(
            eq(documentBranches.documentId, DOC_ID as never),
            eq(documentBranches.kind, "work_draft"),
            eq(documentBranches.status, "active"),
          ),
        )
        .limit(1);
      expect(workDraft).toBeDefined();
      await collab.pushToLive({ branchId: workDraft.id });
      await expectMarkdown(collab, DOC_ID, "Live undo target.");

      const beforeThreadPeers = await countActiveThreadPeers();
      const beforeActiveBranchRows = await countActiveBranchRows();

      // Load-bearing shape: public reverseTurn must use liveUtilityCore for pushed/live
      // undo. If rewired to the thread-peer core, this call opens/writes branch state;
      // the row-count assertions catch that regression in addition to the live revert.
      const reversed = await collab.reverseTurn({
        threadId: THREAD_ID as never,
        turnId: TURN_ID as never,
        direction: "undo",
        actor: { type: "user", userId: USER_ID },
      });

      expect(reversed.status).toBe("reversed");
      const live = await collab.readAsMarkdown(DOC_ID);
      expect(live.ok ? live.value : "").not.toContain("Live undo target.");
      expect(await countActiveThreadPeers()).toBe(beforeThreadPeers);
      expect(await countActiveBranchRows()).toBe(beforeActiveBranchRows);
      await expectMarkdown(collab, DOC_ID, "Base.");

      const reversalRows = await db
        .select({ status: documentYjsReversals.status })
        .from(documentYjsReversals)
        .where(
          and(
            eq(documentYjsReversals.threadId, THREAD_ID as never),
            eq(documentYjsReversals.turnId, TURN_ID as never),
          ),
        );
      expect(reversalRows.map((row) => row.status)).toContain("reversed");
      await expect(
        collab.getTurnReceiptChip(THREAD_ID as never, TURN_ID as never),
      ).resolves.toEqual(expect.objectContaining({ state: "live-reversed", control: "redo" }));
    });

    async function countActiveThreadPeers() {
      const [row] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(documentBranches)
        .where(
          and(eq(documentBranches.kind, "thread_peer"), eq(documentBranches.status, "active")),
        );
      return row?.count ?? 0;
    }

    async function countActiveBranchRows() {
      const [row] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(branchWriteJournal)
        .where(eq(branchWriteJournal.status, "active"));
      return row?.count ?? 0;
    }
  });
}

async function expectMarkdown(
  collab: {
    readAsMarkdown(documentId: string): Promise<{ ok: true; value: string } | { ok: false }>;
  },
  documentId: string,
  expected: string,
) {
  const read = await collab.readAsMarkdown(documentId);
  expect(read.ok ? read.value : "").toContain(expected);
}

function fakeHocuspocus() {
  const documents = new Map<string, Y.Doc>();
  return {
    documents,
    async openDirectConnection(documentName: string) {
      let document = documents.get(documentName);
      if (!document) {
        document = new Y.Doc({ gc: false });
        documents.set(documentName, document);
      }
      return { document, disconnect: async () => undefined };
    },
  };
}
