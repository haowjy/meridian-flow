// Immutable receipt capture, generation placement and compaction through the review API.
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
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

import {
  createResponse,
  reviewChange,
  setupResponseDraft,
  stageDraft,
} from "../test-support/document-edit-receipt-fixture.js";

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
            expectedGeneration: snapshot.generation,
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
    it("successive replies can discard the restored word", async () => {
      const { fixture, branchId, responseId, context, review } = draft;
      for (const [index, text] of ["silver", "copper"].entries()) {
        // Save each distinct reply, as in the original production witness.
        const id = index === 0 ? responseId : await createResponse(db, 3);
        expect(
          await fixture.collab.agentEdit().write(
            {
              command: "replace",
              file: "alpha.md",
              documentId: ALPHA_ID,
              find: "red",
              content: text,
              tool_use_id: text,
            },
            { ...context, responseIdentity: { providerResponseId: id, editScopeId: id } },
          ),
        ).toMatchObject({ status: "success" });
        await harness.commit(id);
        await review(text);
        expect(await fixture.draftMarkdown(branchId)).toBe("red\n\nazure\n\ngreen\n");
      }
      await expectSurvivor();
    });
    it("cold recovery publishes the restored word and retains its turn shell", async () => {
      harness.cancelScheduledPulls();
      harness.destroyWarmState();
      harness = createHarness(db);
      const fixture = harness.crossWorkProbeFixture();
      await harness.recoverPendingLiveSettlements();
      const { responseId, context } = draft;
      const review = (after: string) => reviewChange(fixture, draft.target, after, true);
      expect(
        await fixture.collab.agentEdit().write(
          {
            command: "replace",
            file: "alpha.md",
            documentId: ALPHA_ID,
            find: "red",
            content: "silver",
            tool_use_id: "later-1",
          },
          context,
        ),
      ).toMatchObject({ status: "success" });
      await harness.commit(responseId);
      await review("silver");
      expect(await harness.liveMarkdown(ALPHA_ID)).toBe("silver\n\nblue\n\ngreen\n");
      const shells = await db.select().from(schema.changeTrailShells);
      expect(shells.map((shell) => ({ owner: shell.ownerKind, turnId: shell.turnId }))).toEqual([
        { owner: "turn", turnId: TURN_ID },
      ]);
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
      const target = {
        projectId: PROJECT_ID as never,
        workId: WORK_ID,
        documentId: ALPHA_ID,
        draftId: branchId,
      };
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
      const review = async (apply: boolean) => {
        const preview = await fixture.collab.draftReview.preview(target);
        if (preview.status !== "active") throw new Error("Missing preview");
        const change = preview.operations.find((op) => op.beforeExcerpt === "red");
        if (!change) throw new Error(`Missing red change: ${JSON.stringify(preview.operations)}`);
        const command = {
          ...target,
          userId: USER_ID as never,
          operationIds: [change.operationId],
          closureClassIds: [change.closureClassId],
          admissionTokens: [change.admissionToken],
          liveRevisionToken: preview.liveRevisionToken,
          draftRevisionToken: preview.draftRevisionToken,
        };
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
      let survivorToken: string | undefined;
      for (let n = 0; n < 2; n++) {
        const preview = await fixture.collab.draftReview.preview(target);
        if (preview.status !== "active") throw new Error("Draft disappeared before Discard");
        expect(preview.operations).toHaveLength(2 - n);
        if (n === 0) survivorToken = preview.operations[1].admissionToken;
        else expect(preview.operations[0].admissionToken).toBe(survivorToken);
        expect(
          await fixture.collab.draftReview.discardWorkDraft({
            ...target,
            userId: USER_ID as never,
            operationIds: [preview.operations[0].operationId],
            closureClassIds: [preview.operations[0].closureClassId],
            admissionTokens: [preview.operations[0].admissionToken],
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
      expect(
        originals
          .filter((row) => rows.some((original) => original.id === row.id))
          .map((row) => ({ id: row.id, status: row.status })),
      ).toEqual(rows.map((row) => ({ id: row.id, status: "discarded" })));
      expect(
        await fixture.collab.draftReview.list({ projectId: PROJECT_ID as never, workId: WORK_ID }),
      ).toEqual([]);
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
      expect(preview.operations.map((op) => op.partKey).sort()).toEqual(
        edits.map((edit) => `${edit.id}:0`).sort(),
      );
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
          closureClassIds: [next.operations[0].closureClassId],
          admissionTokens: [next.operations[0].admissionToken],
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
