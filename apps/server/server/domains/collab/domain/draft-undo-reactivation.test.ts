/** Integration coverage for draft undo, reactivation, partial accept, and causal closure. */

import { createAgentEditCore, toDocHandle } from "@meridian/agent-edit";
import { createCollabYDoc } from "@meridian/prosemirror-schema";
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  appendMarkdownBlockInDoc,
  createScenario,
  DOC_ID,
  draftRuntimeFromLive,
  liveMarkdown,
  markdownFromDoc,
  normalizeMarkdown,
  operationContaining,
  operationMaybeContaining,
  replaceLiveMarkdown,
  reviewChangeCount,
  THREAD_ID,
  TURN_A,
  TURN_B,
  USER_ID,
  updateFromMarkdownOverLive,
  updateFromText,
  WORK_ID,
} from "./draft-lifecycle-test-helpers.js";
import { createDraftService } from "./drafts.js";

async function createScenarioWithRealAcceptUndo() {
  let scenario: Awaited<ReturnType<typeof createScenario>>;
  scenario = await createScenario({
    reverseAcceptedDraft: async ({ writeId, userId }) => {
      const liveCore = createAgentEditCore({
        journal: scenario.journal,
        coordinator: scenario.coordinator,
        lifecycle: { ensureDocument: async () => undefined },
        codec: scenario.codec,
        model: scenario.model,
        defaultThreadId: THREAD_ID,
        createRuntimeDoc: () => createCollabYDoc({ gc: false }),
      });
      const result = await liveCore.reverse({
        docId: DOC_ID,
        threadId: THREAD_ID,
        direction: "undo",
        selection: { kind: "single", to: writeId },
        actor: { type: "user", userId },
        requireEffect: true,
      });
      return result.status !== "document_not_found" &&
        "reversalEffect" in result &&
        result.reversalEffect === "changed"
        ? "reversed"
        : "not_reversed";
    },
  });
  return scenario;
}

async function appendLiveMarkdownBlock(
  scenario: Awaited<ReturnType<typeof createScenario>>,
  markdown: string,
): Promise<void> {
  await scenario.coordinator.withDocument(DOC_ID, async (doc) => {
    const before = Y.encodeStateVector(doc);
    const blocks = scenario.model.getBlocks(toDocHandle(doc));
    scenario.model.insertBlocks(
      toDocHandle(doc),
      blocks.at(-1) ?? null,
      scenario.codec.parse(markdown),
    );
    await scenario.journal.append(DOC_ID, Y.encodeStateAsUpdate(doc, before), {
      origin: "system",
      seq: 0,
    });
  });
}

