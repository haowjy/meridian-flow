// Durable capture, selective placement and compaction through the existing review application API.
import { randomUUID } from "node:crypto";
import { restorationAliasesFromMetadata } from "@meridian/prosemirror-schema";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { testFileGrant } from "../../../test-support/file-grants.js";
import { indexDraftUpdates } from "../domain/draft-review-attribution.js";
import {
  ALPHA_ID,
  closeDatabase,
  createHarness,
  createTestDatabase,
  PROJECT_ID,
  resetDatabase,
  schema,
  THREAD_ID,
  TURN_ID,
  USER_ID,
  WORK_ID,
} from "../test-support/change-trail-postgres-harness.js";
import { readLiveReviewRevision } from "./drizzle-draft-review-live.js";

async function stageDraft(
  db: ReturnType<typeof createTestDatabase>,
  harness: ReturnType<typeof createHarness>,
  initial: string,
  kind: "insert" | "replace",
  writes: readonly (readonly [string, string])[],
) {
  const fixture = harness.crossWorkProbeFixture(),
    responseId = randomUUID();
  await db.insert(schema.modelResponses).values({
    id: responseId as never,
    turnId: TURN_ID,
    sequence: 1,
    provider: "mock",
    model: "mock",
    requestMessageCount: 1,
    predictedCacheState: "cold",
    predictedCacheReason: "facts_unavailable",
  });
  await harness.seedWriterDocument(initial, responseId);
  const baseUpdate = await fixture.liveCoordinator.withDocument(ALPHA_ID, async (doc) =>
    Y.encodeStateAsUpdate(doc),
  );
  const context = {
    sessionId: THREAD_ID,
    threadId: THREAD_ID,
    turnId: TURN_ID,
    responseId,
    grant: testFileGrant({ kind: "draft", workId: WORK_ID, workSlug: "atomicity-work" }),
  };
  for (const [find, content] of writes)
    expect(
      await fixture.collab.agentEdit().write(
        {
          command: kind,
          file: "alpha.md",
          documentId: ALPHA_ID,
          find,
          content,
          tool_use_id: find,
        },
        context,
      ),
    ).toMatchObject({ status: "success", phase: "staged" });
  expect(await harness.commit(responseId)).toMatchObject({ status: "committed" });
  const branch = await fixture.branchStore.resolveWorkDraftBranchForThread(ALPHA_ID, THREAD_ID);
  const branchId = branch.branchId;
  branch.doc.destroy();
  const rows = await db
    .select()
    .from(schema.branchWriteJournal)
    .where(eq(schema.branchWriteJournal.branchId, branchId))
    .orderBy(schema.branchWriteJournal.id);
  expect(rows).toHaveLength(2);
  return { fixture, branchId, rows, baseUpdate };
}

