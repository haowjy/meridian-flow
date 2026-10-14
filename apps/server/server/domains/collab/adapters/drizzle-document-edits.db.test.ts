// Immutable receipt capture, generation placement and compaction through the review API.
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { commitSegmentRows } from "../test-support/branch-update-writes.js";
import {
  ALPHA_ID,
  closeDatabase,
  createHarness,
  createTestDatabase,
  resetDatabase,
  schema,
  THREAD_ID,
  TURN_ID,
  USER_ID,
} from "../test-support/change-trail-postgres-harness.js";
import {
  createResponse,
  setupResponseDraft,
  stageDraft,
} from "../test-support/document-edit-receipt-fixture.js";
import { commitBranchEdit, reviewDriver } from "../test-support/draft-review-requests.js";

describe("document edit receipts (Postgres)", () => {
  const db = createTestDatabase();
  beforeEach(() => resetDatabase(db));
  afterAll(() => closeDatabase(db));
  describe("current generation receipt placement", () => {
    let harness: ReturnType<typeof createHarness>;
    let draft: Awaited<ReturnType<typeof setupResponseDraft>>;
    beforeEach(async () => {
      harness = createHarness(db);
      draft = await setupResponseDraft(db, harness);
      await draft.review("gold");
    });
    afterEach(() => {
      harness.cancelScheduledPulls();
      harness.destroyWarmState();
    });
    async function expectSurvivor() {
      const { branchId, rows } = draft;
      // Surviving immutable receipts point at new journal rows with exactly the
      // same identities, bytes and ordinal. The discarded part remains terminal.
      const successor = await db
        .select()
        .from(schema.branchWriteJournal)
        .where(
          and(
            eq(schema.branchWriteJournal.branchId, branchId),
            eq(schema.branchWriteJournal.generation, 2),
          ),
        );
      const survivor = successor.filter((row) => row.toolCallId === rows[1].toolCallId);
      expect(survivor).toHaveLength(1);
      expect(survivor[0].updateData).toEqual(rows[1].updateData);
      expect((survivor[0].updateMeta as { documentEdit: unknown }).documentEdit).toEqual(
        (rows[1].updateMeta as { documentEdit: unknown }).documentEdit,
      );
    }
    it("writer insertion after Discard publishes restored text", async () => {
      const { fixture, branchId, review } = draft;
      const snapshot = await fixture.branchStore.getBranch(branchId);
      if (!snapshot) throw new Error("Missing branch");
      const room = new Y.Doc({ gc: false });
      try {
        Y.applyUpdate(room, snapshot.state);
        let delta!: Uint8Array;
        room.on("update", (update: Uint8Array) => {
          delta = update;
        });
        const paragraph = room.getXmlFragment("prosemirror").get(0) as Y.XmlElement;
        (paragraph.get(0) as Y.XmlText).insert(2, "X");
        expect(
          await fixture.branchCoordinator.commitWriterUpdate({
            branchId,
            updateData: delta,
            roomDocument: room,
            actorUserId: USER_ID,
          }),
        ).toEqual({ admitted: true });
      } finally {
        room.destroy();
      }
      await review("X", true);
      expect(await harness.liveMarkdown(ALPHA_ID)).toBe("reXd\n\nblue\n\ngreen\n");
      await expectSurvivor();
    });
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
    const harness = createHarness(db),
      fixture = harness.crossWorkProbeFixture();
    const responseId = await createResponse(db, 1);
    try {
      await harness.seedWriterDocument("red\n\nblue", responseId);
      const branch = await fixture.branchStore.resolveWorkDraftBranchForThread(ALPHA_ID, THREAD_ID);
      const branchId = branch.branchId;
      branch.doc.destroy();
      const review = reviewDriver(fixture.collab.draftReview);
      let ordinal = 0;
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
            await commitSegmentRows(fixture.branchCoordinator, {
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
                  wId: actor === "agent" ? ++ordinal : null,
                  updateMeta: null,
                },
              ],
            }),
          ).toBeTruthy();
        } finally {
          doc.destroy();
        }
      };
      const reviewRed = async (apply: boolean) => {
        const preview = await review.activePreview(ALPHA_ID);
        const change = preview.operations.find((op) => op.beforeExcerpt === "red");
        if (!change) throw new Error(`Missing red change: ${JSON.stringify(preview.operations)}`);
        const ids = [change.operationId];
        expect(
          await (apply
            ? review.applyChanges(ALPHA_ID, preview, ids)
            : review.discardChanges(ALPHA_ID, preview, ids)),
        ).toMatchObject({ status: apply ? "applied" : "discarded" });
      };
      await replace(0, operation === "apply from deletion" ? "" : "gold");
      await replace(1, "azure");
      await reviewRed(false);
      expect(await fixture.draftMarkdown(branchId)).toBe("red\n\nazure\n");
      await replace(0, operation === "delete" || operation === "apply deletion" ? "" : "silver");
      const apply = operation.startsWith("apply");
      await reviewRed(apply);
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
        const preview = await review.activePreview(ALPHA_ID);
        expect(preview.operations.map((op) => op.afterExcerpt)).toEqual(["azure"]);
        expect(await review.applyChanges(ALPHA_ID, preview)).toMatchObject({ status: "applied" });
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
      const review = reviewDriver(fixture.collab.draftReview);
      expect(await fixture.draftMarkdown(branchId)).toBe(
        kind === "insert" ? "red gold\n\nblue silver\n" : "gold\n\nsilver\n",
      );
      let survivorToken: string | undefined;
      for (let n = 0; n < 2; n++) {
        const preview = await review.activePreview(ALPHA_ID);
        expect(preview.operations).toHaveLength(2 - n);
        if (n === 0) survivorToken = preview.operations[1].admissionToken;
        else expect(preview.operations[0].admissionToken).toBe(survivorToken);
        expect(
          await review.discardChanges(ALPHA_ID, preview, [preview.operations[0].operationId]),
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
      expect(
        originals
          .filter((row) => rows.some((original) => original.id === row.id))
          .map((row) => ({ id: row.id, status: row.status })),
      ).toEqual(rows.map((row) => ({ id: row.id, status: "discarded" })));
      expect(await review.list()).toEqual([]);
    } finally {
      harness.cancelScheduledPulls();
      harness.destroyWarmState();
    }
  });
  it.each([
    "unchanged",
    "changed",
    "gone",
    "apply",
  ] as const)("admits a held class request after another Discard: %s", async (scenario) => {
    const harness = createHarness(db);
    try {
      const { fixture, branchId } = await stageDraft(db, harness, "red\n\nblue", "replace", [
        ["red", "gold"],
        ["blue", "silver"],
      ]);
      const review = reviewDriver(fixture.collab.draftReview);
      const before = await review.activePreview(ALPHA_ID);
      const a = before.operations.find((op) => op.afterExcerpt === "gold");
      const b = before.operations.find((op) => op.afterExcerpt === "silver");
      if (!a || !b) throw new Error("Missing independent classes");
      expect(a.closureClassId).not.toBe(b.closureClassId);
      const heldB = [b.operationId];
      expect(await review.discardChanges(ALPHA_ID, before, [a.operationId])).toMatchObject({
        status: "discarded",
      });
      const after = await review.activePreview(ALPHA_ID);
      expect(after.operations).toHaveLength(1);
      expect(after.operations[0].operationId).not.toBe(b.operationId);
      expect(after.operations[0].closureClassId).toBe(b.closureClassId);
      expect(after.operations[0].admissionToken).toBe(b.admissionToken);
      expect(await fixture.draftMarkdown(branchId)).toBe("red\n\nsilver\n");
      expect(await harness.liveMarkdown(ALPHA_ID)).toBe("red\n\nblue\n");

      if (scenario === "changed") {
        await commitBranchEdit(fixture, branchId, { source: "writer" }, (doc) => {
          const paragraph = doc.getXmlFragment("prosemirror").get(1) as Y.XmlElement;
          (paragraph.get(0) as Y.XmlText).delete(4, 2);
        });
        const changed = await review.activePreview(ALPHA_ID);
        expect(changed.operations.find((op) => op.kind === "agent")?.closureClassId).toBe(
          b.closureClassId,
        );
        expect(changed.operations.find((op) => op.kind === "agent")?.admissionToken).not.toBe(
          b.admissionToken,
        );
      }
      if (scenario === "gone") {
        expect(await review.discardChanges(ALPHA_ID, before, heldB)).toMatchObject({
          status: "discarded",
        });
      }
      const result =
        scenario === "apply"
          ? await review.applyChanges(ALPHA_ID, before, heldB)
          : await review.discardChanges(ALPHA_ID, before, heldB);
      expect(result).toMatchObject({
        status:
          scenario === "apply" || scenario === "changed"
            ? "stale"
            : scenario === "gone"
              ? "gone"
              : "discarded",
      });
      expect(await harness.liveMarkdown(ALPHA_ID)).toBe("red\n\nblue\n");
      expect(await fixture.draftMarkdown(branchId)).toBe(
        scenario === "apply"
          ? "red\n\nsilver\n"
          : scenario === "changed"
            ? "red\n\nsilv\n"
            : "red\n\nblue\n",
      );
    } finally {
      harness.cancelScheduledPulls();
      harness.destroyWarmState();
    }
  });
  it.each([
    "captured",
    "without-part",
  ] as const)("held writer class after re-journaling: %s", async (identity) => {
    const harness = createHarness(db);
    try {
      const { fixture, branchId } = await stageDraft(db, harness, "red\n\nblue", "replace", [
        ["red", "gold"],
      ]);
      const snapshot = await fixture.branchStore.getBranch(branchId);
      if (!snapshot) throw new Error("Missing branch");
      const room = new Y.Doc({ gc: false });
      try {
        Y.applyUpdate(room, snapshot.state);
        let update!: Uint8Array;
        room.on("update", (delta: Uint8Array) => {
          update = delta;
        });
        const paragraph = room.getXmlFragment("prosemirror").get(1) as Y.XmlElement;
        (paragraph.get(0) as Y.XmlText).insert(4, " writer");
        await fixture.branchCoordinator.commitWriterUpdate({
          branchId,
          updateData: update,
          roomDocument: room,
          actorUserId: USER_ID,
        });
      } finally {
        room.destroy();
      }
      if (identity === "without-part") {
        // Exercise the supported row-ID fallback when immutable capture metadata is absent.
        await db
          .update(schema.branchWriteJournal)
          .set({ updateMeta: null })
          .where(
            and(
              eq(schema.branchWriteJournal.branchId, branchId),
              eq(schema.branchWriteJournal.source, "writer"),
            ),
          );
      }
      const review = reviewDriver(fixture.collab.draftReview);
      const before = await review.activePreview(ALPHA_ID);
      const writer = before.operations.find((op) => op.kind === "writer");
      const agent = before.operations.find((op) => op.kind === "agent");
      if (!writer || !agent) throw new Error("Missing classes");
      if (identity === "captured") expect(writer.partKey).toBeDefined();
      else expect(writer.partKey).toBeUndefined();
      expect(await review.discardChanges(ALPHA_ID, before, [agent.operationId])).toMatchObject({
        status: "discarded",
      });
      const after = await review.activePreview(ALPHA_ID);
      expect(after.operations).toHaveLength(1);
      if (identity === "captured") {
        expect(after.operations[0].closureClassId).toBe(writer.closureClassId);
        expect(after.operations[0].admissionToken).toBe(writer.admissionToken);
      } else {
        expect(after.operations[0].closureClassId).not.toBe(writer.closureClassId);
        expect(after.operations[0].admissionToken).not.toBe(writer.admissionToken);
      }
      expect(await review.discardChanges(ALPHA_ID, before, [writer.operationId])).toMatchObject({
        status: identity === "captured" ? "discarded" : "gone",
      });
      expect(await fixture.draftMarkdown(branchId)).toBe(
        identity === "captured" ? "red\n\nblue\n" : "red\n\nblue writer\n",
      );
      expect(await harness.liveMarkdown(ALPHA_ID)).toBe("red\n\nblue\n");
    } finally {
      harness.cancelScheduledPulls();
      harness.destroyWarmState();
    }
  });
  it("captures draft segments, places Apply/Discard and retains receipts beyond journal compaction", async () => {
    const harness = createHarness(db);
    try {
      const { fixture, responseId } = await stageDraft(db, harness, "red\n\nblue", "replace", [
        ["red", "gold"],
        ["blue", "silver"],
      ]);
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
      const review = reviewDriver(fixture.collab.draftReview);
      const preview = await review.activePreview(ALPHA_ID);
      expect(preview.operations).toHaveLength(2);
      expect(preview.operations.map((op) => op.partKey).sort()).toEqual(
        edits.map((edit) => `${edit.id}:0`).sort(),
      );
      const gold = preview.operations.find((op) => op.afterExcerpt === "gold");
      if (!gold) throw new Error("Missing gold change");
      expect(await review.applyChanges(ALPHA_ID, preview, [gold.operationId])).toMatchObject({
        status: "applied",
      });
      expect(await harness.liveMarkdown(ALPHA_ID)).toBe("gold\n\nblue\n");
      const next = await review.activePreview(ALPHA_ID);
      expect(next.operations).toHaveLength(1);
      expect(await review.discardChanges(ALPHA_ID, next)).toMatchObject({ status: "discarded" });
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
