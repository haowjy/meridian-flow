/** Real admission, cold review and Apply prove restored text stays on the originating AI receipt. */
import { toDocHandle } from "@meridian/agent-edit/integration";
import { captureUndoRestorationClaims, createCollabYDoc } from "@meridian/prosemirror-schema";
import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
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

it("Undo survives reload and retry, and Apply credits only the AI turn", async () => {
  const warm = createHarness();
  let cold: ReturnType<typeof createHarness> | undefined;
  const browser = createCollabYDoc({ gc: false });
  try {
    await warm.seedWriterDocument("The courtyard waits.", "undo-authorship");
    const fixture = warm.crossWorkProbeFixture();
    const branch = await fixture.branchStore.resolveWorkDraftBranchForThread(ALPHA_ID, THREAD_ID);
    Y.applyUpdate(browser, Y.encodeStateAsUpdate(branch.doc));
    branch.doc.destroy();
    const block = fixture.model.getBlocks(toDocHandle(browser))[0];
    const vector = Y.encodeStateVector(browser);
    fixture.model.applyTextEdit(toDocHandle(browser), block, { from: 4, to: 4 }, "serpent ");
    await fixture.branchCoordinator.appendJournaledUpdate({
      branchId: branch.branchId,
      generation: branch.generation,
      source: "agent",
      updateData: Y.encodeStateAsUpdate(browser, vector),
      threadId: THREAD_ID,
      turnId: TURN_ID,
    });
    browser.clientID = 202020;
    const text = (browser.getXmlFragment("prosemirror").get(0) as Y.XmlElement).get(0) as Y.XmlText;
    captureUndoRestorationClaims(browser);
    const undo = new Y.UndoManager(text);
    const updates: Uint8Array[] = [];
    browser.on("update", (update) => updates.push(update));
    text.delete(4, 7);
    for (const updateData of updates.splice(0)) {
      await fixture.branchCoordinator.commitWriterUpdate({
        branchId: branch.branchId,
        expectedGeneration: branch.generation,
        updateData,
        actorUserId: USER_ID,
        roomDocument: browser,
      });
    }
    undo.undo();
    for (const updateData of updates.splice(0)) {
      await fixture.branchCoordinator.commitWriterUpdate({
        branchId: branch.branchId,
        expectedGeneration: branch.generation,
        updateData,
        actorUserId: USER_ID,
        roomDocument: browser,
      });
    }
    const beforeRetry = await db
      .select()
      .from(schema.branchWriteJournal)
      .where(eq(schema.branchWriteJournal.branchId, branch.branchId));
    expect(
      beforeRetry.some((row) => JSON.stringify(row.updateMeta).includes("restorationAliases")),
    ).toBe(true);
    await expect(
      fixture.branchCoordinator.commitWriterUpdate({
        branchId: branch.branchId,
        expectedGeneration: branch.generation,
        updateData: Y.encodeStateAsUpdate(browser),
        actorUserId: USER_ID,
        roomDocument: browser,
      }),
    ).resolves.toEqual({ admitted: false });
    expect(
      await db
        .select()
        .from(schema.branchWriteJournal)
        .where(eq(schema.branchWriteJournal.branchId, branch.branchId)),
    ).toHaveLength(beforeRetry.length);
    warm.destroyWarmState();
    cold = createHarness();
    const reloaded = cold.crossWorkProbeFixture();
    const command = {
      workId: WORK_ID,
      documentId: ALPHA_ID,
      draftId: branch.branchId,
      userId: USER_ID,
    };
    const preview = await reloaded.collab.draftReview.preview(command);
    if (preview.status !== "active") throw new Error("missing cold preview");
    expect(preview.operations).toHaveLength(1);
    expect(preview.operations[0]).toMatchObject({ kind: "agent", actorTurnId: TURN_ID });
    expect(preview.markdown).toContain("serpent");
    const applied = await reloaded.collab.draftReview.applyWorkDraftChanges({
      ...command,
      operationIds: preview.operations.map((operation) => operation.operationId),
      liveRevisionToken: preview.liveRevisionToken,
      draftRevisionToken: preview.draftRevisionToken,
    });
    expect(applied).toMatchObject({ status: "applied", draftClosed: true });
    expect(await cold.liveMarkdown(ALPHA_ID)).toContain("serpent");
    const shells = await db.select().from(schema.changeTrailShells);
    expect(shells).toHaveLength(1);
    expect(shells[0]).toMatchObject({ ownerKind: "turn", turnId: TURN_ID });
    const details = await db.select().from(schema.changeTrailDocumentDetails);
    expect(JSON.stringify(details)).toContain("serpent");
    undo.destroy();
  } finally {
    browser.destroy();
    warm.destroyWarmState();
    cold?.destroyWarmState();
  }
});
