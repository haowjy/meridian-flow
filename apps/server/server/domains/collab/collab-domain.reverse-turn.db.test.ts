/** Public collab-domain reverseTurn coverage over Drizzle branch infrastructure. */

import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { createTestWorkProjectionMutation } from "../../test-support/work-projection.js";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("collab domain reverseTurn (postgres)", () => {});
} else {
  describe("collab domain reverseTurn (postgres)", async () => {
    const { createDb } = await import("@meridian/database");
    const {
      agentEditMutations,
      agentEditWidCounters,
      branchPushOutboxUpdates,
      branchPushSettlementOutbox,
      branchWriteJournal,
      changeTrailDeliveryOutbox,
      changeTrailDocumentDetails,
      changeTrailDocumentOccurrences,
      changeTrailShells,
      contextSources,
      documentBranches,
      documentYjsCheckpoints,
      documentYjsHeads,
      documentYjsReversalOps,
      documentYjsReversals,
      documentYjsUpdates,
      documents,
      folders,
      projects,
      pushLineage,
      pendingNotices,
      threadWorks,
      threads,
      turns,
      turnTrailWork,
      users,
      works,
    } = await import("@meridian/database/schema");
    const { conformanceUserValues } = await import(
      "@meridian/database/__test-support__/db-fixtures"
    );
    const { createCollabDomain } = await import("./composition.js");
    const { createDrizzleDocumentAccess } = await import("../../lib/document-access.js");
    const { createDrizzleProjectWorkAuthorityResolver } = await import("../projects/index.js");
    const { createDrizzleJournal } = await import("./adapters/drizzle-journal.js");
    const { deleteDrizzleRows } = await import("../../test-support/drizzle-reset.js");

    const USER_ID = "00000000-0000-4000-8000-000000000701";
    const PROJECT_ID = "00000000-0000-4000-8000-000000000702";
    const SOURCE_ID = "00000000-0000-4000-8000-000000000703";
    const WORK_ID = "00000000-0000-4000-8000-000000000704";
    const DOC_ID = "00000000-0000-4000-8000-000000000705";
    const THREAD_ID = "00000000-0000-4000-8000-000000000706";
    const TURN_ID = "00000000-0000-4000-8000-000000000707";
    const TURN_2_ID = "00000000-0000-4000-8000-000000000708";
    const TURN_3_ID = "00000000-0000-4000-8000-000000000709";
    const CREATED_DOC_ID = "00000000-0000-4000-8000-000000000710";

    const db = createDb(DATABASE_URL, { max: 4 });
    const hocuspocus = fakeHocuspocus();
    const createTestCollab = () =>
      createCollabDomain({
        db,
        workProjectionMutation: createTestWorkProjectionMutation(db),
        workAuthorityResolver: createDrizzleProjectWorkAuthorityResolver(db),
        documentAccess: createDrizzleDocumentAccess(db),
      });

    async function currentDraftId(
      collab: ReturnType<typeof createTestCollab>,
      documentId: string,
    ): Promise<string> {
      const drafts = await collab.draftReview.list({
        projectId: PROJECT_ID as never,
        workId: WORK_ID as never,
      });
      const draft = drafts.find((candidate) => candidate.documentId === documentId);
      if (!draft) throw new Error(`missing reviewable draft for ${documentId}`);
      return draft.draftId;
    }

    beforeEach(async () => {
      hocuspocus.documents.clear();
      await deleteDrizzleRows(db, [
        branchPushOutboxUpdates,
        branchPushSettlementOutbox,
        turnTrailWork,
        changeTrailDeliveryOutbox,
        changeTrailDocumentDetails,
        changeTrailDocumentOccurrences,
        changeTrailShells,
        pendingNotices,
        documentYjsReversalOps,
        documentYjsReversals,
        agentEditWidCounters,
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
        folders,
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
        name: "Work",
        slug: "work",
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
      await db.insert(turns).values([
        {
          id: TURN_ID as never,
          threadId: THREAD_ID as never,
          role: "assistant",
          status: "complete",
        },
        {
          id: TURN_2_ID as never,
          threadId: THREAD_ID as never,
          parentTurnId: TURN_ID as never,
          role: "assistant",
          status: "complete",
        },
        {
          id: TURN_3_ID as never,
          threadId: THREAD_ID as never,
          parentTurnId: TURN_2_ID as never,
          role: "assistant",
          status: "complete",
        },
      ]);
      await db
        .insert(threadWorks)
        .values({ threadId: THREAD_ID, workId: WORK_ID, projectId: PROJECT_ID, isPrimary: true });
    });

    afterAll(async () => {
      await db.$client.end();
    });

    it("reverses a pushed draft turn through public reverseTurn without creating branch rows", async () => {
      const collab = createTestCollab();
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

      const bookkeeping = new Y.Doc({ gc: false });
      bookkeeping.getMap("bookkeeping").set("settled", true);
      await createDrizzleJournal(db).append(DOC_ID, Y.encodeStateAsUpdate(bookkeeping), {
        origin: "system",
        seq: 0,
      });
      bookkeeping.destroy();
      await expect(
        collab.getTurnReceiptChip(THREAD_ID as never, TURN_ID as never),
      ).resolves.toEqual(expect.objectContaining({ state: "live-reversed", control: "redo" }));

      for (const direction of ["redo", "undo", "redo"] as const) {
        const outcome = await collab.reverseTurn({
          threadId: THREAD_ID as never,
          turnId: TURN_ID as never,
          direction,
          actor: { type: "user", userId: USER_ID },
        });
        expect(outcome.status).toBe(direction === "undo" ? "reversed" : "reconciled");
      }
      await expectMarkdown(collab, DOC_ID, "Live undo target.");
    });

    it("undoes and redoes overlapping replace and delete writes as one turn", async () => {
      const collab = createTestCollab();
      collab.bindHocuspocus(hocuspocus as never);
      const fountain =
        "The fountain wore a skin of ice, each dark stone mirroring the colorless winter sky.";
      const gate =
        "At the gate, Captain Ilyan waited in silence, his gloved hand closed around the iron latch.";
      await collab.writeDocument({
        documentId: DOC_ID as never,
        markdown: fountain,
        origin: { type: "user", actorUserId: USER_ID as never },
        threadId: THREAD_ID as never,
      });
      await collab.setWorkPushPolicy({ workId: WORK_ID as never, policy: "auto" });
      for (const [find, content] of [
        [fountain, gate],
        [gate, ""],
      ] as const) {
        await expect(
          collab
            .agentEdit()
            .write(
              { command: "replace", file: "chapter.md", documentId: DOC_ID, find, content },
              { sessionId: "session-overlap", threadId: THREAD_ID, turnId: TURN_ID },
            ),
        ).resolves.toMatchObject({ status: "success" });
      }

      const undo = await collab.reverseTurn({
        threadId: THREAD_ID as never,
        turnId: TURN_ID as never,
        direction: "undo",
        actor: { type: "user", userId: USER_ID },
      });
      expect(["reversed", "reconciled"]).toContain(undo.status);
      await expectMarkdown(collab, DOC_ID, fountain);

      const redo = await collab.reverseTurn({
        threadId: THREAD_ID as never,
        turnId: TURN_ID as never,
        direction: "redo",
        actor: { type: "user", userId: USER_ID },
      });
      expect(redo.status).toBe("reconciled");
      expect(await readMarkdown(collab, DOC_ID)).not.toContain(fountain);
    });

    it("rolls back every live document when one document refuses a turn reversal", async () => {
      await db.insert(documents).values({
        id: CREATED_DOC_ID,
        contextSourceId: SOURCE_ID,
        name: "chapter-two",
        extension: "md",
        fileType: "markdown",
      });
      const collab = createTestCollab();
      collab.bindHocuspocus(hocuspocus as never);
      await collab.setWorkPushPolicy({ workId: WORK_ID as never, policy: "auto" });
      for (const [documentId, markdown] of [
        [DOC_ID, "First base."],
        [CREATED_DOC_ID, "Second base."],
      ] as const) {
        await collab.writeDocument({
          documentId: documentId as never,
          markdown,
          origin: { type: "user", actorUserId: USER_ID as never },
          threadId: THREAD_ID as never,
        });
        await expect(
          collab.agentEdit().write(
            {
              command: "insert",
              file: `${documentId}.md`,
              documentId,
              content: `Turn edit for ${documentId}.`,
            },
            { sessionId: "session-atomic-reversal", threadId: THREAD_ID, turnId: TURN_ID },
          ),
        ).resolves.toMatchObject({ status: "success" });
      }
      await collab.writeDocument({
        documentId: CREATED_DOC_ID as never,
        markdown: "Writer invalidated only the second document.",
        origin: { type: "user", actorUserId: USER_ID as never },
        threadId: THREAD_ID as never,
      });

      await expect(
        collab.reverseTurn({
          threadId: THREAD_ID as never,
          turnId: TURN_ID as never,
          direction: "undo",
          actor: { type: "user", userId: USER_ID },
        }),
      ).resolves.toMatchObject({ status: "cant_undo_dependent" });

      await expectMarkdown(collab, DOC_ID, `Turn edit for ${DOC_ID}.`);
      await expectMarkdown(collab, CREATED_DOC_ID, "Writer invalidated only the second document.");
      const reversals = await db
        .select()
        .from(documentYjsReversals)
        .where(
          and(
            eq(documentYjsReversals.threadId, THREAD_ID as never),
            eq(documentYjsReversals.turnId, TURN_ID as never),
          ),
        );
      expect(reversals).toHaveLength(0);
    });

    it("withdraws redo after a writer edit lands following undo", async () => {
      const collab = createTestCollab();
      collab.bindHocuspocus(hocuspocus as never);
      await collab.writeDocument({
        documentId: DOC_ID as never,
        markdown: "Base.",
        origin: { type: "user", actorUserId: USER_ID as never },
        threadId: THREAD_ID as never,
      });
      await collab
        .agentEdit()
        .write(
          { command: "insert", file: "chapter.md", documentId: DOC_ID, content: "Agent change." },
          { sessionId: "session-writer-redo", threadId: THREAD_ID, turnId: TURN_ID },
        );
      const [workDraft] = await activeWorkDraft();
      await collab.pushToLive({ branchId: workDraft.id });
      await collab.reverseTurn({
        threadId: THREAD_ID as never,
        turnId: TURN_ID as never,
        direction: "undo",
        actor: { type: "user", userId: USER_ID },
      });
      await collab.writeDocument({
        documentId: DOC_ID as never,
        markdown: "Writer changed the manuscript.",
        origin: { type: "user", actorUserId: USER_ID as never },
        threadId: THREAD_ID as never,
      });
      const [writerRow] = await db
        .select({ id: documentYjsUpdates.id })
        .from(documentYjsUpdates)
        .where(eq(documentYjsUpdates.documentId, DOC_ID as never))
        .orderBy(sql`${documentYjsUpdates.id} desc`)
        .limit(1);
      if (!writerRow) throw new Error("missing writer update");
      // Collab ingress stores `user`; context-service writes store `human`.
      // Reconstruction must normalize both to the same writer class.
      await db
        .update(documentYjsUpdates)
        .set({ originType: "user" })
        .where(eq(documentYjsUpdates.id, writerRow.id));

      await expect(
        collab.getTurnReceiptChip(THREAD_ID as never, TURN_ID as never),
      ).resolves.toEqual(expect.objectContaining({ state: "expired", control: "view_change" }));
      await expect(
        collab.reverseTurn({
          threadId: THREAD_ID as never,
          turnId: TURN_ID as never,
          direction: "redo",
          actor: { type: "user", userId: USER_ID },
        }),
      ).resolves.toMatchObject({ status: "nothing_to_redo" });

      const journal = createDrizzleJournal(db);
      const [reversal] = await journal.readReversals(DOC_ID, {
        threadId: THREAD_ID,
      });
      if (!reversal) throw new Error("missing reversal");
      await expect(
        journal.persistRedoBatch(DOC_ID, [
          {
            update: Y.encodeStateAsUpdate(new Y.Doc()),
            ref: { threadId: THREAD_ID, undoUpdateSeq: reversal.undoUpdateSeq },
            meta: { origin: "system", seq: 0 },
            persistGuardWatermark: reversal.undoUpdateSeq,
          },
        ]),
      ).resolves.toEqual({ consumed: false });
    });

    it("degrades live turn undo when a later writer edit intersects the pushed paragraph", async () => {
      const collab = createTestCollab();
      collab.bindHocuspocus(hocuspocus as never);
      await collab.writeDocument({
        documentId: DOC_ID as never,
        markdown: "Base.",
        origin: { type: "user", actorUserId: USER_ID as never },
        threadId: THREAD_ID as never,
      });
      await collab.agentEdit().write(
        {
          command: "insert",
          file: "chapter.md",
          documentId: DOC_ID,
          content: "Agent paragraph.",
        },
        { sessionId: "session-live-dependent", threadId: THREAD_ID, turnId: TURN_ID },
      );
      const [workDraft] = await activeWorkDraft();
      await collab.pushToLive({ branchId: workDraft.id });

      await collab.writeDocument({
        documentId: DOC_ID as never,
        markdown: "Base.\n\nAgent HUMAN-KEEP paragraph.",
        origin: { type: "user", actorUserId: USER_ID as never },
        threadId: THREAD_ID as never,
      });

      await expect(
        collab.getTurnReceiptChip(THREAD_ID as never, TURN_ID as never),
      ).resolves.toEqual(
        expect.objectContaining({ state: "cant_undo_dependent", control: "view_change" }),
      );
      const reversed = await collab.reverseTurn({
        threadId: THREAD_ID as never,
        turnId: TURN_ID as never,
        direction: "undo",
        actor: { type: "user", userId: USER_ID },
      });
      expect(reversed.status).toBe("cant_undo_dependent");
      expect(await readMarkdown(collab, DOC_ID)).toContain("Agent HUMAN-KEEP paragraph.");
    });

    it("keeps live turn undo available when a later writer edit is elsewhere", async () => {
      const collab = createTestCollab();
      collab.bindHocuspocus(hocuspocus as never);
      await collab.writeDocument({
        documentId: DOC_ID as never,
        markdown: "Base.",
        origin: { type: "user", actorUserId: USER_ID as never },
        threadId: THREAD_ID as never,
      });
      await collab.agentEdit().write(
        {
          command: "insert",
          file: "chapter.md",
          documentId: DOC_ID,
          content: "Agent paragraph.",
        },
        { sessionId: "session-live-independent", threadId: THREAD_ID, turnId: TURN_ID },
      );
      const [workDraft] = await activeWorkDraft();
      await collab.pushToLive({ branchId: workDraft.id });

      const unrelatedDoc = new Y.Doc({ gc: false });
      unrelatedDoc.getMap("elsewhere").set("note", "writer edit outside the agent paragraph");
      await createDrizzleJournal(db).append(DOC_ID, Y.encodeStateAsUpdate(unrelatedDoc), {
        origin: `human:${USER_ID}`,
        seq: 0,
      });
      unrelatedDoc.destroy();

      await expect(
        collab.getTurnReceiptChip(THREAD_ID as never, TURN_ID as never),
      ).resolves.toEqual(expect.objectContaining({ state: "live-active", control: "undo" }));
      const reversed = await collab.reverseTurn({
        threadId: THREAD_ID as never,
        turnId: TURN_ID as never,
        direction: "undo",
        actor: { type: "user", userId: USER_ID },
      });
      expect(reversed.status).toBe("reversed");
      const live = await readMarkdown(collab, DOC_ID);
      expect(live).toContain("Base.");
      expect(live).not.toContain("Agent paragraph.");
    });

    it("durably commits two same-response staged writes to one document", async () => {
      const collab = createTestCollab();
      collab.bindHocuspocus(hocuspocus as never);
      await collab.writeDocument({
        documentId: DOC_ID as never,
        markdown: "Base.",
        origin: { type: "user", actorUserId: USER_ID as never },
        threadId: THREAD_ID as never,
      });

      const responseId = "response-same-document-db";
      const stagedCreate = await collab.agentEdit().write(
        {
          command: "insert",
          file: "chapter.md",
          documentId: DOC_ID,
          content: "First same response.",
        },
        {
          sessionId: "session-same-response-db",
          threadId: THREAD_ID,
          turnId: TURN_ID,
          responseId,
        },
      );
      if (stagedCreate.status !== "success") {
        throw new Error(`staged create failed: ${stagedCreate.text}`);
      }
      await expect(
        collab.agentEdit().write(
          {
            command: "insert",
            file: "chapter.md",
            documentId: DOC_ID,
            content: "Second same response.",
          },
          {
            sessionId: "session-same-response-db",
            threadId: THREAD_ID,
            turnId: TURN_ID,
            responseId,
          },
        ),
      ).resolves.toMatchObject({ status: "success" });

      await collab.finalizeResponseCommit(responseId, {
        threadId: THREAD_ID as never,
        turnId: TURN_ID as never,
      });

      const rows = await db
        .select({ id: branchWriteJournal.id, status: branchWriteJournal.status })
        .from(branchWriteJournal)
        .orderBy(branchWriteJournal.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual(expect.objectContaining({ status: "active" }));
      const pending = await collab.draftReview.preview({
        workId: WORK_ID as never,
        documentId: DOC_ID as never,
        draftId: await currentDraftId(collab, DOC_ID as never as string),
      });
      expect(pending.status).toBe("active");
      expect(await readMarkdown(collab, DOC_ID)).toContain("Base.");
    });

    it("durably commits distinct responses that reuse a provider-local tool id", async () => {
      const collab = createTestCollab();
      collab.bindHocuspocus(hocuspocus as never);
      await collab.writeDocument({
        documentId: DOC_ID as never,
        markdown: "Base.",
        origin: { type: "user", actorUserId: USER_ID as never },
        threadId: THREAD_ID as never,
      });

      await expect(
        collab.agentEdit().write(
          {
            command: "insert",
            file: "chapter.md",
            documentId: DOC_ID,
            content: "First reused tool id.",
            tool_use_id: "call_mock_write_1",
          },
          {
            sessionId: "session-reused-provider-tool-id-db",
            threadId: THREAD_ID,
            turnId: TURN_ID,
            responseId: "response-reused-provider-tool-id-db-a",
          },
        ),
      ).resolves.toMatchObject({ status: "success" });
      await collab.finalizeResponseCommit("response-reused-provider-tool-id-db-a", {
        threadId: THREAD_ID as never,
        turnId: TURN_ID as never,
      });

      await expect(
        collab.agentEdit().write(
          {
            command: "insert",
            file: "chapter.md",
            documentId: DOC_ID,
            content: "Second reused tool id.",
            tool_use_id: "call_mock_write_1",
          },
          {
            sessionId: "session-reused-provider-tool-id-db",
            threadId: THREAD_ID,
            turnId: TURN_2_ID,
            responseId: "response-reused-provider-tool-id-db-b",
          },
        ),
      ).resolves.toMatchObject({ status: "success" });
      await collab.finalizeResponseCommit("response-reused-provider-tool-id-db-b", {
        threadId: THREAD_ID as never,
        turnId: TURN_2_ID as never,
      });

      const rows = await db
        .select({ id: branchWriteJournal.id, status: branchWriteJournal.status })
        .from(branchWriteJournal)
        .orderBy(branchWriteJournal.id);
      expect(rows).toEqual([
        expect.objectContaining({ status: "active" }),
        expect.objectContaining({ status: "active" }),
      ]);
    });

    async function activeWorkDraft() {
      return db
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
    }

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

async function readMarkdown(
  collab: {
    readAsMarkdown(documentId: string): Promise<{ ok: true; value: string } | { ok: false }>;
  },
  documentId: string,
): Promise<string> {
  const read = await collab.readAsMarkdown(documentId);
  return read.ok ? read.value : "";
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
