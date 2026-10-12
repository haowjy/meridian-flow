// Durable capture, selective placement and compaction through the existing review application API.
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { testFileGrant } from "../../../test-support/file-grants.js";
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
    "insert",
    "chain",
    "trail",
    "pending",
    "first-write",
    "first-write empty",
    "cold",
    "reply discard",
    "reply empty discard",
    "reply empty apply",
    "reply whole discard",
    "drop at save",
    "drop before next tool",
    "drop all before next tool",
  ] as const)("current generation witness: %s", async (witness) => {
    let harness = createHarness(db);
    const empty = [
      "pending",
      "first-write empty",
      "reply empty discard",
      "reply empty apply",
      "reply whole discard",
    ].includes(witness);
    try {
      let { fixture, branchId, rows } = await stageDraft(
        db,
        harness,
        "red\n\nblue\n\ngreen",
        "replace",
        empty
          ? [["red", "gold"]]
          : [
              ["red", "gold"],
              ["blue", "azure"],
            ],
      );
      const target = {
        projectId: PROJECT_ID as never,
        workId: WORK_ID,
        documentId: ALPHA_ID,
        draftId: branchId,
      };
      const review = async (after: string, apply = false) => {
        const preview = await fixture.collab.draftReview.preview(target);
        if (preview.status !== "active") throw new Error("Missing active preview");
        const op = preview.operations.find((op) => op.afterExcerpt === after);
        if (!op) throw new Error(`Missing ${after}: ${JSON.stringify(preview.operations)}`);
        const command = {
          ...target,
          userId: USER_ID as never,
          operationIds: [op.operationId],
          liveRevisionToken: preview.liveRevisionToken,
          draftRevisionToken: preview.draftRevisionToken,
        };
        expect(
          await (apply
            ? fixture.collab.draftReview.applyWorkDraftChanges(command)
            : fixture.collab.draftReview.discardWorkDraft(command)),
        ).toMatchObject({ status: apply ? "applied" : "discarded" });
      };
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
      const context = {
        sessionId: THREAD_ID,
        threadId: THREAD_ID,
        turnId: TURN_ID,
        responseId,
        grant: testFileGrant({ kind: "draft", workId: WORK_ID, workSlug: "atomicity-work" }),
      };
      let tool = 0;
      const write = (find: string, content: string, command: "replace" | "insert" = "replace") =>
        fixture.collab.agentEdit().write(
          {
            command,
            file: "alpha.md",
            documentId: ALPHA_ID,
            find,
            content,
            tool_use_id: `later-${++tool}`,
          },
          context,
        );
      if (witness.startsWith("first-write")) {
        let entered!: () => void, release!: () => void;
        const waiting = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        const prepare = fixture.links.prepare.bind(fixture.links);
        let paused = false;
        fixture.links.prepare = async (request) => {
          if (
            !paused &&
            request.docs?.length &&
            request.holders.some(
              (holder) => holder.view.kind === "draft" && holder.view.responseId === responseId,
            )
          ) {
            paused = true;
            entered();
            await gate;
          }
          return prepare(request);
        };
        const writing = write("green", "lime");
        await waiting;
        try {
          await review("gold");
        } finally {
          release();
        }
        expect(await writing).toMatchObject({ status: "success", phase: "staged" });
        expect(await harness.commit(responseId)).toMatchObject({
          status: "committed",
          documents: [{ updateCount: 1 }],
        });
        expect(await fixture.draftMarkdown(branchId)).toBe(
          empty ? "red\n\nblue\n\nlime\n" : "red\n\nazure\n\nlime\n",
        );
        return;
      }
      if (witness.startsWith("reply") || witness.startsWith("drop")) {
        const dropped = [];
        const droppedAll = witness === "drop all before next tool";
        if (witness.startsWith("drop")) {
          dropped.push(await write("gold", "gild"));
          dropped.push(await write("gild", "bronze"));
        }
        if (!droppedAll)
          expect(await write("green", "lime")).toMatchObject({
            status: "success",
            phase: "staged",
          });
        if (witness === "reply whole discard") {
          expect(
            await fixture.collab.draftReview.discardWorkDraft({
              ...target,
              userId: USER_ID as never,
            }),
          ).toMatchObject({ status: "discarded" });
          await expect(harness.commit(responseId)).rejects.toThrow("already rolled back");
          expect(await fixture.draftMarkdown(branchId)).toBe("red\n\nblue\n\ngreen\n");
          return;
        }
        await review("gold", witness === "reply empty apply");
        if (witness === "drop before next tool" || droppedAll) {
          const missing = await write("gold", "missing");
          expect(missing.status).toBe("not_found");
          expect(
            missing.result.message?.endsWith(
              dropped
                .map(
                  (entry) =>
                    `${entry.writeId} was discarded with the text it edited; re-read and retry`,
                )
                .join("\n"),
            ),
          ).toBe(true);
          // The resolver sees the re-fork, not the discarded helper contents.
          if (!droppedAll)
            expect(await write("red", "silver")).toMatchObject({
              status: "success",
              phase: "staged",
            });
        }
        const saved = await harness.commit(responseId);
        expect(saved).toMatchObject({
          status: "committed",
          documents: [
            { updateCount: droppedAll ? 0 : witness === "drop before next tool" ? 2 : 1 },
          ],
        });
        if (dropped.length) {
          const receipts = saved.documents.flatMap((doc) => doc.receipts);
          expect(
            receipts
              .filter((receipt) => receipt.result.status !== "success")
              .map((receipt) => ({
                id: receipt.settlementId,
                message: receipt.result.message,
              })),
          ).toEqual(
            dropped.map((entry) => ({
              id: entry.settlementId,
              message:
                "Write did not land: the user discarded the text it edited. Re-read and retry.",
            })),
          );
        }
        expect(await fixture.draftMarkdown(branchId)).toBe(
          (witness === "drop before next tool"
            ? "silver"
            : witness === "reply empty apply"
              ? "gold"
              : "red") +
            (droppedAll
              ? "\n\nazure\n\ngreen\n"
              : empty
                ? "\n\nblue\n\nlime\n"
                : "\n\nazure\n\nlime\n"),
        );
        expect(await harness.branchGeneration(branchId)).toBe(2);
        return;
      }
      if (witness === "pending") {
        expect(await write("green", "lime")).toMatchObject({ status: "success", phase: "staged" });
        await review("gold");
        expect(
          await fixture.collab.draftReview.list({
            projectId: PROJECT_ID as never,
            workId: WORK_ID,
          }),
        ).toEqual([]);
        const { createDrizzleWorkDraftPendingStore } = await import("./drizzle-branch-push.js");
        expect(
          await createDrizzleWorkDraftPendingStore(db).countPendingByWorkIds([WORK_ID]),
        ).toEqual(new Map());
        expect(await harness.branchGeneration(branchId)).toBe(2);
        return;
      }
      await review("gold");
      expect(await fixture.draftMarkdown(branchId)).toBe("red\n\nazure\n\ngreen\n");
      if (witness === "cold") {
        harness.cancelScheduledPulls();
        harness.destroyWarmState();
        harness = createHarness(db);
        fixture = harness.crossWorkProbeFixture();
        await harness.recoverPendingLiveSettlements();
      }
      if (witness === "insert") {
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
      } else if (witness === "chain") {
        for (const [index, text] of ["silver", "copper"].entries()) {
          // Save each distinct reply, as in the original production witness.
          const id = index === 0 ? responseId : randomUUID();
          if (index)
            await db.insert(schema.modelResponses).values({
              id: id as never,
              turnId: TURN_ID,
              sequence: 3,
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
                find: "red",
                content: text,
                tool_use_id: text,
              },
              { ...context, responseId: id },
            ),
          ).toMatchObject({ status: "success" });
          await harness.commit(id);
          await review(text);
          expect(await fixture.draftMarkdown(branchId)).toBe("red\n\nazure\n\ngreen\n");
        }
      } else {
        expect(await write("red", "silver")).toMatchObject({ status: "success" });
        await harness.commit(responseId);
        await review("silver", true);
        expect(await harness.liveMarkdown(ALPHA_ID)).toBe("silver\n\nblue\n\ngreen\n");
        if (witness === "trail" || witness === "cold") {
          const shells = await db.select().from(schema.changeTrailShells);
          expect(shells.map((shell) => ({ owner: shell.ownerKind, turnId: shell.turnId }))).toEqual(
            [{ owner: "turn", turnId: TURN_ID }],
          );
        }
      }
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
    const harness = createHarness(db),
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
