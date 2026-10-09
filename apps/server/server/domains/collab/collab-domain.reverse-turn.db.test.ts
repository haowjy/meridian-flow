import { createDrizzleDocumentAssetPaths } from "../context/adapters/asset-path-resolver.js";
/** Public collab-domain reverseTurn coverage over Drizzle branch infrastructure. */

import { renderAgentEditResult } from "@meridian/agent-edit";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { asGrantedWriter, testFileGrant } from "../../test-support/file-grants.js";

import {
  CREATED_DOC_ID,
  createWorkDraftFixture,
  DOC_ID,
  DRAFT_DESTINATION,
  SOURCE_ID,
  THREAD_ID,
  TURN_2_ID,
  TURN_ID,
  USER_ID,
  WORK_ID,
} from "./test-support/work-draft-fixture.js";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("collab domain reverseTurn (postgres)", () => {});
} else {
  describe("collab domain reverseTurn (postgres)", async () => {
    const { createDb } = await import("@meridian/database");
    const {
      branchWriteJournal,
      documentBranches,
      documentYjsReversals,
      documentYjsUpdates,
      documents,
      modelResponses,
      works,
    } = await import("@meridian/database/schema");
    const { createDrizzleJournal } = await import("./adapters/drizzle-journal.js");
    const db = createDb(DATABASE_URL, { max: 4 });
    const { hocuspocus, createTestCollab, reset, dispose, applyDraft, currentDraftId } =
      createWorkDraftFixture(db);
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
      const { DrizzleContextTreeMutationStore } = await import(
        "../context/adapters/context-fs/drizzle-tree-mutation-store.js"
      );
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
        assetPaths: createDrizzleDocumentAssetPaths(db),
        scheme: "manuscript",
        store: new DrizzleContextDocumentStore({ db, contextSourceId: SOURCE_ID }),
        mutationStore: new DrizzleContextTreeMutationStore(db),
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
        const created = await context.write("fresh.md", "Seed.");
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
          .select()
          .from(documents)
          .where(eq(documents.id, created.value.documentId));
        expect(row?.markdownProjection).toBe("Current café.\n");
        expect(row?.sizeBytes).toBe(Buffer.byteLength("Current café.\n", "utf8"));
      } finally {
        await collab.documentDerivations.stop();
      }
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
      for (const [find, content] of [
        [fountain, gate],
        [gate, ""],
      ] as const) {
        await expect(
          collab.agentEdit().write(
            { command: "replace", file: "chapter.md", documentId: DOC_ID, find, content },
            {
              sessionId: "session-overlap",
              threadId: THREAD_ID,
              turnId: TURN_ID,
              grant: testFileGrant(DRAFT_DESTINATION),
            },
          ),
        ).resolves.toMatchObject({ status: "success" });
        await applyDraft(collab, DOC_ID);
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
      expect(redo.status).toBe("reversed");
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
            {
              sessionId: "session-atomic-reversal",
              threadId: THREAD_ID,
              turnId: TURN_ID,
              grant: testFileGrant(DRAFT_DESTINATION),
            },
          ),
        ).resolves.toMatchObject({ status: "success" });
        await applyDraft(collab, documentId);
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
      await collab.agentEdit().write(
        { command: "insert", file: "chapter.md", documentId: DOC_ID, content: "Agent change." },
        {
          sessionId: "session-writer-redo",
          threadId: THREAD_ID,
          turnId: TURN_ID,
          grant: testFileGrant(DRAFT_DESTINATION),
        },
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
        {
          sessionId: "session-live-dependent",
          threadId: THREAD_ID,
          turnId: TURN_ID,
          grant: testFileGrant(DRAFT_DESTINATION),
        },
      );
      const [workDraft] = await activeWorkDraft();
      await collab.pushToLive({ branchId: workDraft.id });

      await collab.writeDocument({
        documentId: DOC_ID as never,
        // A pure insertion anchored inside agent-born text: both the chip and the
        // real undo must treat it as dependent.
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
        {
          sessionId: "session-live-independent",
          threadId: THREAD_ID,
          turnId: TURN_ID,
          grant: testFileGrant(DRAFT_DESTINATION),
        },
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
          grant: testFileGrant(DRAFT_DESTINATION),
          threadId: THREAD_ID,
          turnId: TURN_ID,
          responseId,
        },
      );
      if (stagedCreate.status !== "success") {
        throw new Error(`staged create failed: ${renderAgentEditResult(stagedCreate.result)}`);
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
            grant: testFileGrant(DRAFT_DESTINATION),
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
            grant: testFileGrant(DRAFT_DESTINATION),
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
            grant: testFileGrant(DRAFT_DESTINATION),
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