describe("draft undo and reactivation", () => {
  it("preserves original rows and attribution after full accept undo", async () => {
    const scenario = await createScenario({
      reverseAcceptedDraft: async ({ writeId }) => {
        expect(writeId).toMatch(/^draft-accept:.+:\d+$/);
        await replaceLiveMarkdown(scenario, "Seed.");
        return "reversed";
      },
    });
    await replaceLiveMarkdown(scenario, "Seed.");
    const baseLiveUpdateSeq = await scenario.journal.latestUpdateSeq(DOC_ID);
    const draft = await scenario.store.createActiveDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      lastActorTurnId: TURN_A,
      baseLiveUpdateSeq,
    });
    const draftRuntime = await draftRuntimeFromLive(scenario);
    await scenario.store.appendUpdate({
      draftId: draft.id,
      updateData: appendMarkdownBlockInDoc(draftRuntime, scenario, "First proposal."),
      actorTurnId: TURN_A,
    });
    await scenario.store.appendUpdate({
      draftId: draft.id,
      updateData: appendMarkdownBlockInDoc(draftRuntime, scenario, "Second proposal."),
      actorTurnId: TURN_B,
    });
    draftRuntime.destroy();
    const originalRows = await scenario.store.listUpdates(draft.id);
    const originalRowBytes = originalRows.map((row) => Array.from(row.updateData));
    const originalActorTurns = originalRows.map((row) => row.actorTurnId);

    const beforePreview = await scenario.preview.previewDraft({
      documentId: DOC_ID,
      draftId: draft.id,
    });
    expect(normalizeMarkdown(beforePreview.markdown)).toBe(
      "Seed.\n\nFirst proposal.\n\nSecond proposal.",
    );
    expect(operationContaining(beforePreview, "First proposal.")).toMatchObject({
      actorTurnId: TURN_A,
      kind: "agent",
    });
    expect(operationContaining(beforePreview, "Second proposal.")).toMatchObject({
      actorTurnId: TURN_B,
      kind: "agent",
    });

    const accept = await scenario.service.acceptDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      draftId: draft.id,
      userId: USER_ID,
      draftRevisionToken: beforePreview.draftRevisionToken,
    });
    expect(accept).toMatchObject({ status: "applied", draftId: draft.id });
    expect(normalizeMarkdown(await liveMarkdown(scenario))).toBe(
      "Seed.\n\nFirst proposal.\n\nSecond proposal.",
    );

    await expect(
      scenario.service.undoAcceptDraft({
        documentId: DOC_ID,
        threadId: THREAD_ID,
        draftId: draft.id,
        userId: USER_ID,
      }),
    ).resolves.toEqual({ status: "reactivated", draftId: draft.id });
    expect(normalizeMarkdown(await liveMarkdown(scenario))).toBe("Seed.");

    const reactivatedDraft = await scenario.store.getDraft(draft.id);
    expect(reactivatedDraft).toMatchObject({
      status: "active",
      baseLiveUpdateSeq,
      acceptGeneration: 1,
      appliedAt: null,
      appliedByUserId: null,
      appliedUpdateSeq: null,
      undoneAt: expect.any(Date),
    });
    const rowsAfterUndo = await scenario.store.listUpdates(draft.id);
    expect(rowsAfterUndo).toHaveLength(originalRows.length);
    expect(rowsAfterUndo.map((row) => Array.from(row.updateData))).toEqual(originalRowBytes);
    expect(rowsAfterUndo.map((row) => row.actorTurnId)).toEqual(originalActorTurns);

    const afterPreview = await scenario.preview.previewDraft({
      documentId: DOC_ID,
      draftId: draft.id,
    });
    expect(normalizeMarkdown(afterPreview.live)).toBe("Seed.");
    expect(normalizeMarkdown(afterPreview.markdown)).toBe(
      "Seed.\n\nFirst proposal.\n\nSecond proposal.",
    );
    expect(afterPreview.operations).toHaveLength(2);
    expect(operationContaining(afterPreview, "First proposal.")).toMatchObject({
      actorTurnId: TURN_A,
      kind: "agent",
    });
    expect(operationContaining(afterPreview, "Second proposal.")).toMatchObject({
      actorTurnId: TURN_B,
      kind: "agent",
    });
    expect(reviewChangeCount(afterPreview)).toBeGreaterThan(0);

    const loadedDraftState = await scenario.hocuspocus.loadHocuspocusDraft(draft.id);
    const loadedDraftDoc = new Y.Doc({ gc: false });
    try {
      expect(loadedDraftState).toBeInstanceOf(Uint8Array);
      if (!loadedDraftState) throw new Error("expected reactivated draft state");
      Y.applyUpdate(loadedDraftDoc, loadedDraftState);
      expect(normalizeMarkdown(markdownFromDoc(scenario, loadedDraftDoc))).toBe(
        normalizeMarkdown(afterPreview.markdown),
      );
    } finally {
      loadedDraftDoc.destroy();
    }

    expect(scenario.journal.updateRecords(DOC_ID)).toHaveLength(3);
  });

  it("acceptance: full accept, undo, and per-op re-accept preserves rows and restores live content", async () => {
    const scenario = await createScenarioWithRealAcceptUndo();
    await replaceLiveMarkdown(scenario, "Seed.");
    const baseLiveUpdateSeq = await scenario.journal.latestUpdateSeq(DOC_ID);
    const draft = await scenario.store.createActiveDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      lastActorTurnId: TURN_A,
      baseLiveUpdateSeq,
    });
    const draftRuntime = await draftRuntimeFromLive(scenario);
    for (const [markdown, turnId] of [
      ["First proposal.", TURN_A],
      ["Second proposal.", TURN_B],
    ] as const) {
      await scenario.store.appendUpdate({
        draftId: draft.id,
        updateData: appendMarkdownBlockInDoc(draftRuntime, scenario, markdown),
        actorTurnId: turnId,
      });
    }
    draftRuntime.destroy();
    const originalRows = await scenario.store.listUpdates(draft.id);
    const originalRowBytes = originalRows.map((row) => Array.from(row.updateData));
    const originalActorTurns = originalRows.map((row) => row.actorTurnId);

    const initialPreview = await scenario.preview.previewDraft({
      documentId: DOC_ID,
      draftId: draft.id,
    });
    const fullAccept = await scenario.service.acceptDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      draftId: draft.id,
      userId: USER_ID,
      draftRevisionToken: initialPreview.draftRevisionToken,
    });
    expect(fullAccept).toMatchObject({ status: "applied" });
    const originalAcceptedMarkdown = normalizeMarkdown(await liveMarkdown(scenario));

    await expect(
      scenario.service.undoAcceptDraft({
        documentId: DOC_ID,
        threadId: THREAD_ID,
        draftId: draft.id,
        userId: USER_ID,
      }),
    ).resolves.toEqual({ status: "reactivated", draftId: draft.id });

    const reactivatedDraft = await scenario.store.getDraft(draft.id);
    expect(reactivatedDraft).toMatchObject({
      status: "active",
      baseLiveUpdateSeq,
      acceptGeneration: 1,
      appliedAt: null,
      appliedByUserId: null,
      appliedUpdateSeq: null,
      undoneAt: expect.any(Date),
    });
    const rowsAfterUndo = await scenario.store.listUpdates(draft.id);
    expect(rowsAfterUndo).toHaveLength(originalRows.length);
    expect(rowsAfterUndo.map((row) => Array.from(row.updateData))).toEqual(originalRowBytes);
    expect(rowsAfterUndo.map((row) => row.actorTurnId)).toEqual(originalActorTurns);

    const reactivatedPreview = await scenario.preview.previewDraft({
      documentId: DOC_ID,
      draftId: draft.id,
    });
    expect(reactivatedPreview.operations).toHaveLength(2);
    expect(operationContaining(reactivatedPreview, "First proposal.")).toMatchObject({
      actorTurnId: TURN_A,
      kind: "agent",
    });
    expect(operationContaining(reactivatedPreview, "Second proposal.")).toMatchObject({
      actorTurnId: TURN_B,
      kind: "agent",
    });
    const first = operationContaining(reactivatedPreview, "First proposal.");
    const firstAccept = await scenario.service.acceptDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      draftId: draft.id,
      userId: USER_ID,
      operationIds: [first.operationId],
      draftRevisionToken: reactivatedPreview.draftRevisionToken,
      confirmedClosureOperationIds: [first.operationId],
      confirmedLiveRevisionToken: reactivatedPreview.liveRevisionToken,
    });
    expect(firstAccept).toMatchObject({ status: "partial_applied" });
    expect(normalizeMarkdown(await liveMarkdown(scenario))).toContain("First proposal.");

    const afterFirst = await scenario.preview.previewDraft({
      documentId: DOC_ID,
      draftId: draft.id,
    });
    const second = operationContaining(afterFirst, "Second proposal.");
    const secondUnconfirmed = await scenario.service.acceptDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      draftId: draft.id,
      userId: USER_ID,
      operationIds: [second.operationId],
      draftRevisionToken: afterFirst.draftRevisionToken,
      confirmOverlap: true,
      confirmedLiveRevisionToken: afterFirst.liveRevisionToken,
    });
    const secondAccept =
      secondUnconfirmed.status === "closure_confirmation_required"
        ? await scenario.service.acceptDraft({
            documentId: DOC_ID,
            threadId: THREAD_ID,
            draftId: draft.id,
            userId: USER_ID,
            operationIds: [second.operationId],
            draftRevisionToken: afterFirst.draftRevisionToken,
            confirmOverlap: true,
            confirmedClosureOperationIds: secondUnconfirmed.closureOperationIds,
            confirmedLiveRevisionToken: secondUnconfirmed.liveRevisionToken,
          })
        : secondUnconfirmed;
    expect(secondAccept).toMatchObject({ status: "partial_applied" });
    expect(normalizeMarkdown(await liveMarkdown(scenario))).toBe(originalAcceptedMarkdown);
    expect((await liveMarkdown(scenario)).match(/First proposal\./g)).toHaveLength(1);
    expect((await liveMarkdown(scenario)).match(/Second proposal\./g)).toHaveLength(1);
  });

  it("acceptance: partial accept, writer edit, partial accept, undo, and fresh-session apply-all", async () => {
    const scenario = await createScenarioWithRealAcceptUndo();
    await replaceLiveMarkdown(scenario, "Seed.");
    const baseLiveUpdateSeq = await scenario.journal.latestUpdateSeq(DOC_ID);
    const draft = await scenario.store.createActiveDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      lastActorTurnId: TURN_A,
      baseLiveUpdateSeq,
    });
    const draftRuntime = await draftRuntimeFromLive(scenario);
    await scenario.store.appendUpdate({
      draftId: draft.id,
      updateData: appendMarkdownBlockInDoc(draftRuntime, scenario, "Silver accepted."),
      actorTurnId: TURN_A,
    });
    await scenario.store.appendUpdate({
      draftId: draft.id,
      updateData: appendMarkdownBlockInDoc(draftRuntime, scenario, "Gold accepted."),
      actorTurnId: TURN_B,
    });

    const initialPreview = await scenario.preview.previewDraft({
      documentId: DOC_ID,
      draftId: draft.id,
    });
    const silver = operationContaining(initialPreview, "Silver accepted.");
    const silverAccept = await scenario.service.acceptDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      draftId: draft.id,
      userId: USER_ID,
      operationIds: [silver.operationId],
      draftRevisionToken: initialPreview.draftRevisionToken,
      confirmedClosureOperationIds: [silver.operationId],
      confirmedLiveRevisionToken: initialPreview.liveRevisionToken,
    });
    expect(silverAccept).toMatchObject({ status: "partial_applied" });
    if (silverAccept.status !== "partial_applied") throw new Error("expected silver accept");

    await scenario.store.appendUpdate({
      draftId: draft.id,
      updateData: appendMarkdownBlockInDoc(draftRuntime, scenario, "Writer bonus."),
      actorUserId: USER_ID,
    });
    draftRuntime.destroy();

    const originalRows = await scenario.store.listUpdates(draft.id);
    const originalRowBytes = originalRows.map((row) => Array.from(row.updateData));

    const afterWriter = await scenario.preview.previewDraft({
      documentId: DOC_ID,
      draftId: draft.id,
    });
    const gold = operationContaining(afterWriter, "Gold accepted.");
    const goldAccept = await scenario.service.acceptDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      draftId: draft.id,
      userId: USER_ID,
      operationIds: [gold.operationId],
      draftRevisionToken: afterWriter.draftRevisionToken,
      confirmedClosureOperationIds: [gold.operationId],
      confirmedLiveRevisionToken: afterWriter.liveRevisionToken,
    });
    expect(goldAccept).toMatchObject({ status: "partial_applied" });
    if (goldAccept.status !== "partial_applied") throw new Error("expected gold accept");

    await scenario.service.undoAcceptDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      draftId: draft.id,
      userId: USER_ID,
      writeId: silverAccept.writeId,
    });
    await scenario.service.undoAcceptDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      draftId: draft.id,
      userId: USER_ID,
      writeId: goldAccept.writeId,
    });

    const freshService = createDraftService({
      draftStore: scenario.store,
      liveJournal: scenario.liveJournal,
      liveUpdateJournal: scenario.journal,
      latestLiveUpdateSeq: (documentId) => scenario.journal.latestUpdateSeq(documentId),
      liveCoordinator: scenario.coordinator,
      model: scenario.model,
      codec: scenario.codec,
      countInFlightDraftSessionsByWork: () => 0,
    });
    const afterUndo = await freshService.previewDraft({ documentId: DOC_ID, draftId: draft.id });
    expect(afterUndo.operations).toHaveLength(3);
    expect(operationContaining(afterUndo, "Silver accepted.")).toMatchObject({
      actorTurnId: TURN_A,
    });
    expect(operationContaining(afterUndo, "Gold accepted.")).toMatchObject({ actorTurnId: TURN_B });
    expect(operationContaining(afterUndo, "Writer bonus.")).toMatchObject({
      operationId: expect.stringContaining("writer:"),
      actorUserId: USER_ID,
      kind: "writer",
    });

    const applyAll = await freshService.acceptDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      draftId: draft.id,
      userId: USER_ID,
      draftRevisionToken: afterUndo.draftRevisionToken,
    });
    expect(applyAll).toMatchObject({ status: "applied" });
    const live = normalizeMarkdown(await liveMarkdown(scenario));
    expect(live).toBe("Seed.\n\nSilver accepted.\n\nGold accepted.\n\nWriter bonus.");
    expect(live.match(/Silver accepted\./g)).toHaveLength(1);
    expect(live.match(/Gold accepted\./g)).toHaveLength(1);
    expect(live.match(/Writer bonus\./g)).toHaveLength(1);
    const rowsAfterApplyAll = await scenario.store.listUpdates(draft.id);
    expect(rowsAfterApplyAll).toHaveLength(3);
    expect(rowsAfterApplyAll.map((row) => Array.from(row.updateData))).toEqual(originalRowBytes);
    expect(rowsAfterApplyAll.map((row) => row.actorTurnId)).toEqual([TURN_A, TURN_B, null]);
    expect(rowsAfterApplyAll.map((row) => row.actorUserId)).toEqual([null, null, USER_ID]);
  });

  it("does not remove live blocks inserted after the draft base when re-accepting", async () => {
    const scenario = await createScenarioWithRealAcceptUndo();
    await replaceLiveMarkdown(scenario, "Seed.");
    const draft = await scenario.store.createActiveDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      lastActorTurnId: TURN_A,
      baseLiveUpdateSeq: await scenario.journal.latestUpdateSeq(DOC_ID),
    });
    const draftRuntime = await draftRuntimeFromLive(scenario);
    await scenario.store.appendUpdate({
      draftId: draft.id,
      updateData: appendMarkdownBlockInDoc(draftRuntime, scenario, "Draft proposal."),
      actorTurnId: TURN_A,
    });
    draftRuntime.destroy();
    const preview = await scenario.preview.previewDraft({ documentId: DOC_ID, draftId: draft.id });
    const op = operationContaining(preview, "Draft proposal.");
    const accept = await scenario.service.acceptDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      draftId: draft.id,
      userId: USER_ID,
      operationIds: [op.operationId],
      draftRevisionToken: preview.draftRevisionToken,
      confirmedClosureOperationIds: [op.operationId],
      confirmedLiveRevisionToken: preview.liveRevisionToken,
    });
    if (accept.status !== "partial_applied") throw new Error("expected partial accept");
    await appendLiveMarkdownBlock(scenario, "Writer live edit.");
    await scenario.service.undoAcceptDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      draftId: draft.id,
      userId: USER_ID,
      writeId: accept.writeId,
    });

    const afterUndo = await scenario.preview.previewDraft({
      documentId: DOC_ID,
      draftId: draft.id,
    });
    const restored = operationContaining(afterUndo, "Draft proposal.");
    await scenario.service.acceptDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      draftId: draft.id,
      userId: USER_ID,
      operationIds: [restored.operationId],
      draftRevisionToken: afterUndo.draftRevisionToken,
      confirmOverlap: true,
      confirmedClosureOperationIds: [restored.operationId],
      confirmedLiveRevisionToken: afterUndo.liveRevisionToken,
    });
    expect(normalizeMarkdown(await liveMarkdown(scenario))).toBe(
      "Seed.\n\nDraft proposal.\n\nWriter live edit.",
    );
  });

  it("accepts a mixed tombstoned plus never-accepted closure through content transfer", async () => {
    const scenario = await createScenarioWithRealAcceptUndo();
    await replaceLiveMarkdown(scenario, "Seed.");
    const draft = await scenario.store.createActiveDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      lastActorTurnId: TURN_A,
      baseLiveUpdateSeq: await scenario.journal.latestUpdateSeq(DOC_ID),
    });
    const draftRuntime = await draftRuntimeFromLive(scenario);
    await scenario.store.appendUpdate({
      draftId: draft.id,
      updateData: appendMarkdownBlockInDoc(draftRuntime, scenario, "Tombstoned predecessor."),
      actorTurnId: TURN_A,
    });
    await scenario.store.appendUpdate({
      draftId: draft.id,
      updateData: appendMarkdownBlockInDoc(draftRuntime, scenario, "Never accepted child."),
      actorTurnId: TURN_B,
    });
    draftRuntime.destroy();
    const preview = await scenario.preview.previewDraft({ documentId: DOC_ID, draftId: draft.id });
    const predecessor = operationContaining(preview, "Tombstoned predecessor.");
    const predecessorAccept = await scenario.service.acceptDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      draftId: draft.id,
      userId: USER_ID,
      operationIds: [predecessor.operationId],
      draftRevisionToken: preview.draftRevisionToken,
      confirmedClosureOperationIds: [predecessor.operationId],
      confirmedLiveRevisionToken: preview.liveRevisionToken,
    });
    if (predecessorAccept.status !== "partial_applied")
      throw new Error("expected predecessor accept");
    await scenario.service.undoAcceptDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      draftId: draft.id,
      userId: USER_ID,
      writeId: predecessorAccept.writeId,
    });

    const afterUndo = await scenario.preview.previewDraft({
      documentId: DOC_ID,
      draftId: draft.id,
    });
    const child = operationContaining(afterUndo, "Never accepted child.");
    const unconfirmed = await scenario.service.acceptDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      draftId: draft.id,
      userId: USER_ID,
      operationIds: [child.operationId],
      draftRevisionToken: afterUndo.draftRevisionToken,
    });
    expect(unconfirmed).toMatchObject({ status: "closure_confirmation_required" });
    if (unconfirmed.status !== "closure_confirmation_required") throw new Error("expected closure");
    const accepted = await scenario.service.acceptDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      draftId: draft.id,
      userId: USER_ID,
      operationIds: [child.operationId],
      draftRevisionToken: afterUndo.draftRevisionToken,
      confirmedClosureOperationIds: unconfirmed.closureOperationIds,
      confirmedLiveRevisionToken: unconfirmed.liveRevisionToken,
    });
    expect(accepted).toMatchObject({ status: "partial_applied" });
    const live = normalizeMarkdown(await liveMarkdown(scenario));
    expect(live).toBe("Seed.\n\nTombstoned predecessor.\n\nNever accepted child.");
    expect(live.match(/Tombstoned predecessor\./g)).toHaveLength(1);
    expect(live.match(/Never accepted child\./g)).toHaveLength(1);
  });

  it("preserves exact intra-paragraph text edits through undo and content-transfer re-accept", async () => {
    const scenario = await createScenarioWithRealAcceptUndo();
    await replaceLiveMarkdown(scenario, "The jade sword was dull.");
    const draft = await scenario.store.createActiveDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      lastActorTurnId: TURN_A,
      baseLiveUpdateSeq: await scenario.journal.latestUpdateSeq(DOC_ID),
    });
    const draftRuntime = await draftRuntimeFromLive(scenario);
    const before = Y.encodeStateVector(draftRuntime);
    const [block] = scenario.model.getBlocks(toDocHandle(draftRuntime));
    scenario.model.applyTextEdit(toDocHandle(draftRuntime), block, { from: 19, to: 23 }, "bright");
    await scenario.store.appendUpdate({
      draftId: draft.id,
      updateData: Y.encodeStateAsUpdate(draftRuntime, before),
      actorTurnId: TURN_A,
    });
    draftRuntime.destroy();

    const preview = await scenario.preview.previewDraft({ documentId: DOC_ID, draftId: draft.id });
    const accept = await scenario.service.acceptDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      draftId: draft.id,
      userId: USER_ID,
      draftRevisionToken: preview.draftRevisionToken,
    });
    expect(accept).toMatchObject({ status: "applied" });
    await scenario.service.undoAcceptDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      draftId: draft.id,
      userId: USER_ID,
    });
    const afterUndo = await scenario.preview.previewDraft({
      documentId: DOC_ID,
      draftId: draft.id,
    });
    const edit = operationContaining(afterUndo, "bright");
    const reaccept = await scenario.service.acceptDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      draftId: draft.id,
      userId: USER_ID,
      operationIds: [edit.operationId],
      draftRevisionToken: afterUndo.draftRevisionToken,
      confirmedClosureOperationIds: [edit.operationId],
      confirmedLiveRevisionToken: afterUndo.liveRevisionToken,
    });
    expect(reaccept).toMatchObject({ status: "partial_applied" });
    expect(normalizeMarkdown(await liveMarkdown(scenario))).toBe("The jade sword was bright.");
  });

  it("preserves partial-accept rows so undone and previously accepted ops remain reviewable", async () => {
    let liveAfterUndo = "";
    const refreshProjection = vi.fn(async () => undefined);
    const scenario = await createScenario({
      refreshAcceptedProjection: refreshProjection,
      reverseAcceptedDraft: async () => {
        await replaceLiveMarkdown(scenario, liveAfterUndo);
        return "reversed";
      },
    });
    await replaceLiveMarkdown(scenario, "Seed.");
    const baseLiveUpdateSeq = await scenario.journal.latestUpdateSeq(DOC_ID);
    const draft = await scenario.store.createActiveDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      lastActorTurnId: TURN_A,
      baseLiveUpdateSeq,
    });
    const draftRuntime = await draftRuntimeFromLive(scenario);
    for (const [markdown, turnId] of [
      ["Alpha accepted.", TURN_A],
      ["Beta undone.", TURN_B],
      ["Gamma pending.", TURN_A],
    ] as const) {
      await scenario.store.appendUpdate({
        draftId: draft.id,
        updateData: appendMarkdownBlockInDoc(draftRuntime, scenario, markdown),
        actorTurnId: turnId,
      });
    }
    draftRuntime.destroy();

    const initialPreview = await scenario.preview.previewDraft({
      documentId: DOC_ID,
      draftId: draft.id,
    });
    expect(normalizeMarkdown(initialPreview.markdown)).toBe(
      "Seed.\n\nAlpha accepted.\n\nBeta undone.\n\nGamma pending.",
    );
    expect(reviewChangeCount(initialPreview)).toBeGreaterThan(0);
    const alpha = operationContaining(initialPreview, "Alpha accepted.");
    liveAfterUndo = "Seed.";
    const alphaAccept = await scenario.service.acceptDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      draftId: draft.id,
      userId: USER_ID,
      operationIds: [alpha.operationId],
      draftRevisionToken: initialPreview.draftRevisionToken,
    });
    expect(alphaAccept).toMatchObject({ status: "partial_applied" });
    expect(normalizeMarkdown(await liveMarkdown(scenario))).toBe("Seed.\n\nAlpha accepted.");

    const afterAlpha = await scenario.preview.previewDraft({
      documentId: DOC_ID,
      draftId: draft.id,
    });
    expect(operationContaining(afterAlpha, "Beta undone.")).toBeTruthy();
    expect(operationContaining(afterAlpha, "Gamma pending.")).toBeTruthy();
    expect(operationMaybeContaining(afterAlpha, "Alpha accepted.")).toBeNull();

    const beta = operationContaining(afterAlpha, "Beta undone.");
    liveAfterUndo = "Seed.\n\nAlpha accepted.";
    const betaAccept = await scenario.service.acceptDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      draftId: draft.id,
      userId: USER_ID,
      operationIds: [beta.operationId],
      draftRevisionToken: afterAlpha.draftRevisionToken,
    });
    expect(betaAccept).toMatchObject({ status: "partial_applied" });
    if (betaAccept.status !== "partial_applied") throw new Error("expected beta partial accept");
    const betaWriteId = betaAccept.writeId;
    expect(normalizeMarkdown(await liveMarkdown(scenario))).toBe(
      "Seed.\n\nAlpha accepted.\n\nBeta undone.",
    );

    await expect(
      scenario.service.undoAcceptDraft({
        documentId: DOC_ID,
        threadId: THREAD_ID,
        draftId: draft.id,
        userId: USER_ID,
        writeId: betaWriteId,
      }),
    ).resolves.toEqual({ status: "reactivated", draftId: draft.id });

    expect(normalizeMarkdown(await liveMarkdown(scenario))).toBe("Seed.\n\nAlpha accepted.");
    expect(refreshProjection).toHaveBeenCalledWith({ documentId: DOC_ID, threadId: THREAD_ID });
    await expect(scenario.store.getDraft(draft.id)).resolves.toMatchObject({
      status: "active",
      baseLiveUpdateSeq,
      acceptGeneration: 1,
    });

    const afterUndo = await scenario.preview.previewDraft({
      documentId: DOC_ID,
      draftId: draft.id,
    });
    expect(normalizeMarkdown(afterUndo.live)).toBe("Seed.\n\nAlpha accepted.");
    expect(normalizeMarkdown(afterUndo.markdown)).toBe(
      "Seed.\n\nAlpha accepted.\n\nBeta undone.\n\nGamma pending.",
    );
    expect(afterUndo.markdown).toContain("Beta undone.");
    expect(afterUndo.markdown).toContain("Gamma pending.");
    expect(afterUndo.operations).toHaveLength(3);
    expect(operationContaining(afterUndo, "Alpha accepted.")).toMatchObject({
      actorTurnId: TURN_A,
    });
    expect(operationContaining(afterUndo, "Beta undone.")).toMatchObject({
      operationId: expect.any(String),
    });
    expect(operationContaining(afterUndo, "Gamma pending.")).toMatchObject({
      operationId: expect.any(String),
    });
    expect(reviewChangeCount(afterUndo)).toBeGreaterThan(0);

    expect(normalizeMarkdown(await liveMarkdown(scenario))).toBe("Seed.\n\nAlpha accepted.");
  });

  it("uses the original draft basis after partial undo with intervening live edits", async () => {
    let liveAfterUndo = "";
    const scenario = await createScenario({
      reverseAcceptedDraft: async () => {
        await replaceLiveMarkdown(scenario, liveAfterUndo);
        return "reversed";
      },
    });
    await replaceLiveMarkdown(scenario, "Seed.");
    const draft = await scenario.store.createActiveDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      lastActorTurnId: TURN_A,
      baseLiveUpdateSeq: await scenario.journal.latestUpdateSeq(DOC_ID),
    });
    const draftRuntime = await draftRuntimeFromLive(scenario);
    for (const [markdown, turnId] of [
      ["Alpha accepted.", TURN_A],
      ["Beta undone.", TURN_B],
      ["Gamma pending.", TURN_A],
    ] as const) {
      await scenario.store.appendUpdate({
        draftId: draft.id,
        updateData: appendMarkdownBlockInDoc(draftRuntime, scenario, markdown),
        actorTurnId: turnId,
      });
    }
    draftRuntime.destroy();

    const initialPreview = await scenario.preview.previewDraft({
      documentId: DOC_ID,
      draftId: draft.id,
    });
    const alpha = operationContaining(initialPreview, "Alpha accepted.");
    liveAfterUndo = "Seed.";
    await scenario.service.acceptDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      draftId: draft.id,
      userId: USER_ID,
      operationIds: [alpha.operationId],
      draftRevisionToken: initialPreview.draftRevisionToken,
    });
    await replaceLiveMarkdown(scenario, "Seed.\n\nAlpha accepted.\n\nWriter note.");

    const afterWriterEdit = await scenario.preview.previewDraft({
      documentId: DOC_ID,
      draftId: draft.id,
    });
    const beta = operationContaining(afterWriterEdit, "Beta undone.");
    liveAfterUndo = "Seed.\n\nAlpha accepted.\n\nWriter note.";
    const betaAccept = await scenario.service.acceptDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      draftId: draft.id,
      userId: USER_ID,
      operationIds: [beta.operationId],
      draftRevisionToken: afterWriterEdit.draftRevisionToken,
      confirmedClosureOperationIds: [beta.operationId],
      confirmedLiveRevisionToken: afterWriterEdit.liveRevisionToken,
    });
    if (betaAccept.status !== "partial_applied") throw new Error("expected beta partial accept");

    await expect(
      scenario.service.undoAcceptDraft({
        documentId: DOC_ID,
        threadId: THREAD_ID,
        draftId: draft.id,
        userId: USER_ID,
        writeId: betaAccept.writeId,
      }),
    ).resolves.toEqual({ status: "reactivated", draftId: draft.id });

    expect(normalizeMarkdown(await liveMarkdown(scenario))).toBe(
      "Seed.\n\nAlpha accepted.\n\nWriter note.",
    );
    const afterUndo = await scenario.preview.previewDraft({
      documentId: DOC_ID,
      draftId: draft.id,
    });
    expect(normalizeMarkdown(afterUndo.live)).toBe("Seed.\n\nAlpha accepted.\n\nWriter note.");
    expect(normalizeMarkdown(afterUndo.markdown)).toBe(
      "Seed.\n\nAlpha accepted.\n\nBeta undone.\n\nGamma pending.",
    );
    expect(operationContaining(afterUndo, "Alpha accepted.")).toMatchObject({
      actorTurnId: TURN_A,
    });
    expect(operationContaining(afterUndo, "Beta undone.")).toBeTruthy();
    expect(operationContaining(afterUndo, "Gamma pending.")).toBeTruthy();
  });

  it("keeps a pending draft row when live independently contains the same text", async () => {
    let liveAfterUndo = "";
    const scenario = await createScenario({
      reverseAcceptedDraft: async () => {
        await replaceLiveMarkdown(scenario, liveAfterUndo);
        return "reversed";
      },
    });
    await replaceLiveMarkdown(scenario, "Seed.");
    const draft = await scenario.store.createActiveDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      lastActorTurnId: TURN_A,
      baseLiveUpdateSeq: await scenario.journal.latestUpdateSeq(DOC_ID),
    });
    const draftRuntime = await draftRuntimeFromLive(scenario);
    for (const markdown of ["Alpha accepted.", "Coincident text."] as const) {
      await scenario.store.appendUpdate({
        draftId: draft.id,
        updateData: appendMarkdownBlockInDoc(draftRuntime, scenario, markdown),
        actorTurnId: TURN_A,
      });
    }
    draftRuntime.destroy();

    const initialPreview = await scenario.preview.previewDraft({
      documentId: DOC_ID,
      draftId: draft.id,
    });
    const alpha = operationContaining(initialPreview, "Alpha accepted.");
    const alphaAccept = await scenario.service.acceptDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      draftId: draft.id,
      userId: USER_ID,
      operationIds: [alpha.operationId],
      draftRevisionToken: initialPreview.draftRevisionToken,
    });
    if (alphaAccept.status !== "partial_applied") throw new Error("expected alpha partial accept");

    await replaceLiveMarkdown(scenario, "Seed.\n\nAlpha accepted.\n\nCoincident text.");
    liveAfterUndo = "Seed.\n\nCoincident text.";

    await expect(
      scenario.service.undoAcceptDraft({
        documentId: DOC_ID,
        threadId: THREAD_ID,
        draftId: draft.id,
        userId: USER_ID,
        writeId: alphaAccept.writeId,
      }),
    ).resolves.toEqual({ status: "reactivated", draftId: draft.id });

    const afterUndo = await scenario.preview.previewDraft({
      documentId: DOC_ID,
      draftId: draft.id,
    });
    expect(normalizeMarkdown(afterUndo.live)).toBe("Seed.\n\nCoincident text.");
    expect(normalizeMarkdown(afterUndo.markdown)).toBe(
      "Seed.\n\nAlpha accepted.\n\nCoincident text.",
    );
    expect(afterUndo.markdown.match(/Coincident text\./g)).toHaveLength(1);
    expect(operationContaining(afterUndo, "Alpha accepted.")).toBeTruthy();
  });

  it("full undo reverses a mixed partial-plus-full generation with real live reversal", async () => {
    let scenario: Awaited<ReturnType<typeof createScenario>>;
    scenario = await createScenario({
      reverseAcceptedDraft: async ({ writeId, userId }) => {
        const liveCore = createAgentEditCore({
          journal: scenario.journal,
          coordinator: scenario.coordinator,
          lifecycle: { ensureDocument: async () => undefined },
          codec: scenario.codec,
          model: scenario.model,
          defaultThreadId: THREAD_ID,
          createRuntimeDoc: () => createCollabYDoc({ gc: false }),
        });
        const result = await liveCore.reverse({
          docId: DOC_ID,
          threadId: THREAD_ID,
          direction: "undo",
          selection: { kind: "single", to: writeId },
          actor: { type: "user", userId },
          requireEffect: true,
        });
        return result.status !== "document_not_found" &&
          "reversalEffect" in result &&
          result.reversalEffect === "changed"
          ? "reversed"
          : "not_reversed";
      },
    });
    await replaceLiveMarkdown(scenario, "Seed.");
    const draft = await scenario.store.createActiveDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      lastActorTurnId: TURN_A,
      baseLiveUpdateSeq: await scenario.journal.latestUpdateSeq(DOC_ID),
    });
    const draftRuntime = await draftRuntimeFromLive(scenario);
    for (const [markdown, turnId] of [
      ["Alpha accepted.", TURN_A],
      ["Beta full.", TURN_B],
      ["Gamma full.", TURN_A],
    ] as const) {
      await scenario.store.appendUpdate({
        draftId: draft.id,
        updateData: appendMarkdownBlockInDoc(draftRuntime, scenario, markdown),
        actorTurnId: turnId,
      });
    }
    draftRuntime.destroy();

    const initialPreview = await scenario.preview.previewDraft({
      documentId: DOC_ID,
      draftId: draft.id,
    });
    const alpha = operationContaining(initialPreview, "Alpha accepted.");
    const partial = await scenario.service.acceptDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      draftId: draft.id,
      userId: USER_ID,
      operationIds: [alpha.operationId],
      draftRevisionToken: initialPreview.draftRevisionToken,
    });
    expect(partial).toMatchObject({ status: "partial_applied" });
    const restPreview = await scenario.preview.previewDraft({
      documentId: DOC_ID,
      draftId: draft.id,
    });
    const full = await scenario.service.acceptDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      draftId: draft.id,
      userId: USER_ID,
      draftRevisionToken: restPreview.draftRevisionToken,
    });
    expect(full).toMatchObject({ status: "applied" });
    expect(normalizeMarkdown(await liveMarkdown(scenario))).toBe(
      "Seed.\n\nAlpha accepted.\n\nBeta full.\n\nGamma full.",
    );

    await expect(
      scenario.service.undoAcceptDraft({
        documentId: DOC_ID,
        threadId: THREAD_ID,
        draftId: draft.id,
        userId: USER_ID,
      }),
    ).resolves.toEqual({ status: "reactivated", draftId: draft.id });
    expect(normalizeMarkdown(await liveMarkdown(scenario))).toBe("Seed.");
    const afterUndo = await scenario.preview.previewDraft({
      documentId: DOC_ID,
      draftId: draft.id,
    });
    expect(operationContaining(afterUndo, "Alpha accepted.")).toBeTruthy();
    expect(operationContaining(afterUndo, "Beta full.")).toBeTruthy();
    expect(operationContaining(afterUndo, "Gamma full.")).toBeTruthy();
    const acceptedMutations = scenario.journal
      .mutationRecords(DOC_ID)
      .filter((mutation) => mutation.writeId.startsWith("draft-accept:"));
    expect(acceptedMutations.map((mutation) => mutation.status)).toEqual(["reversed", "reversed"]);
    expect(acceptedMutations.map((mutation) => mutation.writeId)).toEqual([
      partial.status === "partial_applied" ? partial.writeId : "",
      expect.stringMatching(/^draft-accept:/),
    ]);
  });

  it("returns causal_dependency without journaling when a partial accept has no live effect", async () => {
    const scenario = await createScenario();
    await replaceLiveMarkdown(scenario, "Seed.");
    const draft = await scenario.store.createActiveDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      lastActorTurnId: TURN_A,
      baseLiveUpdateSeq: await scenario.journal.latestUpdateSeq(DOC_ID),
    });
    const draftRuntime = await draftRuntimeFromLive(scenario);
    await scenario.store.appendUpdate({
      draftId: draft.id,
      updateData: appendMarkdownBlockInDoc(draftRuntime, scenario, "Guarded proposal."),
      actorTurnId: TURN_A,
    });
    draftRuntime.destroy();
    const preview = await scenario.preview.previewDraft({ documentId: DOC_ID, draftId: draft.id });
    const proposal = operationContaining(preview, "Guarded proposal.");
    const [proposalUpdate] = await scenario.store.listUpdates(draft.id);
    if (!proposalUpdate) throw new Error("expected proposal update");

    const originalWithDocument = scenario.coordinator.withDocument.bind(scenario.coordinator);
    scenario.coordinator.withDocument = (async (documentId, fn) => {
      return originalWithDocument(documentId, async (doc) => {
        const clone = createCollabYDoc({ gc: false });
        try {
          Y.applyUpdate(clone, Y.encodeStateAsUpdate(doc));
          Y.applyUpdate(clone, proposalUpdate.updateData);
          return await fn(clone);
        } finally {
          clone.destroy();
        }
      });
    }) as typeof scenario.coordinator.withDocument;

    const result = await scenario.service.acceptDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      draftId: draft.id,
      userId: USER_ID,
      operationIds: [proposal.operationId],
      draftRevisionToken: preview.draftRevisionToken,
    });

    scenario.coordinator.withDocument =
      originalWithDocument as typeof scenario.coordinator.withDocument;
    expect(result).toMatchObject({ status: "causal_dependency", draftId: draft.id });
    expect(scenario.journal.mutationRecords(DOC_ID)).toHaveLength(0);
    expect(normalizeMarkdown(await liveMarkdown(scenario))).toBe("Seed.");
    const after = await scenario.preview.previewDraft({ documentId: DOC_ID, draftId: draft.id });
    expect(operationContaining(after, "Guarded proposal.")).toBeTruthy();
  });

  it("status-fences partial accept journal appends", async () => {
    const scenario = await createScenario();
    await replaceLiveMarkdown(scenario, "Seed.");
    const draft = await scenario.store.createActiveDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      lastActorTurnId: TURN_A,
      baseLiveUpdateSeq: await scenario.journal.latestUpdateSeq(DOC_ID),
    });
    await scenario.store.reject({ documentId: DOC_ID, threadId: THREAD_ID, draftId: draft.id });

    await expect(
      scenario.liveJournal.appendAcceptedDraft({
        documentId: DOC_ID,
        threadId: THREAD_ID,
        draftId: draft.id,
        update: updateFromText("Should not append."),
        writeId: `draft-accept:${draft.id}:op:test`,
        actorUserId: USER_ID,
        expectedDraftStatus: "active",
      }),
    ).rejects.toThrow("Draft is not active");
    expect(scenario.journal.mutationRecords(DOC_ID)).toHaveLength(0);
  });

  it("causal-closes partial accept so accepting a later append drags predecessors", async () => {
    const scenario = await createScenario();
    await replaceLiveMarkdown(scenario, "Seed.");
    const draft = await scenario.store.createActiveDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      lastActorTurnId: TURN_A,
      baseLiveUpdateSeq: await scenario.journal.latestUpdateSeq(DOC_ID),
    });
    const draftRuntime = await draftRuntimeFromLive(scenario);
    for (const [markdown, turnId] of [
      ["Alpha predecessor.", TURN_A],
      ["Beta predecessor.", TURN_B],
      ["Gamma requested.", TURN_A],
    ] as const) {
      await scenario.store.appendUpdate({
        draftId: draft.id,
        updateData: appendMarkdownBlockInDoc(draftRuntime, scenario, markdown),
        actorTurnId: turnId,
      });
    }
    draftRuntime.destroy();

    const preview = await scenario.preview.previewDraft({ documentId: DOC_ID, draftId: draft.id });
    const gamma = operationContaining(preview, "Gamma requested.");

    const unconfirmed = await scenario.service.acceptDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      draftId: draft.id,
      userId: USER_ID,
      operationIds: [gamma.operationId],
      draftRevisionToken: preview.draftRevisionToken,
    });
    expect(unconfirmed).toMatchObject({
      status: "closure_confirmation_required",
      closureOperationIds: expect.arrayContaining([gamma.operationId]),
    });
    if (unconfirmed.status !== "closure_confirmation_required") {
      throw new Error("expected closure confirmation");
    }
    expect(unconfirmed.closureOperationIds.length).toBe(3);

    const result = await scenario.service.acceptDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      draftId: draft.id,
      userId: USER_ID,
      operationIds: [gamma.operationId],
      draftRevisionToken: preview.draftRevisionToken,
      confirmedClosureOperationIds:
        unconfirmed.status === "closure_confirmation_required"
          ? unconfirmed.closureOperationIds
          : [gamma.operationId],
      confirmedLiveRevisionToken: preview.liveRevisionToken,
    });

    expect(result).toMatchObject({ status: "partial_applied" });
    if (result.status !== "partial_applied") throw new Error("expected partial apply");
    expect(result.acceptedOperationIds).toHaveLength(3);
    expect(normalizeMarkdown(await liveMarkdown(scenario))).toBe(
      "Seed.\n\nAlpha predecessor.\n\nBeta predecessor.\n\nGamma requested.",
    );
    const afterAccept = await scenario.preview.previewDraft({
      documentId: DOC_ID,
      draftId: draft.id,
    });
    expect(afterAccept.operations).toHaveLength(0);
  });

  it("acceptance: per-op accept, writer edit, undo, card restoration, and re-accept", async () => {
    const scenario = await createScenario({
      reverseAcceptedDraft: async () => {
        await replaceLiveMarkdown(scenario, "Seed.");
        return "reversed";
      },
    });
    await replaceLiveMarkdown(scenario, "Seed.");
    const baseLiveUpdateSeq = await scenario.journal.latestUpdateSeq(DOC_ID);
    const draft = await scenario.store.createActiveDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      lastActorTurnId: TURN_A,
      baseLiveUpdateSeq,
    });
    const draftRuntime = await draftRuntimeFromLive(scenario);
    await scenario.store.appendUpdate({
      draftId: draft.id,
      updateData: appendMarkdownBlockInDoc(draftRuntime, scenario, "Restored agent op."),
      actorTurnId: TURN_A,
    });
    await scenario.store.appendUpdate({
      draftId: draft.id,
      updateData: appendMarkdownBlockInDoc(draftRuntime, scenario, "Writer interleave."),
      actorUserId: USER_ID,
    });
    await scenario.store.appendUpdate({
      draftId: draft.id,
      updateData: appendMarkdownBlockInDoc(draftRuntime, scenario, "Still pending agent op."),
      actorTurnId: TURN_B,
    });
    draftRuntime.destroy();
    const originalRows = await scenario.store.listUpdates(draft.id);
    const originalRowBytes = originalRows.map((row) => Array.from(row.updateData));

    const beforeAccept = await scenario.preview.previewDraft({
      documentId: DOC_ID,
      draftId: draft.id,
    });
    const restoredAgent = operationContaining(beforeAccept, "Restored agent op.");
    const accept = await scenario.service.acceptDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      draftId: draft.id,
      userId: USER_ID,
      operationIds: [restoredAgent.operationId],
      draftRevisionToken: beforeAccept.draftRevisionToken,
      confirmedClosureOperationIds: [restoredAgent.operationId],
      confirmedLiveRevisionToken: beforeAccept.liveRevisionToken,
    });
    expect(accept).toMatchObject({ status: "partial_applied" });
    if (accept.status !== "partial_applied") throw new Error("expected partial accept");

    await expect(
      scenario.service.undoAcceptDraft({
        documentId: DOC_ID,
        threadId: THREAD_ID,
        draftId: draft.id,
        userId: USER_ID,
        writeId: accept.writeId,
      }),
    ).resolves.toEqual({ status: "reactivated", draftId: draft.id });

    await expect(scenario.store.getDraft(draft.id)).resolves.toMatchObject({
      status: "active",
      baseLiveUpdateSeq,
      acceptGeneration: 1,
      undoneAt: expect.any(Date),
    });
    const rowsAfterUndo = await scenario.store.listUpdates(draft.id);
    expect(rowsAfterUndo).toHaveLength(3);
    expect(rowsAfterUndo.map((row) => Array.from(row.updateData))).toEqual(originalRowBytes);
    expect(rowsAfterUndo.map((row) => row.actorTurnId)).toEqual([TURN_A, null, TURN_B]);
    expect(rowsAfterUndo.map((row) => row.actorUserId)).toEqual([null, USER_ID, null]);

    const afterUndo = await scenario.preview.previewDraft({
      documentId: DOC_ID,
      draftId: draft.id,
    });
    expect(normalizeMarkdown(afterUndo.live)).toBe("Seed.");
    expect(normalizeMarkdown(afterUndo.markdown)).toBe(
      "Seed.\n\nRestored agent op.\n\nWriter interleave.\n\nStill pending agent op.",
    );
    expect(afterUndo.operations).toHaveLength(3);
    expect(operationContaining(afterUndo, "Restored agent op.")).toMatchObject({
      actorTurnId: TURN_A,
      kind: "agent",
    });
    expect(operationContaining(afterUndo, "Still pending agent op.")).toMatchObject({
      actorTurnId: TURN_B,
      kind: "agent",
    });
    const restoredAfterUndo = operationContaining(afterUndo, "Restored agent op.");
    expect(operationContaining(afterUndo, "Writer interleave.")).toMatchObject({
      operationId: expect.stringContaining("writer:"),
      actorUserId: USER_ID,
      kind: "writer",
    });

    const reaccept = await scenario.service.acceptDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      draftId: draft.id,
      userId: USER_ID,
      operationIds: [restoredAfterUndo.operationId],
      draftRevisionToken: afterUndo.draftRevisionToken,
      confirmOverlap: true,
      confirmedClosureOperationIds: [restoredAfterUndo.operationId],
      confirmedLiveRevisionToken: afterUndo.liveRevisionToken,
    });
    expect(reaccept).toMatchObject({ status: "partial_applied" });
    expect(normalizeMarkdown(await liveMarkdown(scenario))).toBe("Seed.\n\nRestored agent op.");
  });

  it("returns an error and leaves an applied draft unchanged when live reversal fails", async () => {
    const scenario = await createScenario({
      reverseAcceptedDraft: async () => "not_reversed",
    });
    await replaceLiveMarkdown(scenario, "Live chapter seed.");
    const draft = await scenario.store.createActiveDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      lastActorTurnId: TURN_A,
      baseLiveUpdateSeq: await scenario.journal.latestUpdateSeq(DOC_ID),
    });
    await scenario.store.appendUpdate({
      draftId: draft.id,
      updateData: await updateFromMarkdownOverLive(scenario, "Live chapter seed. Draft."),
      actorTurnId: TURN_A,
    });
    await scenario.service.acceptDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      draftId: draft.id,
      userId: USER_ID,
    });
    const updateCount = (await scenario.store.listUpdates(draft.id)).length;
    const journalCount = scenario.journal.updateRecords(DOC_ID).length;

    await expect(
      scenario.service.undoAcceptDraft({
        documentId: DOC_ID,
        threadId: THREAD_ID,
        draftId: draft.id,
        userId: USER_ID,
      }),
    ).resolves.toMatchObject({ status: "conflict", draftId: draft.id });

    await expect(scenario.store.getDraft(draft.id)).resolves.toMatchObject({
      status: "applied",
      acceptGeneration: 0,
    });
    expect(await scenario.store.listUpdates(draft.id)).toHaveLength(updateCount);
    expect(scenario.journal.updateRecords(DOC_ID)).toHaveLength(journalCount);
  });

  it("fails partial-accept undo cleanly when live reversal is a no-op", async () => {
    const scenario = await createScenario({
      reverseAcceptedDraft: async () => "not_reversed",
    });
    await replaceLiveMarkdown(scenario, "Seed.");
    const draft = await scenario.store.createActiveDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      lastActorTurnId: TURN_A,
      baseLiveUpdateSeq: await scenario.journal.latestUpdateSeq(DOC_ID),
    });
    const draftRuntime = await draftRuntimeFromLive(scenario);
    await scenario.store.appendUpdate({
      draftId: draft.id,
      updateData: appendMarkdownBlockInDoc(draftRuntime, scenario, "Accepted once."),
      actorTurnId: TURN_A,
    });
    draftRuntime.destroy();
    const preview = await scenario.preview.previewDraft({ documentId: DOC_ID, draftId: draft.id });
    const op = operationContaining(preview, "Accepted once.");
    const accept = await scenario.service.acceptDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      draftId: draft.id,
      userId: USER_ID,
      operationIds: [op.operationId],
      draftRevisionToken: preview.draftRevisionToken,
      confirmedClosureOperationIds: [op.operationId],
      confirmedLiveRevisionToken: preview.liveRevisionToken,
    });
    if (accept.status !== "partial_applied") throw new Error("expected partial accept");
    const journalBefore = scenario.journal.updateRecords(DOC_ID).length;
    const updatesBefore = (await scenario.store.listUpdates(draft.id)).length;

    await expect(
      scenario.service.undoAcceptDraft({
        documentId: DOC_ID,
        threadId: THREAD_ID,
        draftId: draft.id,
        userId: USER_ID,
        writeId: accept.writeId,
      }),
    ).resolves.toMatchObject({ status: "conflict", draftId: draft.id });

    await expect(scenario.store.getDraft(draft.id)).resolves.toMatchObject({ status: "active" });
    expect((await scenario.store.listUpdates(draft.id)).length).toBe(updatesBefore);
    expect(scenario.journal.updateRecords(DOC_ID)).toHaveLength(journalBefore);
  });

  it("resumes partial-accept undo after the live reversal already landed", async () => {
    const scenario = await createScenario({
      reverseAcceptedDraft: async () => {
        await replaceLiveMarkdown(scenario, "Seed.");
        return "reversed";
      },
    });
    await replaceLiveMarkdown(scenario, "Seed.");
    const draft = await scenario.store.createActiveDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      lastActorTurnId: TURN_A,
      baseLiveUpdateSeq: await scenario.journal.latestUpdateSeq(DOC_ID),
    });
    const draftRuntime = await draftRuntimeFromLive(scenario);
    await scenario.store.appendUpdate({
      draftId: draft.id,
      updateData: appendMarkdownBlockInDoc(draftRuntime, scenario, "Resume me."),
      actorTurnId: TURN_A,
    });
    draftRuntime.destroy();
    const preview = await scenario.preview.previewDraft({ documentId: DOC_ID, draftId: draft.id });
    const op = operationContaining(preview, "Resume me.");
    const accept = await scenario.service.acceptDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      draftId: draft.id,
      userId: USER_ID,
      operationIds: [op.operationId],
      draftRevisionToken: preview.draftRevisionToken,
      confirmedClosureOperationIds: [op.operationId],
      confirmedLiveRevisionToken: preview.liveRevisionToken,
    });
    if (accept.status !== "partial_applied") throw new Error("expected partial accept");
    await scenario.store.claimMutation({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      draftId: draft.id,
      kind: "reactivation",
      fromStatuses: ["active"],
    });
    scenario.store.expireAcceptClaim(draft.id);
    await replaceLiveMarkdown(scenario, "Seed.");

    await expect(
      scenario.service.undoAcceptDraft({
        documentId: DOC_ID,
        threadId: THREAD_ID,
        draftId: draft.id,
        userId: USER_ID,
        writeId: accept.writeId,
      }),
    ).resolves.toEqual({ status: "reactivated", draftId: draft.id });

    const afterUndo = await scenario.preview.previewDraft({
      documentId: DOC_ID,
      draftId: draft.id,
    });
    expect(operationContaining(afterUndo, "Resume me.")).toBeTruthy();
  });

  it("undoes partial accept after intervening live edits without wedging", async () => {
    const scenario = await createScenario({
      reverseAcceptedDraft: async () => {
        await replaceLiveMarkdown(scenario, "Seed.\n\nWriter live edit.");
        return "reversed";
      },
    });
    await replaceLiveMarkdown(scenario, "Seed.");
    const draft = await scenario.store.createActiveDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      lastActorTurnId: TURN_A,
      baseLiveUpdateSeq: await scenario.journal.latestUpdateSeq(DOC_ID),
    });
    const draftRuntime = await draftRuntimeFromLive(scenario);
    await scenario.store.appendUpdate({
      draftId: draft.id,
      updateData: appendMarkdownBlockInDoc(draftRuntime, scenario, "Draft proposal."),
      actorTurnId: TURN_A,
    });
    draftRuntime.destroy();
    const preview = await scenario.preview.previewDraft({ documentId: DOC_ID, draftId: draft.id });
    const op = operationContaining(preview, "Draft proposal.");
    const accept = await scenario.service.acceptDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      draftId: draft.id,
      userId: USER_ID,
      operationIds: [op.operationId],
      draftRevisionToken: preview.draftRevisionToken,
      confirmedClosureOperationIds: [op.operationId],
      confirmedLiveRevisionToken: preview.liveRevisionToken,
    });
    if (accept.status !== "partial_applied") throw new Error("expected partial accept");
    await scenario.coordinator.withDocument(DOC_ID, async (doc) => {
      doc.getText("body").insert(doc.getText("body").length, "\n\nWriter live edit.");
    });

    await expect(
      scenario.service.undoAcceptDraft({
        documentId: DOC_ID,
        threadId: THREAD_ID,
        draftId: draft.id,
        userId: USER_ID,
        writeId: accept.writeId,
      }),
    ).resolves.toEqual({ status: "reactivated", draftId: draft.id });

    expect(normalizeMarkdown(await liveMarkdown(scenario))).toContain("Writer live edit.");
    const afterUndo = await scenario.preview.previewDraft({
      documentId: DOC_ID,
      draftId: draft.id,
    });
    expect(operationContaining(afterUndo, "Draft proposal.")).toBeTruthy();
  });

  it("emits an undone lifecycle fact once, not after later draft appends", async () => {
    const scenario = await createScenario({
      reverseAcceptedDraft: async () => {
        await replaceLiveMarkdown(scenario, "Seed.");
        return "reversed";
      },
    });
    await replaceLiveMarkdown(scenario, "Seed.");
    const draft = await scenario.store.createActiveDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      lastActorTurnId: TURN_A,
      baseLiveUpdateSeq: await scenario.journal.latestUpdateSeq(DOC_ID),
    });
    await scenario.store.appendUpdate({
      draftId: draft.id,
      updateData: await updateFromMarkdownOverLive(scenario, "Seed.\n\nDraft."),
      actorTurnId: TURN_A,
    });
    await scenario.service.acceptDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      draftId: draft.id,
      userId: USER_ID,
    });
    await scenario.service.undoAcceptDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      draftId: draft.id,
      userId: USER_ID,
    });
    const undoneAt = (await scenario.store.getDraft(draft.id))?.undoneAt;
    expect(undoneAt).toBeInstanceOf(Date);
    await scenario.store.appendUpdate({
      draftId: draft.id,
      updateData: updateFromText(" More."),
      actorTurnId: TURN_B,
    });
    const states = await scenario.store.listLifecycleStateByWork({ workId: WORK_ID });
    expect(states.filter((state) => state.status === "active" && state.undoneAt)).toHaveLength(1);
  });
});
