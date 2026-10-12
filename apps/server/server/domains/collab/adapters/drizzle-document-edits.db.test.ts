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
  expect(rows).toHaveLength(writes.length);
  return { fixture, branchId, rows, baseUpdate };
}

describe("document edit receipts (Postgres)", () => {
  const db = createTestDatabase();
  beforeEach(() => resetDatabase(db));
  afterAll(() => closeDatabase(db));
  it.each([
    "nonempty Discard",
    "overlap Discard",
    "empty Discard",
    "empty Discard net-zero save",
    "empty Apply",
    "whole Discard",
    "rollback after empty Discard",
    "rollback after empty Apply",
  ] as const)("in-flight reply: %s", async (mode) => {
    const harness = createHarness(db);
    try {
      const { fixture, branchId } = await stageDraft(
        db,
        harness,
        "red\n\nblue\n\ngreen",
        "replace",
        mode === "nonempty Discard" || mode === "overlap Discard"
          ? [
              ["red", "gold"],
              ["blue", "azure"],
            ]
          : [["red", "gold"]],
      );
      const responseId = randomUUID();
      await db.insert(schema.modelResponses).values({
        id: responseId as never,
        turnId: TURN_ID,
        sequence: 2,
        provider: "mock",
        model: "mock",
        requestMessageCount: 1,
        predictedCacheState: "cold",
        predictedCacheReason: "facts_unavailable",
      });
      expect(
        await fixture.collab.agentEdit().write(
          {
            command: "replace",
            file: "alpha.md",
            documentId: ALPHA_ID,
            find: mode === "overlap Discard" ? "gold" : "green",
            content: mode === "overlap Discard" ? "golden" : "lime",
            tool_use_id: "in-flight",
          },
          {
            sessionId: THREAD_ID,
            threadId: THREAD_ID,
            turnId: TURN_ID,
            responseId,
            grant: testFileGrant({ kind: "draft", workId: WORK_ID, workSlug: "atomicity-work" }),
          },
        ),
      ).toMatchObject({ status: "success", phase: "staged" });
      if (mode === "empty Discard net-zero save") {
        expect(
          await fixture.collab.agentEdit().write(
            {
              command: "replace",
              file: "alpha.md",
              documentId: ALPHA_ID,
              find: "lime",
              content: "green",
              tool_use_id: "net-zero-tail",
            },
            {
              sessionId: THREAD_ID,
              threadId: THREAD_ID,
              turnId: TURN_ID,
              responseId,
              grant: testFileGrant({
                kind: "draft",
                workId: WORK_ID,
                workSlug: "atomicity-work",
              }),
            },
          ),
        ).toMatchObject({ status: "success", phase: "staged" });
      }
      const target = {
        projectId: PROJECT_ID as never,
        workId: WORK_ID,
        documentId: ALPHA_ID,
        draftId: branchId,
      };
      const preview = await fixture.collab.draftReview.preview(target);
      if (preview.status !== "active") throw new Error("Missing preview");
      const gold = preview.operations.find((op) => op.afterExcerpt === "gold");
      if (!gold) throw new Error("Missing gold");
      const command = {
        ...target,
        userId: USER_ID as never,
        operationIds: [gold.operationId],
        liveRevisionToken: preview.liveRevisionToken,
        draftRevisionToken: preview.draftRevisionToken,
      };
      const result =
        mode === "whole Discard"
          ? await fixture.collab.draftReview.discardWorkDraft({
              ...target,
              userId: USER_ID as never,
            })
          : mode.includes("Apply")
            ? await fixture.collab.draftReview.applyWorkDraftChanges(command)
            : await fixture.collab.draftReview.discardWorkDraft(command);
      expect(result).toMatchObject({ status: mode.includes("Apply") ? "applied" : "discarded" });
      if (mode === "whole Discard") {
        expect(fixture.collab.agentEdit().hasResponseDocument(responseId, ALPHA_ID)).toBe(false);
        await expect(harness.commit(responseId)).rejects.toThrow("already rolled back");
        expect(await fixture.draftMarkdown(branchId)).toBe("red\n\nblue\n\ngreen\n");
        expect(await harness.liveMarkdown(ALPHA_ID)).toBe("red\n\nblue\n\ngreen\n");
        expect((await fixture.branchStore.getBranch(branchId))?.generation).toBe(2);
        return;
      }
      expect((await fixture.branchStore.getBranch(branchId))?.generation).toBe(1);
      if (mode.startsWith("rollback")) {
        await fixture.collab.agentEdit().rollbackResponse(responseId);
        expect((await fixture.branchStore.getBranch(branchId))?.generation).toBe(2);
        expect(await fixture.draftMarkdown(branchId)).toBe(
          mode.includes("Apply") ? "gold\n\nblue\n\ngreen\n" : "red\n\nblue\n\ngreen\n",
        );
      } else {
        expect(await harness.commit(responseId)).toMatchObject({ status: "committed" });
        if (mode === "empty Discard net-zero save") {
          expect((await fixture.branchStore.getBranch(branchId))?.generation).toBe(2);
          expect(await fixture.draftMarkdown(branchId)).toBe("red\n\nblue\n\ngreen\n");
          expect(await harness.liveMarkdown(ALPHA_ID)).toBe("red\n\nblue\n\ngreen\n");
          return;
        }

        expect(await fixture.draftMarkdown(branchId)).toBe(
          mode === "overlap Discard"
            ? "redgolden\n\nazure\n\ngreen\n"
            : `${mode.includes("Apply") ? "gold" : "red"}\n\n${mode === "nonempty Discard" ? "azure" : "blue"}\n\nlime\n`,
        );
        expect((await fixture.branchStore.getBranch(branchId))?.generation).toBe(1);
        const next = await fixture.collab.draftReview.preview(target);
        if (next.status !== "active") throw new Error("Missing saved reply preview");
        expect(next.operations.map((op) => op.afterExcerpt).sort()).toEqual(
          mode === "overlap Discard"
            ? ["azure", "redgolden"]
            : mode === "nonempty Discard"
              ? ["azure", "lime"]
              : ["lime"],
        );
      }
      expect(await harness.liveMarkdown(ALPHA_ID)).toBe(
        mode.includes("Apply") ? "gold\n\nblue\n\ngreen\n" : "red\n\nblue\n\ngreen\n",
      );
    } finally {
      harness.cancelScheduledPulls();
      harness.destroyWarmState();
    }
  });
  it.each(
    (["agent", "writer"] as const).flatMap((actor) =>
      (["replace", "delete", "apply", "apply deletion", "apply from deletion"] as const).map(
        (operation) => ({
          actor,
          operation,
        }),
      ),
    ),
  )("$actor $operation after Discard uses the restored word", async ({ actor, operation }) => {
    let pause = false;
    const harness = createHarness(db, {
        afterDurableCommit: async () => {
          if (pause) {
            pause = false;
            throw new Error("pause carried publication");
          }
        },
      }),
      fixture = harness.crossWorkProbeFixture();
    const responseId = randomUUID();
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
      const branch = await fixture.branchStore.resolveWorkDraftBranchForThread(ALPHA_ID, THREAD_ID);
      const branchId = branch.branchId;
      branch.doc.destroy();
      const target = {
        projectId: PROJECT_ID as never,
        workId: WORK_ID,
        documentId: ALPHA_ID,
        draftId: branchId,
      };
      const replace = async (paragraph: number, text: string) => {
        const snapshot = await fixture.branchStore.getBranch(branchId);
        if (!snapshot) throw new Error("Missing branch");
        const doc = new Y.Doc({ gc: false });
        try {
          Y.applyUpdate(doc, snapshot.state);
          const deltas: Uint8Array[] = [];
          doc.on("update", (update: Uint8Array) => deltas.push(update));
          const node = doc.getXmlFragment("prosemirror").get(paragraph) as Y.XmlElement;
          const value = node.get(0) as Y.XmlText;
          doc.transact(() => {
            value.delete(0, value.length);
            if (text) value.insert(0, text);
          });
          expect(
            await fixture.branchCoordinator.commitSegmentRows({
              branchId,
              sourceDoc: doc,
              expectedGeneration: snapshot.generation,
              rows: [
                {
                  branchId,
                  updateData: Y.mergeUpdates(deltas),
                  source: actor,
                  actorUserId: actor === "writer" ? (USER_ID as never) : null,
                  threadId: actor === "agent" ? THREAD_ID : null,
                  turnId: actor === "agent" ? TURN_ID : null,
                  wId: null,
                  updateMeta: null,
                },
              ],
            }),
          ).toBeTruthy();
        } finally {
          doc.destroy();
        }
      };
      const review = async (apply: boolean) => {
        const preview = await fixture.collab.draftReview.preview(target);
        if (preview.status !== "active") throw new Error("Missing preview");
        const change = preview.operations.find((op) => op.beforeExcerpt === "red");
        if (!change) throw new Error(`Missing red change: ${JSON.stringify(preview.operations)}`);
        const command = {
          ...target,
          userId: USER_ID as never,
          operationIds: [change.operationId],
          liveRevisionToken: preview.liveRevisionToken,
          draftRevisionToken: preview.draftRevisionToken,
        };
        if (apply && operation === "apply from deletion") {
          pause = true;
          await expect(fixture.collab.draftReview.applyWorkDraftChanges(command)).rejects.toThrow(
            "pause carried publication",
          );
          const [outbox] = await db
            .select()
            .from(schema.branchPushSettlementOutbox)
            .where(eq(schema.branchPushSettlementOutbox.state, "pending"));
          const history = await db
            .select()
            .from(schema.branchWriteJournal)
            .where(eq(schema.branchWriteJournal.branchId, branchId))
            .orderBy(schema.branchWriteJournal.id);
          expect(outbox.transportJournalIds).toEqual([history[0].id, history[2].id]);
          const [push] = await db
            .select()
            .from(schema.pushLineage)
            .where(eq(schema.pushLineage.id, outbox.pushId));
          expect(push.journalIds).toEqual([history[3].id]);
          harness.cancelScheduledPulls();
          harness.destroyWarmState();
          await db
            .update(schema.branchPushSettlementOutbox)
            .set({ leaseExpiresAt: new Date(0), availableAt: new Date(0) })
            .where(eq(schema.branchPushSettlementOutbox.pushId, outbox.pushId));
          const cold = createHarness(db);
          try {
            expect(await cold.recoverPendingLiveSettlements()).toBe(1);
          } finally {
            cold.cancelScheduledPulls();
            cold.destroyWarmState();
          }
        } else
          expect(
            await (apply
              ? fixture.collab.draftReview.applyWorkDraftChanges(command)
              : fixture.collab.draftReview.discardWorkDraft(command)),
          ).toMatchObject({ status: apply ? "applied" : "discarded" });
      };
      await replace(0, operation === "apply from deletion" ? "" : "gold");
      await replace(1, "azure");
      await review(false);
      expect(await fixture.draftMarkdown(branchId)).toBe("red\n\nazure\n");
      await replace(0, operation === "delete" || operation === "apply deletion" ? "" : "silver");
      const apply = operation.startsWith("apply");
      await review(apply);
      expect(await harness.liveMarkdown(ALPHA_ID)).toBe(
        apply
          ? operation === "apply deletion"
            ? "\u00a0\n\nblue\n"
            : "silver\n\nblue\n"
          : "red\n\nblue\n",
      );
      expect(await fixture.draftMarkdown(branchId)).toBe(
        apply
          ? operation === "apply deletion"
            ? "\u00a0\n\nazure\n"
            : "silver\n\nazure\n"
          : "red\n\nazure\n",
      );
      if (operation === "apply deletion") {
        expect(
          await fixture.liveCoordinator.withDocument(ALPHA_ID, async (doc) =>
            (doc.getXmlFragment("prosemirror").get(0) as Y.XmlElement)
              .toArray()
              .map((text) => text.toString())
              .join(""),
          ),
        ).toBe("");
      }
      if (apply) {
        const history = await db
          .select()
          .from(schema.branchWriteJournal)
          .where(eq(schema.branchWriteJournal.branchId, branchId))
          .orderBy(schema.branchWriteJournal.id);
        const original = history[0],
          restoration = history[2];
        for (const row of [original, restoration]) {
          const [part] = await db
            .select()
            .from(schema.documentEditParts)
            .where(
              eq(schema.documentEditParts.origin, {
                kind: "pending",
                branchId,
                generation: row.generation,
                rowId: row.id,
              }),
            );
          expect(part.placement.kind).toBe(row === original ? "discarded" : "live");
          const transported = await db
            .select()
            .from(schema.documentYjsUpdates)
            .where(
              and(
                eq(schema.documentYjsUpdates.documentId, ALPHA_ID),
                eq(schema.documentYjsUpdates.updateData, row.updateData),
              ),
            );
          expect(
            transported.map((live) => ({
              origin: live.originType,
              user: live.actorUserId,
              turn: live.actorTurnId,
            })),
          ).toEqual([{ origin: "reconcile", user: null, turn: null }]);
        }
        const preview = await fixture.collab.draftReview.preview(target);
        if (preview.status !== "active") throw new Error("Missing azure preview");
        expect(preview.operations.map((op) => op.afterExcerpt)).toEqual(["azure"]);
        expect(
          await fixture.collab.draftReview.applyWorkDraftChanges({
            ...target,
            userId: USER_ID as never,
            operationIds: [preview.operations[0].operationId],
            liveRevisionToken: preview.liveRevisionToken,
            draftRevisionToken: preview.draftRevisionToken,
          }),
        ).toMatchObject({ status: "applied" });
        expect(await harness.liveMarkdown(ALPHA_ID)).toBe(await fixture.draftMarkdown(branchId));
      }
    } finally {
      harness.cancelScheduledPulls();
      harness.destroyWarmState();
    }
  });
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