describe("document edit receipts (Postgres)", () => {
  const db = createTestDatabase();
  beforeEach(() => resetDatabase(db));
  afterAll(() => closeDatabase(db));
  it.each([
    "insert",
    "replace",
  ] as const)("successive selective Discards of %s changes preserve exact content", async (kind) => {
    const harness = createHarness(db);
    try {
      const { fixture, branchId, rows } = await stageDraft(db, harness, "red\n\nblue", kind, [
        ["red", kind === "insert" ? " gold" : "gold"],
        ["blue", kind === "insert" ? " silver" : "silver"],
      ]);
      const [draft] = await fixture.collab.draftReview.list({
        projectId: PROJECT_ID as never,
        workId: WORK_ID,
      });
      const target = {
        projectId: PROJECT_ID as never,
        workId: WORK_ID,
        documentId: ALPHA_ID,
        draftId: draft.draftId,
      };
      expect(await fixture.draftMarkdown(branchId)).toBe(
        kind === "insert" ? "red gold\n\nblue silver\n" : "gold\n\nsilver\n",
      );
      for (let n = 0; n < 2; n++) {
        const preview = await fixture.collab.draftReview.preview(target);
        if (preview.status !== "active") throw new Error("Draft disappeared before Discard");
        expect(preview.operations).toHaveLength(2 - n);
        expect(
          await fixture.collab.draftReview.discardWorkDraft({
            ...target,
            userId: USER_ID as never,
            operationIds: [preview.operations[0].operationId],
            liveRevisionToken: preview.liveRevisionToken,
            draftRevisionToken: preview.draftRevisionToken,
          }),
        ).toMatchObject({ status: "discarded" });
        expect(await fixture.draftMarkdown(branchId)).toBe(
          n === 0
            ? kind === "insert"
              ? "red\n\nblue silver\n"
              : "red\n\nsilver\n"
            : "red\n\nblue\n",
        );
        expect(await harness.liveMarkdown(ALPHA_ID)).toBe("red\n\nblue\n");
      }
      const originals = await db
        .select()
        .from(schema.branchWriteJournal)
        .where(
          and(
            eq(schema.branchWriteJournal.branchId, branchId),
            eq(schema.branchWriteJournal.source, "agent"),
          ),
        )
        .orderBy(schema.branchWriteJournal.id);
      expect(originals.map((row) => ({ id: row.id, status: row.status }))).toEqual(
        rows.map((row) => ({ id: row.id, status: "discarded" })),
      );
      expect(
        await fixture.collab.draftReview.list({ projectId: PROJECT_ID as never, workId: WORK_ID }),
      ).toEqual([]);
    } finally {
      harness.cancelScheduledPulls();
      harness.destroyWarmState();
    }
  });
  it.each([
    "metadata reader",
    "original edit attribution",
  ])("Discard preserves %s", async (contract) => {
    const harness = createHarness(db),
      baseDoc = new Y.Doc({ gc: false });
    try {
      const { fixture, branchId, rows, baseUpdate } = await stageDraft(
        db,
        harness,
        "red",
        "replace",
        [
          ["red", "gold"],
          ["gold", "silver"],
        ],
      );
      Y.applyUpdate(baseDoc, baseUpdate);
      expect(
        await fixture.branchReview.discardSelected({
          branchId,
          reviewedByUserId: USER_ID as never,
          selectRows: async () => ({
            journalIds: [rows[1].id],
            expectedLiveRevision: await readLiveReviewRevision(db, ALPHA_ID),
          }),
        }),
      ).toMatchObject({ status: "discarded" });
      expect(await fixture.draftMarkdown(branchId)).toBe("gold\n");
      const history = await db
        .select()
        .from(schema.branchWriteJournal)
        .where(eq(schema.branchWriteJournal.branchId, branchId))
        .orderBy(schema.branchWriteJournal.id);
      const restoration = history[2];
      const [part] = await db
        .select()
        .from(schema.documentEditParts)
        .where(
          eq(schema.documentEditParts.origin, {
            kind: "pending",
            branchId,
            generation: restoration.generation,
            rowId: restoration.id,
          }),
        );
      if (contract === "metadata reader") {
        expect(restorationAliasesFromMetadata(restoration.updateMeta)).toEqual(
          part.aliases.map((a) => ({
            source: { ...a.source, length: a.len },
            target: { ...a.target, length: a.len },
          })),
        );
      } else {
        const attributed = indexDraftUpdates({
          baseDoc,
          updates: history.map((row) => ({
            id: row.id,
            actorTurnId: row.turnId,
            actorUserId: row.actorUserId,
            updateData: row.updateData,
            updateMeta: row.updateMeta,
          })),
        }).attributeRanges({
          insertedRanges: part.effect.inserted.map((r) => ({
            client: r.client,
            clock: r.clock,
            length: r.len,
          })),
          deletedRanges: [],
        });
        expect(attributed.operationIds).toEqual([String(rows[0].id)]);
        expect(attributed.insertedAttribution.map((r) => r.operationId)).toEqual(
          part.effect.inserted.map(() => String(rows[0].id)),
        );
      }
    } finally {
      baseDoc.destroy();
      harness.cancelScheduledPulls();
      harness.destroyWarmState();
    }
  });
  it("captures draft segments, places Apply/Discard and retains receipts beyond journal compaction", async () => {
    const harness = createHarness(db),
      fixture = harness.crossWorkProbeFixture(),
      responseId = randomUUID();
    try {
      await db.insert(schema.modelResponses).values({
        id: responseId as never,
        turnId: TURN_ID,
        sequence: 1,
        provider: "mock",
        model: "mock",
        requestMessageCount: 1,
        predictedCacheState: "cold",
        predictedCacheReason: "facts_unavailable",
      });
      await harness.seedWriterDocument("red\n\nblue", responseId);
      const context = {
        sessionId: THREAD_ID,
        threadId: THREAD_ID,
        turnId: TURN_ID,
        responseId,
        grant: testFileGrant({ kind: "draft", workId: WORK_ID, workSlug: "atomicity-work" }),
      };
      for (const [find, content] of [
        ["red", "gold"],
        ["blue", "silver"],
      ])
        expect(
          await fixture.collab.agentEdit().write(
            {
              command: "replace",
              file: "alpha.md",
              documentId: ALPHA_ID,
              find,
              content,
              tool_use_id: find,
            },
            context,
          ),
        ).toMatchObject({ status: "success", phase: "staged" });
      expect(await harness.commit(responseId)).toMatchObject({ status: "committed" });
      const edits = await db
        .select()
        .from(schema.documentEdits)
        .where(
          and(
            eq(schema.documentEdits.documentId, ALPHA_ID),
            eq(schema.documentEdits.actor, "agent"),
          ),
        )
        .orderBy(schema.documentEdits.wId);
      expect(edits.map((e) => ({ wId: e.wId, kind: e.kind, responseId: e.responseId }))).toEqual([
        { wId: 1, kind: "write", responseId },
        { wId: 2, kind: "write", responseId },
      ]);
      const before = await db
        .select()
        .from(schema.documentEditParts)
        .where(eq(schema.documentEditParts.editId, edits[0].id));
      expect(before).toHaveLength(1);
      expect(before[0].placement.kind).toBe("pending");
      expect(before[0].frontier).not.toEqual({});
      const [draft] = await fixture.collab.draftReview.list({
        projectId: PROJECT_ID as never,
        workId: WORK_ID,
      });
      const target = {
        projectId: PROJECT_ID as never,
        workId: WORK_ID,
        documentId: ALPHA_ID,
        draftId: draft.draftId,
      };
      const preview = await fixture.collab.draftReview.preview(target);
      if (preview.status !== "active") throw new Error("Draft disappeared");
      expect(preview.operations).toHaveLength(2);
      const gold = preview.operations.find((op) => op.afterExcerpt === "gold");
      if (!gold) throw new Error("Missing gold change");
      expect(
        await fixture.collab.draftReview.applyWorkDraftChanges({
          ...target,
          userId: USER_ID as never,
          operationIds: [gold.operationId],
          liveRevisionToken: preview.liveRevisionToken,
          draftRevisionToken: preview.draftRevisionToken,
        }),
      ).toMatchObject({ status: "applied" });
      expect(await harness.liveMarkdown(ALPHA_ID)).toBe("gold\n\nblue\n");
      const next = await fixture.collab.draftReview.preview(target);
      if (next.status !== "active") throw new Error("Remaining draft disappeared");
      expect(next.operations).toHaveLength(1);
      expect(
        await fixture.collab.draftReview.discardWorkDraft({
          ...target,
          userId: USER_ID as never,
          operationIds: [next.operations[0].operationId],
          liveRevisionToken: next.liveRevisionToken,
          draftRevisionToken: next.draftRevisionToken,
        }),
      ).toMatchObject({ status: "discarded" });
      const parts = await db
        .select()
        .from(schema.documentEditParts)
        .where(eq(schema.documentEditParts.editId, edits[0].id));
      expect(parts).toHaveLength(1);
      expect(parts[0].placement.kind).toBe("live");
      if (parts[0].placement.kind !== "live") throw new Error("Part was not published");
      const [authored] = await db
        .select()
        .from(schema.documentYjsUpdates)
        .where(eq(schema.documentYjsUpdates.id, parts[0].placement.seq));
      expect(authored.originType).toBe("agent");
      expect({ editId: authored.editId, ordinal: authored.editPartOrdinal }).toEqual({
        editId: edits[0].id,
        ordinal: 0,
      });
      expect(authored.updateData).toEqual(parts[0].update);
      const discarded = await db
        .select()
        .from(schema.documentEditParts)
        .where(eq(schema.documentEditParts.editId, edits[1].id));
      expect(discarded.map((p) => p.placement)).toEqual([{ kind: "discarded" }]);
      const restorations = await db
        .select()
        .from(schema.documentEdits)
        .where(eq(schema.documentEdits.kind, "discard"));
      expect(restorations).toHaveLength(1);
      expect(restorations[0].actionId).toBeTypeOf("string");
      const restoration = await db
        .select()
        .from(schema.documentEditParts)
        .where(eq(schema.documentEditParts.editId, restorations[0].id));
      expect(restoration[0].aliases.length).toBeGreaterThan(0);
      expect(restoration[0].targets).toEqual([
        { editId: edits[1].id, ordinal: 0, direction: "invert" },
      ]);
      await fixture.persistence.journal.compact(ALPHA_ID, new Date(Date.now() + 1000));
      expect(
        await db
          .select()
          .from(schema.documentYjsUpdates)
          .where(eq(schema.documentYjsUpdates.documentId, ALPHA_ID)),
      ).toEqual([]);
      const retained = await db
        .select()
        .from(schema.documentEditParts)
        .where(eq(schema.documentEditParts.editId, edits[0].id));
      expect(retained[0].update).toEqual(before[0].update);
      expect(retained[0].effect).toEqual(before[0].effect);
      expect(await harness.liveMarkdown(ALPHA_ID)).toBe("gold\n\nblue\n");
    } finally {
      harness.cancelScheduledPulls();
      harness.destroyWarmState();
    }
  });
});
