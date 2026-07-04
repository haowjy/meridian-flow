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

async function replaceLiveSubstrings(
  scenario: Awaited<ReturnType<typeof createScenario>>,
  replacements: readonly [find: string, replacement: string][],
): Promise<void> {
  await scenario.coordinator.withDocument(DOC_ID, async (doc) => {
    const handle = toDocHandle(doc);
    const [block] = scenario.model.getBlocks(handle);
    if (!block) throw new Error("expected live block");
    const before = Y.encodeStateVector(doc);
    for (const [find, replacement] of replacements) {
      const text = scenario.model.getText(block);
      const from = text.indexOf(find);
      if (from === -1) throw new Error(`expected live text containing ${find}`);
      scenario.model.applyTextEdit(handle, block, { from, to: from + find.length }, replacement);
    }
    await scenario.journal.append(DOC_ID, Y.encodeStateAsUpdate(doc, before), {
      origin: `human:${USER_ID}`,
      seq: 0,
    });
  });
}

function replaceMiddleBlockInDoc(
  scenario: Awaited<ReturnType<typeof createScenario>>,
  doc: Y.Doc,
  replacementMarkdown: string,
): Uint8Array {
  const handle = toDocHandle(doc);
  const before = Y.encodeStateVector(doc);
  const blocks = scenario.model.getBlocks(handle);
  if (blocks.length < 3) throw new Error("expected at least three blocks");
  scenario.model.insertBlocks(handle, blocks[0] ?? null, scenario.codec.parse(replacementMarkdown));
  scenario.model.deleteBlock(handle, blocks[1] as NonNullable<(typeof blocks)[number]>);
  return Y.encodeStateAsUpdate(doc, before);
}

function moveMiddleBlockToEndInDoc(
  scenario: Awaited<ReturnType<typeof createScenario>>,
  doc: Y.Doc,
): Uint8Array {
  const handle = toDocHandle(doc);
  const before = Y.encodeStateVector(doc);
  const blocks = scenario.model.getBlocks(handle);
  if (blocks.length < 3) throw new Error("expected at least three blocks");
  const projected = scenario.model.projectBlocks(handle);
  const middle = projected[1];
  if (!middle) throw new Error("expected middle projected block");
  scenario.model.insertBlocks(
    handle,
    blocks[2] ?? null,
    scenario.codec.parse(scenario.codec.serialize([middle])),
  );
  scenario.model.deleteBlock(handle, blocks[1] as NonNullable<(typeof blocks)[number]>);
  return Y.encodeStateAsUpdate(doc, before);
}

function moveAndReplaceMiddleBlockToEndInDoc(
  scenario: Awaited<ReturnType<typeof createScenario>>,
  doc: Y.Doc,
): Uint8Array {
  const handle = toDocHandle(doc);
  const before = Y.encodeStateVector(doc);
  const blocks = scenario.model.getBlocks(handle);
  if (blocks.length < 3) throw new Error("expected at least three blocks");
  const projected = scenario.model.projectBlocks(handle);
  const middle = projected[1];
  if (!middle) throw new Error("expected middle projected block");
  const [moved] = scenario.model.insertBlocks(
    handle,
    blocks[2] ?? null,
    scenario.codec.parse(scenario.codec.serialize([middle])),
  );
  if (!moved) throw new Error("expected moved copy");
  scenario.model.applyTextEdit(
    handle,
    moved,
    { from: 0, to: scenario.model.getText(moved).length },
    "B′.",
  );
  scenario.model.deleteBlock(handle, blocks[1] as NonNullable<(typeof blocks)[number]>);
  return Y.encodeStateAsUpdate(doc, before);
}

async function liveBlockSummaries(
  scenario: Awaited<ReturnType<typeof createScenario>>,
): Promise<readonly { id: string; text: string }[]> {
  return await scenario.coordinator.withDocument(DOC_ID, async (doc) => {
    const handle = toDocHandle(doc);
    return scenario.model.getBlocks(handle).map((block) => ({
      id: scenario.model.getBlockId(block),
      text: scenario.model.getText(block),
    }));
  });
}

function deleteMiddleBlockInDoc(
  scenario: Awaited<ReturnType<typeof createScenario>>,
  doc: Y.Doc,
): Uint8Array {
  const handle = toDocHandle(doc);
  const before = Y.encodeStateVector(doc);
  const blocks = scenario.model.getBlocks(handle);
  if (blocks.length < 3) throw new Error("expected at least three blocks");
  scenario.model.deleteBlock(handle, blocks[1] as NonNullable<(typeof blocks)[number]>);
  return Y.encodeStateAsUpdate(doc, before);
}

async function editLiveMiddleBlock(
  scenario: Awaited<ReturnType<typeof createScenario>>,
  replacementText: string,
): Promise<void> {
  await scenario.coordinator.withDocument(DOC_ID, async (doc) => {
    const handle = toDocHandle(doc);
    const blocks = scenario.model.getBlocks(handle);
    const block = blocks[1];
    if (!block) throw new Error("expected middle live block");
    const before = Y.encodeStateVector(doc);
    scenario.model.applyTextEdit(
      handle,
      block,
      { from: 0, to: scenario.model.getText(block).length },
      replacementText,
    );
    await scenario.journal.append(DOC_ID, Y.encodeStateAsUpdate(doc, before), {
      origin: `human:${USER_ID}`,
      seq: 0,
    });
  });
}

async function deleteLiveMiddleBlock(
  scenario: Awaited<ReturnType<typeof createScenario>>,
): Promise<void> {
  await scenario.coordinator.withDocument(DOC_ID, async (doc) => {
    const handle = toDocHandle(doc);
    const blocks = scenario.model.getBlocks(handle);
    const block = blocks[1];
    if (!block) throw new Error("expected middle live block");
    const before = Y.encodeStateVector(doc);
    scenario.model.deleteBlock(handle, block);
    await scenario.journal.append(DOC_ID, Y.encodeStateAsUpdate(doc, before), {
      origin: `human:${USER_ID}`,
      seq: 0,
    });
  });
}

