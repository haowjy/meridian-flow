/** PostgreSQL proof for dependency-closed partial Apply settlement. */
import { toDocHandle } from "@meridian/agent-edit/integration";
import { createCollabYDoc } from "@meridian/prosemirror-schema";
import { asc, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  ALPHA_ID,
  createHarness,
  db,
  schema,
  setupSettlementFixture,
  USER_ID,
} from "./test-support/branch-push-settlement-fixture.js";
import { THREAD_ID, TURN_ID, WORK_ID } from "./test-support/change-trail-postgres-harness.js";

setupSettlementFixture();

describe("partial Apply POC (postgres)", () => {
  it("publishes one closed group, removes it from review, then whole Apply publishes the rest once", async () => {
    const harness = createHarness();
    await harness.seedWriterDocument("Alpha base.\n\nBeta base.", "partial-apply-poc");
    const fixture = harness.crossWorkProbeFixture();
    const branch = await fixture.branchStore.resolveWorkDraftBranchForThread(ALPHA_ID, THREAD_ID);
    branch.doc.destroy();

    const firstId = await stageText(fixture, branch.branchId, 0, " Agent-one", "agent");
    const secondId = await stageText(fixture, branch.branchId, 1, " Writer-two", "writer");

    await expect(
      fixture.realBranchPush.pushSelectedToLive({
        branchId: branch.branchId,
        journalIds: [firstId],
        pushedByUserId: USER_ID,
      }),
    ).resolves.toMatchObject({ status: "pushed" });

    const afterPartial = await harness.liveMarkdown(ALPHA_ID);
    expect(afterPartial).toBe("Alpha base. Agent-one\n\nBeta base.\n");

    const preview = await fixture.collab.draftReview.preview({
      workId: WORK_ID,
      documentId: ALPHA_ID,
      draftId: branch.branchId,
    });
    expect(preview.status).toBe("active");
    if (preview.status !== "active") throw new Error("draft unexpectedly settled");
    expect(preview.operations.flatMap((operation) => operation.sourceUpdateIds)).toEqual([
      secondId,
    ]);

    await expect(
      fixture.collab.draftReview.applyWorkDraft({
        workId: WORK_ID,
        documentId: ALPHA_ID,
        draftId: branch.branchId,
        userId: USER_ID,
      }),
    ).resolves.toMatchObject({ status: "applied" });

    const live = await harness.liveMarkdown(ALPHA_ID);
    expect(occurrences(live, "Agent-one")).toBe(1);
    expect(occurrences(live, "Writer-two")).toBe(1);
    expect(await journalStatuses(branch.branchId)).toEqual([
      { id: firstId, status: "pushed" },
      { id: secondId, status: "pushed" },
    ]);
    const attributed = await db
      .select({
        originType: schema.documentYjsUpdates.originType,
        actorUserId: schema.documentYjsUpdates.actorUserId,
        actorTurnId: schema.documentYjsUpdates.actorTurnId,
      })
      .from(schema.documentYjsUpdates)
      .where(eq(schema.documentYjsUpdates.documentId, ALPHA_ID));
    expect(attributed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ originType: "agent", actorTurnId: TURN_ID }),
        expect.objectContaining({ originType: "human", actorUserId: USER_ID }),
      ]),
    );
    harness.destroyWarmState();
  });

  it("selective and whole-draft Discard never revert a partially applied group on live", async () => {
    const harness = createHarness();
    await harness.seedWriterDocument("Alpha base.\n\nBeta base.", "partial-discard-poc");
    const fixture = harness.crossWorkProbeFixture();
    const branch = await fixture.branchStore.resolveWorkDraftBranchForThread(ALPHA_ID, THREAD_ID);
    branch.doc.destroy();
    const appliedId = await stageText(fixture, branch.branchId, 0, " Applied", "agent");
    const discardedId = await stageText(fixture, branch.branchId, 1, " Discard-me", "agent");

    await fixture.realBranchPush.pushSelectedToLive({
      branchId: branch.branchId,
      journalIds: [appliedId],
      pushedByUserId: USER_ID,
    });
    const preview = await fixture.collab.draftReview.preview({
      workId: WORK_ID,
      documentId: ALPHA_ID,
      draftId: branch.branchId,
    });
    if (preview.status !== "active") throw new Error("draft unexpectedly settled");
    const remaining = preview.operations.find((operation) =>
      operation.sourceUpdateIds.includes(discardedId as never),
    );
    if (!remaining) throw new Error("remaining review operation is unavailable");
    await fixture.collab.draftReview.discardWorkDraft({
      workId: WORK_ID,
      documentId: ALPHA_ID,
      draftId: branch.branchId,
      userId: USER_ID,
      operationIds: [remaining.operationId],
    });
    let live = await harness.liveMarkdown(ALPHA_ID);
    expect(live).toContain("Applied");
    expect(live).not.toContain("Discard-me");

    await stageText(fixture, branch.branchId, 1, " Whole-discard", "agent");
    await fixture.collab.draftReview.discardWorkDraft({
      workId: WORK_ID,
      documentId: ALPHA_ID,
      draftId: branch.branchId,
      userId: USER_ID,
      threadId: THREAD_ID,
    });
    live = await harness.liveMarkdown(ALPHA_ID);
    expect(live).toContain("Applied");
    expect(live).not.toContain("Discard-me");
    expect(live).not.toContain("Whole-discard");
    harness.destroyWarmState();
  });
});

type Fixture = ReturnType<ReturnType<typeof createHarness>["crossWorkProbeFixture"]>;

async function stageText(
  fixture: Fixture,
  branchId: string,
  blockIndex: number,
  suffix: string,
  source: "agent" | "writer",
): Promise<number> {
  const staged = await fixture.branchCoordinator.readBranch(branchId, async (doc, snapshot) => {
    const clone = createCollabYDoc({ gc: false });
    Y.applyUpdate(clone, Y.encodeStateAsUpdate(doc));
    return { clone, generation: snapshot.generation };
  });
  try {
    const block = fixture.model.getBlocks(toDocHandle(staged.clone))[blockIndex];
    if (!block) throw new Error(`missing block ${blockIndex}`);
    const end = fixture.model.getText(block).length;
    fixture.model.applyTextEdit(toDocHandle(staged.clone), block, { from: end, to: end }, suffix);
    await fixture.branchCoordinator.commitSyncFromDoc({
      branchId,
      sourceDoc: staged.clone,
      expectedGeneration: staged.generation,
      source,
      actorUserId: source === "writer" ? USER_ID : null,
      threadId: THREAD_ID,
      turnId: source === "agent" ? TURN_ID : null,
      wId: null,
      updateMeta: null,
    });
  } finally {
    staged.clone.destroy();
  }
  const rows = await db
    .select({ id: schema.branchWriteJournal.id })
    .from(schema.branchWriteJournal)
    .where(eq(schema.branchWriteJournal.branchId, branchId))
    .orderBy(asc(schema.branchWriteJournal.id));
  const id = rows.at(-1)?.id;
  if (!id) throw new Error("staged journal row is unavailable");
  return id;
}

async function journalStatuses(branchId: string) {
  return db
    .select({ id: schema.branchWriteJournal.id, status: schema.branchWriteJournal.status })
    .from(schema.branchWriteJournal)
    .where(eq(schema.branchWriteJournal.branchId, branchId))
    .orderBy(asc(schema.branchWriteJournal.id));
}

function occurrences(value: string, fragment: string): number {
  return value.split(fragment).length - 1;
}