async function reactivatedDraftFromBlockMutation(
  mutate: (scenario: Awaited<ReturnType<typeof createScenario>>, doc: Y.Doc) => Uint8Array,
): Promise<{
  scenario: Awaited<ReturnType<typeof createScenario>>;
  draft: Awaited<
    ReturnType<Awaited<ReturnType<typeof createScenario>>["store"]["createActiveDraft"]>
  >;
  originalBlocks: readonly { id: string; text: string }[];
  restoredBlocks: readonly { id: string; text: string }[];
}> {
  const scenario = await createScenarioWithRealAcceptUndo();
  await replaceLiveMarkdown(scenario, "A.\n\nB.\n\nC.");
  const originalBlocks = await liveBlockSummaries(scenario);
  const draft = await scenario.store.createActiveDraft({
    documentId: DOC_ID,
    threadId: THREAD_ID,
    lastActorTurnId: TURN_A,
    baseLiveUpdateSeq: await scenario.journal.latestUpdateSeq(DOC_ID),
  });
  const draftRuntime = await draftRuntimeFromLive(scenario);
  await scenario.store.appendUpdate({
    draftId: draft.id,
    updateData: mutate(scenario, draftRuntime),
    actorTurnId: TURN_A,
  });
  draftRuntime.destroy();

  const preview = await scenario.preview.previewDraft({ documentId: DOC_ID, draftId: draft.id });
  await scenario.service.acceptDraft({
    documentId: DOC_ID,
    threadId: THREAD_ID,
    draftId: draft.id,
    userId: USER_ID,
    draftRevisionToken: preview.draftRevisionToken,
  });
  await scenario.service.undoAcceptDraft({
    documentId: DOC_ID,
    threadId: THREAD_ID,
    draftId: draft.id,
    userId: USER_ID,
  });
  expect(normalizeMarkdown(await liveMarkdown(scenario))).toBe("A.\n\nB.\n\nC.");
  const restoredBlocks = await liveBlockSummaries(scenario);
  return { scenario, draft, originalBlocks, restoredBlocks };
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

  it("acceptance: created-doc reactivation can partial-accept into empty live in draft order", async () => {
    const scenario = await createScenarioWithRealAcceptUndo();
    const draft = await scenario.store.createActiveDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      lastActorTurnId: TURN_A,
      baseLiveUpdateSeq: await scenario.journal.latestUpdateSeq(DOC_ID),
    });
    await scenario.store.markDraftCreatedDocument({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      draftId: draft.id,
    });
    const draftRuntime = await draftRuntimeFromLive(scenario);
    await scenario.store.appendUpdate({
      draftId: draft.id,
      updateData: appendMarkdownBlockInDoc(draftRuntime, scenario, "# Created chapter"),
      actorTurnId: TURN_A,
    });
    await scenario.store.appendUpdate({
      draftId: draft.id,
      updateData: appendMarkdownBlockInDoc(draftRuntime, scenario, "First created paragraph."),
      actorTurnId: TURN_A,
    });
    await scenario.store.appendUpdate({
      draftId: draft.id,
      updateData: appendMarkdownBlockInDoc(draftRuntime, scenario, "Second created paragraph."),
      actorTurnId: TURN_B,
    });
    await scenario.store.appendUpdate({
      draftId: draft.id,
      updateData: appendMarkdownBlockInDoc(draftRuntime, scenario, "Third created paragraph."),
      actorTurnId: TURN_B,
    });
    draftRuntime.destroy();

    const preview = await scenario.preview.previewDraft({ documentId: DOC_ID, draftId: draft.id });
    const fullAccept = await scenario.service.acceptDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      draftId: draft.id,
      userId: USER_ID,
      draftRevisionToken: preview.draftRevisionToken,
    });
    expect(fullAccept).toMatchObject({ status: "applied" });
    expect(normalizeMarkdown(await liveMarkdown(scenario))).toBe(
      "# Created chapter\n\nFirst created paragraph.\n\nSecond created paragraph.\n\nThird created paragraph.",
    );

    await expect(
      scenario.service.undoAcceptDraft({
        documentId: DOC_ID,
        threadId: THREAD_ID,
        draftId: draft.id,
        userId: USER_ID,
      }),
    ).resolves.toEqual({ status: "reactivated", draftId: draft.id });
    expect(await liveMarkdown(scenario)).toBe("");

    const afterUndo = await scenario.preview.previewDraft({
      documentId: DOC_ID,
      draftId: draft.id,
    });
    const second = operationContaining(afterUndo, "Third created paragraph.");
    const unconfirmed = await scenario.service.acceptDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      draftId: draft.id,
      userId: USER_ID,
      operationIds: [second.operationId],
      draftRevisionToken: afterUndo.draftRevisionToken,
      confirmedLiveRevisionToken: afterUndo.liveRevisionToken,
      confirmOverlap: true,
    });
    const accepted =
      unconfirmed.status === "closure_confirmation_required"
        ? await scenario.service.acceptDraft({
            documentId: DOC_ID,
            threadId: THREAD_ID,
            draftId: draft.id,
            userId: USER_ID,
            operationIds: [second.operationId],
            draftRevisionToken: afterUndo.draftRevisionToken,
            confirmedClosureOperationIds: unconfirmed.closureOperationIds,
            confirmedLiveRevisionToken: unconfirmed.liveRevisionToken,
            confirmOverlap: true,
          })
        : unconfirmed;

    expect(accepted).toMatchObject({ status: "partial_applied" });
    expect(normalizeMarkdown(await liveMarkdown(scenario))).toBe(
      "# Created chapter\n\nFirst created paragraph.\n\nSecond created paragraph.\n\nThird created paragraph.",
    );
  });

  it("acceptance: confirmed overlap returns cannot_place for a reactivated insert after deleted anchors", async () => {
    const scenario = await createScenarioWithRealAcceptUndo();
    await replaceLiveMarkdown(scenario, "Before anchor.\n\nAfter anchor.");
    const draft = await scenario.store.createActiveDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      lastActorTurnId: TURN_A,
      baseLiveUpdateSeq: await scenario.journal.latestUpdateSeq(DOC_ID),
    });
    const draftRuntime = await draftRuntimeFromLive(scenario);
    const beforeInsert = Y.encodeStateVector(draftRuntime);
    const blocks = scenario.model.getBlocks(toDocHandle(draftRuntime));
    scenario.model.insertBlocks(
      toDocHandle(draftRuntime),
      blocks[0] ?? null,
      scenario.codec.parse("Inserted between anchors."),
    );
    await scenario.store.appendUpdate({
      draftId: draft.id,
      updateData: Y.encodeStateAsUpdate(draftRuntime, beforeInsert),
      actorTurnId: TURN_A,
    });
    draftRuntime.destroy();

    const preview = await scenario.preview.previewDraft({ documentId: DOC_ID, draftId: draft.id });
    const fullAccept = await scenario.service.acceptDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      draftId: draft.id,
      userId: USER_ID,
      draftRevisionToken: preview.draftRevisionToken,
    });
    expect(fullAccept).toMatchObject({ status: "applied" });
    await scenario.service.undoAcceptDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      draftId: draft.id,
      userId: USER_ID,
    });
    await replaceLiveMarkdown(scenario, "Writer replacement.");

    const afterUndo = await scenario.preview.previewDraft({
      documentId: DOC_ID,
      draftId: draft.id,
    });
    const inserted = operationContaining(afterUndo, "Inserted between anchors.");
    const result = await scenario.service.acceptDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      draftId: draft.id,
      userId: USER_ID,
      operationIds: [inserted.operationId],
      draftRevisionToken: afterUndo.draftRevisionToken,
      confirmedClosureOperationIds: [inserted.operationId],
      confirmedLiveRevisionToken: afterUndo.liveRevisionToken,
      confirmOverlap: true,
    });

    expect(result).toMatchObject({ status: "cannot_place", draftId: draft.id });
    expect(normalizeMarkdown(await liveMarkdown(scenario))).toBe("Writer replacement.");
  });

  it("acceptance: a single unanchored reactivated insert returns cannot_place against non-empty live", async () => {
    const scenario = await createScenarioWithRealAcceptUndo();
    const draft = await scenario.store.createActiveDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      lastActorTurnId: TURN_A,
      baseLiveUpdateSeq: await scenario.journal.latestUpdateSeq(DOC_ID),
    });
    await scenario.store.markDraftCreatedDocument({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      draftId: draft.id,
    });
    const draftRuntime = await draftRuntimeFromLive(scenario);
    await scenario.store.appendUpdate({
      draftId: draft.id,
      updateData: appendMarkdownBlockInDoc(draftRuntime, scenario, "Only created paragraph."),
      actorTurnId: TURN_A,
    });
    draftRuntime.destroy();

    const preview = await scenario.preview.previewDraft({ documentId: DOC_ID, draftId: draft.id });
    await scenario.service.acceptDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      draftId: draft.id,
      userId: USER_ID,
      draftRevisionToken: preview.draftRevisionToken,
    });
    await scenario.service.undoAcceptDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      draftId: draft.id,
      userId: USER_ID,
    });
    await replaceLiveMarkdown(scenario, "Writer replacement.");

    const afterUndo = await scenario.preview.previewDraft({
      documentId: DOC_ID,
      draftId: draft.id,
    });
    const only = operationContaining(afterUndo, "Only created paragraph.");
    const result = await scenario.service.acceptDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      draftId: draft.id,
      userId: USER_ID,
      operationIds: [only.operationId],
      draftRevisionToken: afterUndo.draftRevisionToken,
      confirmedClosureOperationIds: [only.operationId],
      confirmedLiveRevisionToken: afterUndo.liveRevisionToken,
      confirmOverlap: true,
    });

    expect(result).toMatchObject({ status: "cannot_place", draftId: draft.id });
    expect(normalizeMarkdown(await liveMarkdown(scenario))).toBe("Writer replacement.");
  });

  it("acceptance: whole-draft apply still works after a reactivated insert cannot be placed per-operation", async () => {
    const scenario = await createScenarioWithRealAcceptUndo();
    const draft = await scenario.store.createActiveDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      lastActorTurnId: TURN_A,
      baseLiveUpdateSeq: await scenario.journal.latestUpdateSeq(DOC_ID),
    });
    await scenario.store.markDraftCreatedDocument({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      draftId: draft.id,
    });
    const draftRuntime = await draftRuntimeFromLive(scenario);
    await scenario.store.appendUpdate({
      draftId: draft.id,
      updateData: appendMarkdownBlockInDoc(draftRuntime, scenario, "Only created paragraph."),
      actorTurnId: TURN_A,
    });
    draftRuntime.destroy();

    const preview = await scenario.preview.previewDraft({ documentId: DOC_ID, draftId: draft.id });
    await scenario.service.acceptDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      draftId: draft.id,
      userId: USER_ID,
      draftRevisionToken: preview.draftRevisionToken,
    });
    await scenario.service.undoAcceptDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      draftId: draft.id,
      userId: USER_ID,
    });
    await replaceLiveMarkdown(scenario, "Writer replacement.");

    const afterUndo = await scenario.preview.previewDraft({
      documentId: DOC_ID,
      draftId: draft.id,
    });
    const fullApply = await scenario.service.acceptDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      draftId: draft.id,
      userId: USER_ID,
      draftRevisionToken: afterUndo.draftRevisionToken,
      confirmedLiveRevisionToken: afterUndo.liveRevisionToken,
      confirmOverlap: true,
    });

    expect(fullApply).toMatchObject({ status: "applied", draftId: draft.id });
    expect(normalizeMarkdown(await liveMarkdown(scenario))).toBe(
      "Writer replacement.\n\nOnly created paragraph.",
    );
  });

  it("acceptance: whole-draft apply moves a block without duplicating the original", async () => {
    const { scenario, draft } = await reactivatedDraftFromBlockMutation(moveMiddleBlockToEndInDoc);
    const afterUndo = await scenario.preview.previewDraft({
      documentId: DOC_ID,
      draftId: draft.id,
    });

    const applyAll = await scenario.service.acceptDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      draftId: draft.id,
      userId: USER_ID,
      draftRevisionToken: afterUndo.draftRevisionToken,
      confirmedLiveRevisionToken: afterUndo.liveRevisionToken,
      confirmOverlap: true,
    });

    expect(applyAll).toMatchObject({ status: "applied", draftId: draft.id });
    expect(normalizeMarkdown(await liveMarkdown(scenario))).toBe("A.\n\nC.\n\nB.");
  });

  it("acceptance: fresh-id move/replace re-apply keeps a single moved copy", async () => {
    const { scenario, draft, originalBlocks, restoredBlocks } =
      await reactivatedDraftFromBlockMutation(moveAndReplaceMiddleBlockToEndInDoc);
    expect(originalBlocks.map((block) => block.text)).toEqual(["A.", "B.", "C."]);
    expect(restoredBlocks.map((block) => block.text)).toEqual(["A.", "B.", "C."]);
    expect(restoredBlocks[1]?.id).not.toBe(originalBlocks[1]?.id);

    const afterUndo = await scenario.preview.previewDraft({
      documentId: DOC_ID,
      draftId: draft.id,
    });
    const unconfirmed = await scenario.service.acceptDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      draftId: draft.id,
      userId: USER_ID,
      draftRevisionToken: afterUndo.draftRevisionToken,
      confirmedLiveRevisionToken: afterUndo.liveRevisionToken,
    });
    const applyAll =
      unconfirmed.status === "overlap"
        ? await scenario.service.acceptDraft({
            documentId: DOC_ID,
            threadId: THREAD_ID,
            draftId: draft.id,
            userId: USER_ID,
            draftRevisionToken: afterUndo.draftRevisionToken,
            confirmedLiveRevisionToken: unconfirmed.liveRevisionToken,
            confirmOverlap: true,
          })
        : unconfirmed;

    expect(applyAll).toMatchObject({ status: "applied", draftId: draft.id });
    const live = normalizeMarkdown(await liveMarkdown(scenario));
    expect(live).toBe("A.\n\nC.\n\nB′.");
    expect(live.match(/B′\./g)).toHaveLength(1);
    expect(live).not.toContain("B.\n\nB′.");
  });

  it("acceptance: fresh-id guarded delete fails closed when the writer changed the target text", async () => {
    const { scenario, draft, originalBlocks, restoredBlocks } =
      await reactivatedDraftFromBlockMutation(moveAndReplaceMiddleBlockToEndInDoc);
    expect(restoredBlocks[1]?.id).not.toBe(originalBlocks[1]?.id);
    await editLiveMiddleBlock(scenario, "B revised by writer.");
    const unchanged = normalizeMarkdown(await liveMarkdown(scenario));

    const afterWriterEdit = await scenario.preview.previewDraft({
      documentId: DOC_ID,
      draftId: draft.id,
    });
    const applyAll = await scenario.service.acceptDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      draftId: draft.id,
      userId: USER_ID,
      draftRevisionToken: afterWriterEdit.draftRevisionToken,
      confirmedLiveRevisionToken: afterWriterEdit.liveRevisionToken,
      confirmOverlap: true,
    });

    expect(applyAll).toMatchObject({ status: "cannot_place", draftId: draft.id });
    expect(normalizeMarkdown(await liveMarkdown(scenario))).toBe(unchanged);
    expect(unchanged).toBe("A.\n\nB revised by writer.\n\nC.");
  });

  it("acceptance: fresh-id guarded delete skips when the writer already deleted the target", async () => {
    const { scenario, draft, originalBlocks, restoredBlocks } =
      await reactivatedDraftFromBlockMutation(moveAndReplaceMiddleBlockToEndInDoc);
    expect(restoredBlocks[1]?.id).not.toBe(originalBlocks[1]?.id);
    await deleteLiveMiddleBlock(scenario);

    const afterWriterDelete = await scenario.preview.previewDraft({
      documentId: DOC_ID,
      draftId: draft.id,
    });
    const applyAll = await scenario.service.acceptDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      draftId: draft.id,
      userId: USER_ID,
      draftRevisionToken: afterWriterDelete.draftRevisionToken,
      confirmedLiveRevisionToken: afterWriterDelete.liveRevisionToken,
      confirmOverlap: true,
    });

    expect(applyAll).toMatchObject({ status: "applied", draftId: draft.id });
    expect(normalizeMarkdown(await liveMarkdown(scenario))).toBe("A.\n\nC.\n\nB′.");
  });

  it("acceptance: stable-id pending delete fails closed after writer edits the target", async () => {
    const scenario = await createScenarioWithRealAcceptUndo();
    await replaceLiveMarkdown(scenario, "A.\n\nB.\n\nC.");
    const originalBlocks = await liveBlockSummaries(scenario);
    const draft = await scenario.store.createActiveDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      lastActorTurnId: TURN_A,
      baseLiveUpdateSeq: await scenario.journal.latestUpdateSeq(DOC_ID),
    });
    const draftRuntime = await draftRuntimeFromLive(scenario);
    await scenario.store.appendUpdate({
      draftId: draft.id,
      updateData: appendMarkdownBlockInDoc(draftRuntime, scenario, "D accepted once."),
      actorTurnId: TURN_A,
    });
    await scenario.store.appendUpdate({
      draftId: draft.id,
      updateData: deleteMiddleBlockInDoc(scenario, draftRuntime),
      actorTurnId: TURN_B,
    });
    draftRuntime.destroy();

    const reactivation = await scenario.store.claimMutation({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      draftId: draft.id,
      kind: "reactivation",
      fromStatuses: ["active"],
    });
    if (reactivation.status !== "claimed") throw new Error("expected reactivation claim");
    await scenario.store.finishClaimedMutation({
      lease: reactivation.lease,
      targetStatus: "active",
      baseLiveUpdateSeq: await scenario.journal.latestUpdateSeq(DOC_ID),
    });
    expect((await scenario.store.getDraft(draft.id))?.acceptGeneration).toBe(1);
    const afterGenerationBumpBlocks = await liveBlockSummaries(scenario);
    expect(afterGenerationBumpBlocks[1]?.id).toBe(originalBlocks[1]?.id);

    await editLiveMiddleBlock(scenario, "B revised by writer.");
    const unchanged = normalizeMarkdown(await liveMarkdown(scenario));

    const afterWriterEdit = await scenario.preview.previewDraft({
      documentId: DOC_ID,
      draftId: draft.id,
    });
    const deleteResult = await scenario.service.acceptDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      draftId: draft.id,
      userId: USER_ID,
      draftRevisionToken: afterWriterEdit.draftRevisionToken,
      confirmedLiveRevisionToken: afterWriterEdit.liveRevisionToken,
      confirmOverlap: true,
    });

    expect(deleteResult).toMatchObject({ status: "cannot_place", draftId: draft.id });
    expect(normalizeMarkdown(await liveMarkdown(scenario))).toBe(unchanged);
    expect(unchanged).toBe("A.\n\nB revised by writer.\n\nC.");
  });

  it("acceptance: already-deleted target plus unrelated insert does not false cannot_place", async () => {
    const { scenario, draft } = await reactivatedDraftFromBlockMutation(
      moveAndReplaceMiddleBlockToEndInDoc,
    );
    await deleteLiveMiddleBlock(scenario);
    await appendLiveMarkdownBlock(scenario, "D.");

    const afterWriterChanges = await scenario.preview.previewDraft({
      documentId: DOC_ID,
      draftId: draft.id,
    });
    const applyAll = await scenario.service.acceptDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      draftId: draft.id,
      userId: USER_ID,
      draftRevisionToken: afterWriterChanges.draftRevisionToken,
      confirmedLiveRevisionToken: afterWriterChanges.liveRevisionToken,
      confirmOverlap: true,
    });

    expect(applyAll).toMatchObject({ status: "applied", draftId: draft.id });
    const live = normalizeMarkdown(await liveMarkdown(scenario));
    expect(live).toBe("A.\n\nC.\n\nB′.\n\nD.");
    expect(live.match(/B′\./g)).toHaveLength(1);
    expect(live).not.toContain("B.\n\nB′.");
  });

  it("acceptance: whole-draft apply replaces a block without preserving the deleted original", async () => {
    const { scenario, draft } = await reactivatedDraftFromBlockMutation((scenario, doc) =>
      replaceMiddleBlockInDoc(scenario, doc, "D."),
    );
    const afterUndo = await scenario.preview.previewDraft({
      documentId: DOC_ID,
      draftId: draft.id,
    });

    const applyAll = await scenario.service.acceptDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      draftId: draft.id,
      userId: USER_ID,
      draftRevisionToken: afterUndo.draftRevisionToken,
      confirmedLiveRevisionToken: afterUndo.liveRevisionToken,
      confirmOverlap: true,
    });

    expect(applyAll).toMatchObject({ status: "applied", draftId: draft.id });
    expect(normalizeMarkdown(await liveMarkdown(scenario))).toBe("A.\n\nD.\n\nC.");
  });

  it("acceptance: whole-draft guarded delete aborts atomically when the writer modified the target block", async () => {
    const { scenario, draft } = await reactivatedDraftFromBlockMutation(deleteMiddleBlockInDoc);
    await editLiveMiddleBlock(scenario, "B revised by writer.");
    const unchanged = normalizeMarkdown(await liveMarkdown(scenario));
    const afterWriterEdit = await scenario.preview.previewDraft({
      documentId: DOC_ID,
      draftId: draft.id,
    });

    const applyAll = await scenario.service.acceptDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      draftId: draft.id,
      userId: USER_ID,
      draftRevisionToken: afterWriterEdit.draftRevisionToken,
      confirmedLiveRevisionToken: afterWriterEdit.liveRevisionToken,
      confirmOverlap: true,
    });

    expect(applyAll).toMatchObject({ status: "cannot_place", draftId: draft.id });
    expect(normalizeMarkdown(await liveMarkdown(scenario))).toBe(unchanged);
    expect(unchanged).toBe("A.\n\nB revised by writer.\n\nC.");
  });

  it("acceptance: whole-draft guarded delete skips an already-deleted target before inserting the moved copy", async () => {
    const { scenario, draft } = await reactivatedDraftFromBlockMutation(moveMiddleBlockToEndInDoc);
    await deleteLiveMiddleBlock(scenario);
    const afterWriterDelete = await scenario.preview.previewDraft({
      documentId: DOC_ID,
      draftId: draft.id,
    });

    const applyAll = await scenario.service.acceptDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      draftId: draft.id,
      userId: USER_ID,
      draftRevisionToken: afterWriterDelete.draftRevisionToken,
      confirmedLiveRevisionToken: afterWriterDelete.liveRevisionToken,
      confirmOverlap: true,
    });

    expect(applyAll).toMatchObject({ status: "applied", draftId: draft.id });
    expect(normalizeMarkdown(await liveMarkdown(scenario))).toBe("A.\n\nC.\n\nB.");
  });

  it("acceptance: whole-draft apply into an empty reactivated target inserts draft content in order", async () => {
    const scenario = await createScenarioWithRealAcceptUndo();
    const draft = await scenario.store.createActiveDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      lastActorTurnId: TURN_A,
      baseLiveUpdateSeq: await scenario.journal.latestUpdateSeq(DOC_ID),
    });
    await scenario.store.markDraftCreatedDocument({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      draftId: draft.id,
    });
    const draftRuntime = await draftRuntimeFromLive(scenario);
    for (const [markdown, turnId] of [
      ["# Created chapter", TURN_A],
      ["First created paragraph.", TURN_A],
      ["Second created paragraph.", TURN_B],
    ] as const) {
      await scenario.store.appendUpdate({
        draftId: draft.id,
        updateData: appendMarkdownBlockInDoc(draftRuntime, scenario, markdown),
        actorTurnId: turnId,
      });
    }
    draftRuntime.destroy();

    const preview = await scenario.preview.previewDraft({ documentId: DOC_ID, draftId: draft.id });
    await scenario.service.acceptDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      draftId: draft.id,
      userId: USER_ID,
      draftRevisionToken: preview.draftRevisionToken,
    });
    await scenario.service.undoAcceptDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      draftId: draft.id,
      userId: USER_ID,
    });
    expect(await liveMarkdown(scenario)).toBe("");

    const afterUndo = await scenario.preview.previewDraft({
      documentId: DOC_ID,
      draftId: draft.id,
    });
    const applyAll = await scenario.service.acceptDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      draftId: draft.id,
      userId: USER_ID,
      draftRevisionToken: afterUndo.draftRevisionToken,
    });

    expect(applyAll).toMatchObject({ status: "applied", draftId: draft.id });
    expect(normalizeMarkdown(await liveMarkdown(scenario))).toBe(
      "# Created chapter\n\nFirst created paragraph.\n\nSecond created paragraph.",
    );
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

  it("acceptance: confirmed whole-draft apply returns cannot_place atomically when text remapping is unresolvable", async () => {
    const scenario = await createScenarioWithRealAcceptUndo();
    await replaceLiveMarkdown(scenario, "The blue lantern glowed.");
    const draft = await scenario.store.createActiveDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      lastActorTurnId: TURN_A,
      baseLiveUpdateSeq: await scenario.journal.latestUpdateSeq(DOC_ID),
    });
    const draftRuntime = await draftRuntimeFromLive(scenario);
    const before = Y.encodeStateVector(draftRuntime);
    const [block] = scenario.model.getBlocks(toDocHandle(draftRuntime));
    if (!block) throw new Error("expected draft block");
    scenario.model.applyTextEdit(toDocHandle(draftRuntime), block, { from: 4, to: 8 }, "red");
    await scenario.store.appendUpdate({
      draftId: draft.id,
      updateData: Y.encodeStateAsUpdate(draftRuntime, before),
      actorTurnId: TURN_A,
    });
    draftRuntime.destroy();

    const preview = await scenario.preview.previewDraft({ documentId: DOC_ID, draftId: draft.id });
    await scenario.service.acceptDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      draftId: draft.id,
      userId: USER_ID,
      draftRevisionToken: preview.draftRevisionToken,
    });
    await scenario.service.undoAcceptDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      draftId: draft.id,
      userId: USER_ID,
    });
    await replaceLiveSubstrings(scenario, [
      ["The blue lantern glowed.", "A rewritten live sentence with no matching span."],
    ]);
    const unchanged = normalizeMarkdown(await liveMarkdown(scenario));
    const afterUndo = await scenario.preview.previewDraft({
      documentId: DOC_ID,
      draftId: draft.id,
    });

    const result = await scenario.service.acceptDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      draftId: draft.id,
      userId: USER_ID,
      draftRevisionToken: afterUndo.draftRevisionToken,
      confirmedLiveRevisionToken: afterUndo.liveRevisionToken,
      confirmOverlap: true,
    });

    expect(result).toMatchObject({ status: "cannot_place", draftId: draft.id });
    expect(normalizeMarkdown(await liveMarkdown(scenario))).toBe(unchanged);
  });

  it("returns overlap instead of silently replacing a concurrently edited span", async () => {
    const scenario = await createScenarioWithRealAcceptUndo();
    await replaceLiveMarkdown(scenario, "The blue lantern glowed.");
    const draft = await scenario.store.createActiveDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      lastActorTurnId: TURN_A,
      baseLiveUpdateSeq: await scenario.journal.latestUpdateSeq(DOC_ID),
    });
    const draftRuntime = await draftRuntimeFromLive(scenario);
    const before = Y.encodeStateVector(draftRuntime);
    const [block] = scenario.model.getBlocks(toDocHandle(draftRuntime));
    scenario.model.applyTextEdit(toDocHandle(draftRuntime), block, { from: 4, to: 8 }, "red");
    await scenario.store.appendUpdate({
      draftId: draft.id,
      updateData: Y.encodeStateAsUpdate(draftRuntime, before),
      actorTurnId: TURN_A,
    });
    draftRuntime.destroy();
    const preview = await scenario.preview.previewDraft({ documentId: DOC_ID, draftId: draft.id });
    await scenario.service.acceptDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      draftId: draft.id,
      userId: USER_ID,
      draftRevisionToken: preview.draftRevisionToken,
    });
    await scenario.service.undoAcceptDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      draftId: draft.id,
      userId: USER_ID,
    });
    await replaceLiveMarkdown(scenario, "A rewritten live sentence with no matching span.");

    const afterUndo = await scenario.preview.previewDraft({
      documentId: DOC_ID,
      draftId: draft.id,
    });
    const red = operationContaining(afterUndo, "red lantern");
    const result = await scenario.service.acceptDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      draftId: draft.id,
      userId: USER_ID,
      operationIds: [red.operationId],
      draftRevisionToken: afterUndo.draftRevisionToken,
      confirmedClosureOperationIds: [red.operationId],
      confirmedLiveRevisionToken: afterUndo.liveRevisionToken,
    });

    expect(result).toMatchObject({ status: "overlap", draftId: draft.id });
    expect(normalizeMarkdown(await liveMarkdown(scenario))).toBe(
      "A rewritten live sentence with no matching span.",
    );

    const confirmed = await scenario.service.acceptDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      draftId: draft.id,
      userId: USER_ID,
      operationIds: [red.operationId],
      draftRevisionToken: afterUndo.draftRevisionToken,
      confirmedClosureOperationIds: [red.operationId],
      confirmedLiveRevisionToken: afterUndo.liveRevisionToken,
      confirmOverlap: true,
    });

    expect(confirmed).toMatchObject({ status: "cannot_place", draftId: draft.id });
    expect(normalizeMarkdown(await liveMarkdown(scenario))).toBe(
      "A rewritten live sentence with no matching span.",
    );
  });

  it("keeps confirmed same-block reactivation accepts span-local", async () => {
    const scenario = await createScenarioWithRealAcceptUndo();
    await replaceLiveMarkdown(scenario, "Alpha base. Beta base. Gamma base.");
    const draft = await scenario.store.createActiveDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      lastActorTurnId: TURN_A,
      baseLiveUpdateSeq: await scenario.journal.latestUpdateSeq(DOC_ID),
    });
    const draftRuntime = await draftRuntimeFromLive(scenario);
    const before = Y.encodeStateVector(draftRuntime);
    const [block] = scenario.model.getBlocks(toDocHandle(draftRuntime));
    scenario.model.applyTextEdit(
      toDocHandle(draftRuntime),
      block,
      { from: 12, to: 21 },
      "Beta draft",
    );
    await scenario.store.appendUpdate({
      draftId: draft.id,
      updateData: Y.encodeStateAsUpdate(draftRuntime, before),
      actorTurnId: TURN_A,
    });
    draftRuntime.destroy();

    const preview = await scenario.preview.previewDraft({ documentId: DOC_ID, draftId: draft.id });
    await scenario.service.acceptDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      draftId: draft.id,
      userId: USER_ID,
      draftRevisionToken: preview.draftRevisionToken,
    });
    await scenario.service.undoAcceptDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      draftId: draft.id,
      userId: USER_ID,
    });
    await replaceLiveSubstrings(scenario, [
      ["Alpha base", "Alpha live"],
      ["Beta base", "Beta live"],
      ["Gamma base", "Gamma live"],
    ]);

    const afterUndo = await scenario.preview.previewDraft({
      documentId: DOC_ID,
      draftId: draft.id,
    });
    const beta = operationContaining(afterUndo, "draft");
    const unconfirmed = await scenario.service.acceptDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      draftId: draft.id,
      userId: USER_ID,
      operationIds: [beta.operationId],
      draftRevisionToken: afterUndo.draftRevisionToken,
      confirmedClosureOperationIds: [beta.operationId],
      confirmedLiveRevisionToken: afterUndo.liveRevisionToken,
    });
    expect(unconfirmed).toMatchObject({ status: "overlap", draftId: draft.id });

    const confirmed = await scenario.service.acceptDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      draftId: draft.id,
      userId: USER_ID,
      operationIds: [beta.operationId],
      draftRevisionToken: afterUndo.draftRevisionToken,
      confirmedClosureOperationIds: [beta.operationId],
      confirmedLiveRevisionToken: afterUndo.liveRevisionToken,
      confirmOverlap: true,
    });
    expect(confirmed).toMatchObject({ status: "partial_applied" });
    if (confirmed.status !== "partial_applied") throw new Error("expected partial accept");
    await expect(
      scenario.liveJournal.findAcceptedDraftAppend({
        documentId: DOC_ID,
        threadId: THREAD_ID,
        writeId: confirmed.writeId,
      }),
    ).resolves.toMatchObject({ writeId: confirmed.writeId });
    expect(normalizeMarkdown(await liveMarkdown(scenario))).toBe(
      "Alpha live. Beta draft. Gamma live.",
    );
  });

  it("keeps repeated inserted paragraphs instead of collapsing by text equality", async () => {
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
      updateData: appendMarkdownBlockInDoc(draftRuntime, scenario, "Echo."),
      actorTurnId: TURN_A,
    });
    draftRuntime.destroy();
    const preview = await scenario.preview.previewDraft({ documentId: DOC_ID, draftId: draft.id });
    const echo = operationContaining(preview, "Echo.");
    const accept = await scenario.service.acceptDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      draftId: draft.id,
      userId: USER_ID,
      operationIds: [echo.operationId],
      draftRevisionToken: preview.draftRevisionToken,
      confirmedClosureOperationIds: [echo.operationId],
      confirmedLiveRevisionToken: preview.liveRevisionToken,
    });
    if (accept.status !== "partial_applied") throw new Error("expected partial accept");
    await scenario.service.undoAcceptDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      draftId: draft.id,
      userId: USER_ID,
      writeId: accept.writeId,
    });
    await appendLiveMarkdownBlock(scenario, "Echo.");

    const afterUndo = await scenario.preview.previewDraft({
      documentId: DOC_ID,
      draftId: draft.id,
    });
    const reaccept = await scenario.service.acceptDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      draftId: draft.id,
      userId: USER_ID,
      draftRevisionToken: afterUndo.draftRevisionToken,
      confirmOverlap: true,
      confirmedLiveRevisionToken: afterUndo.liveRevisionToken,
    });

    expect(reaccept).toMatchObject({ status: "applied" });
    expect(normalizeMarkdown(await liveMarkdown(scenario))).toBe("Seed.\n\nEcho.\n\nEcho.");
  });

  it("anchors later reactivated inserts through structural neighbors instead of repeated text", async () => {
    const scenario = await createScenarioWithRealAcceptUndo();
    await replaceLiveMarkdown(scenario, "Echo.\n\nEcho.\n\nEcho.");
    const draft = await scenario.store.createActiveDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      lastActorTurnId: TURN_A,
      baseLiveUpdateSeq: await scenario.journal.latestUpdateSeq(DOC_ID),
    });
    const draftRuntime = await draftRuntimeFromLive(scenario);
    let before = Y.encodeStateVector(draftRuntime);
    let blocks = scenario.model.getBlocks(toDocHandle(draftRuntime));
    scenario.model.insertBlocks(
      toDocHandle(draftRuntime),
      blocks[1] ?? null,
      scenario.codec.parse("Echo."),
    );
    await scenario.store.appendUpdate({
      draftId: draft.id,
      updateData: Y.encodeStateAsUpdate(draftRuntime, before),
      actorTurnId: TURN_A,
    });
    before = Y.encodeStateVector(draftRuntime);
    blocks = scenario.model.getBlocks(toDocHandle(draftRuntime));
    scenario.model.insertBlocks(
      toDocHandle(draftRuntime),
      blocks[2] ?? null,
      scenario.codec.parse("Child."),
    );
    await scenario.store.appendUpdate({
      draftId: draft.id,
      updateData: Y.encodeStateAsUpdate(draftRuntime, before),
      actorTurnId: TURN_B,
    });
    draftRuntime.destroy();
    const rows = await scenario.store.listUpdates(draft.id);

    const preview = await scenario.preview.previewDraft({ documentId: DOC_ID, draftId: draft.id });
    await scenario.service.acceptDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      draftId: draft.id,
      userId: USER_ID,
      draftRevisionToken: preview.draftRevisionToken,
    });
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
    const echoInsert = afterUndo.operations?.find((operation) =>
      operation.sourceUpdateIds.includes(rows[0]?.id ?? -1),
    );
    if (!echoInsert) throw new Error("expected repeated paragraph insert operation");
    const firstAccept = await scenario.service.acceptDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      draftId: draft.id,
      userId: USER_ID,
      operationIds: [echoInsert.operationId],
      draftRevisionToken: afterUndo.draftRevisionToken,
      confirmedClosureOperationIds: [echoInsert.operationId],
      confirmedLiveRevisionToken: afterUndo.liveRevisionToken,
    });
    expect(firstAccept).toMatchObject({ status: "partial_applied" });

    const afterFirst = await scenario.preview.previewDraft({
      documentId: DOC_ID,
      draftId: draft.id,
    });
    const child = afterFirst.operations?.find((operation) =>
      operation.sourceUpdateIds.includes(rows[1]?.id ?? -1),
    );
    if (!child) throw new Error("expected child insert operation");
    const childUnconfirmed = await scenario.service.acceptDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      draftId: draft.id,
      userId: USER_ID,
      operationIds: [child.operationId],
      draftRevisionToken: afterFirst.draftRevisionToken,
      confirmedClosureOperationIds: [child.operationId],
      confirmedLiveRevisionToken: afterFirst.liveRevisionToken,
      confirmOverlap: true,
    });
    const childAccept =
      childUnconfirmed.status === "closure_confirmation_required"
        ? await scenario.service.acceptDraft({
            documentId: DOC_ID,
            threadId: THREAD_ID,
            draftId: draft.id,
            userId: USER_ID,
            operationIds: [child.operationId],
            draftRevisionToken: afterFirst.draftRevisionToken,
            confirmedClosureOperationIds: childUnconfirmed.closureOperationIds,
            confirmedLiveRevisionToken: childUnconfirmed.liveRevisionToken,
            confirmOverlap: true,
          })
        : childUnconfirmed;
    expect(childAccept).toMatchObject({ status: "partial_applied" });
    expect(normalizeMarkdown(await liveMarkdown(scenario))).toBe(
      "Echo.\n\nEcho.\n\nEcho.\n\nChild.\n\nEcho.",
    );
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

  it("returns idempotent success when retrying the same partial accept", async () => {
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
      updateData: appendMarkdownBlockInDoc(draftRuntime, scenario, "Alpha."),
      actorTurnId: TURN_A,
    });
    await scenario.store.appendUpdate({
      draftId: draft.id,
      updateData: appendMarkdownBlockInDoc(draftRuntime, scenario, "Beta."),
      actorTurnId: TURN_B,
    });
    draftRuntime.destroy();
    const preview = await scenario.preview.previewDraft({ documentId: DOC_ID, draftId: draft.id });
    const alpha = operationContaining(preview, "Alpha.");
    const request = {
      documentId: DOC_ID,
      threadId: THREAD_ID,
      draftId: draft.id,
      userId: USER_ID,
      operationIds: [alpha.operationId],
      draftRevisionToken: preview.draftRevisionToken,
      confirmedClosureOperationIds: [alpha.operationId],
      confirmedLiveRevisionToken: preview.liveRevisionToken,
    };

    const first = await scenario.service.acceptDraft(request);
    expect(first).toMatchObject({ status: "partial_applied" });
    if (first.status !== "partial_applied") throw new Error("expected partial accept");
    const retry = await scenario.service.acceptDraft(request);
    expect(retry).toMatchObject({ status: "partial_applied" });
    expect(
      scenario.journal.mutationRecords(DOC_ID).filter((row) => row.writeId === first.writeId),
    ).toHaveLength(1);
    expect((await liveMarkdown(scenario)).match(/Alpha\./g)).toHaveLength(1);
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

  it("derives active partial-accept lifecycle counts from the work primary thread", async () => {
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
      updateData: appendMarkdownBlockInDoc(draftRuntime, scenario, "First proposal."),
      actorTurnId: TURN_A,
    });
    await scenario.store.appendUpdate({
      draftId: draft.id,
      updateData: appendMarkdownBlockInDoc(draftRuntime, scenario, "Second proposal."),
      actorTurnId: TURN_B,
    });
    draftRuntime.destroy();

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

    const afterUndo = await scenario.preview.previewDraft({
      documentId: DOC_ID,
      draftId: draft.id,
    });
    const first = operationContaining(afterUndo, "First proposal.");
    const unconfirmed = await scenario.service.acceptDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      draftId: draft.id,
      userId: USER_ID,
      operationIds: [first.operationId],
      draftRevisionToken: afterUndo.draftRevisionToken,
      confirmOverlap: true,
      confirmedLiveRevisionToken: afterUndo.liveRevisionToken,
    });
    const accepted =
      unconfirmed.status === "closure_confirmation_required"
        ? await scenario.service.acceptDraft({
            documentId: DOC_ID,
            threadId: THREAD_ID,
            draftId: draft.id,
            userId: USER_ID,
            operationIds: [first.operationId],
            draftRevisionToken: afterUndo.draftRevisionToken,
            confirmOverlap: true,
            confirmedClosureOperationIds: unconfirmed.closureOperationIds,
            confirmedLiveRevisionToken: unconfirmed.liveRevisionToken,
          })
        : unconfirmed;
    expect(accepted).toMatchObject({ status: "partial_applied" });

    vi.spyOn(scenario.store, "resolveDraftThreadId").mockResolvedValue("sibling-thread" as never);
    const states = await scenario.service.listLifecycleStateByWork({ workId: WORK_ID });
    expect(states.find((state) => state.draftId === draft.id)).toMatchObject({
      partialAcceptedOperationCount: 1,
      proposedOperationCount: 2,
    });
  });
});
