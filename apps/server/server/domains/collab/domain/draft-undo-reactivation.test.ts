/** Integration coverage for draft undo, reactivation, partial accept, and causal closure. */

import { createCollabYDoc } from "@meridian/prosemirror-schema";
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  acceptMutationWriteIds,
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

describe("draft undo and reactivation", () => {
  it.each([
    {
      name: "created document",
      createdDocument: true,
      baseMarkdown: "",
      draftMarkdown: "Chapter born from draft.",
    },
    {
      name: "normal edit",
      createdDocument: false,
      baseMarkdown: "Live chapter seed.",
      draftMarkdown: "Live chapter seed. Draft continuation.",
    },
  ])("reactivates and rebases an accepted $name draft so preview and re-accept work", async ({
    createdDocument,
    baseMarkdown,
    draftMarkdown,
  }) => {
    const reverseToMarkdown = baseMarkdown;
    let undoReversalWriteId: string | undefined;
    const scenario = await createScenario({
      reverseAcceptedDraft: async ({ writeId }) => {
        expect(writeId).toMatch(/^draft-accept:.+:\d+$/);
        undoReversalWriteId = writeId;
        await replaceLiveMarkdown(scenario, reverseToMarkdown);
        return "reversed";
      },
    });
    if (baseMarkdown) await replaceLiveMarkdown(scenario, baseMarkdown);
    const baseLiveUpdateSeq = await scenario.journal.latestUpdateSeq(DOC_ID);
    const draft = await scenario.store.createActiveDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      lastActorTurnId: TURN_A,
      baseLiveUpdateSeq,
    });
    if (createdDocument) {
      await scenario.store.markDraftCreatedDocument({ documentId: DOC_ID, threadId: THREAD_ID });
    }
    await scenario.store.appendUpdate({
      draftId: draft.id,
      updateData: await updateFromMarkdownOverLive(scenario, draftMarkdown),
      actorTurnId: TURN_A,
    });

    const beforePreview = await scenario.preview.previewDraft({
      documentId: DOC_ID,
      draftId: draft.id,
    });
    expect(normalizeMarkdown(beforePreview.markdown)).toBe(draftMarkdown);
    expect(reviewChangeCount(beforePreview)).toBeGreaterThan(0);

    const firstAccept = await scenario.service.acceptDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      draftId: draft.id,
      userId: USER_ID,
    });
    expect(firstAccept).toMatchObject({ status: "applied", draftId: draft.id });
    expect(normalizeMarkdown(await liveMarkdown(scenario))).toBe(draftMarkdown);

    await expect(
      scenario.service.undoAcceptDraft({
        documentId: DOC_ID,
        threadId: THREAD_ID,
        draftId: draft.id,
        userId: USER_ID,
      }),
    ).resolves.toEqual({ status: "reactivated", draftId: draft.id });
    expect(undoReversalWriteId).toMatch(/^draft-accept:.+:\d+$/);
    expect(normalizeMarkdown(await liveMarkdown(scenario))).toBe(baseMarkdown);

    const afterPreview = await scenario.preview.previewDraft({
      documentId: DOC_ID,
      draftId: draft.id,
    });
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
    expect(afterPreview.live).toBe(beforePreview.live);
    expect(normalizeMarkdown(afterPreview.markdown)).toBe(
      normalizeMarkdown(beforePreview.markdown),
    );
    expect(reviewChangeCount(afterPreview)).toBeGreaterThan(0);
    await expect(scenario.store.getDraft(draft.id)).resolves.toMatchObject({
      status: "active",
      baseLiveUpdateSeq: await scenario.journal.latestUpdateSeq(DOC_ID),
      acceptGeneration: 2,
    });

    const updateCountBeforeReaccept = scenario.journal.updateRecords(DOC_ID).length;
    const secondAccept = await scenario.service.acceptDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      draftId: draft.id,
      userId: USER_ID,
    });
    expect(secondAccept).toMatchObject({ status: "applied", draftId: draft.id });
    expect(scenario.journal.updateRecords(DOC_ID)).toHaveLength(updateCountBeforeReaccept + 1);
    const acceptWriteIds = acceptMutationWriteIds(scenario.journal);
    expect(acceptWriteIds).toHaveLength(2);
    expect(new Set(acceptWriteIds).size).toBe(2);
    expect(normalizeMarkdown(await liveMarkdown(scenario))).toBe(draftMarkdown);
  });

  it("rebases partial-accept undo so the undone op returns and unrelated accepted ops stay applied", async () => {
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
    const updateCountBeforeUndo = scenario.journal.updateRecords(DOC_ID).length;
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
      baseLiveUpdateSeq: await scenario.journal.latestUpdateSeq(DOC_ID),
      acceptGeneration: 2,
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
    expect(afterUndo.operations).toHaveLength(2);
    expect(operationMaybeContaining(afterUndo, "Alpha accepted.")).toBeNull();
    expect(operationContaining(afterUndo, "Beta undone.")).toMatchObject({
      operationId: expect.any(String),
    });
    expect(operationContaining(afterUndo, "Gamma pending.")).toMatchObject({
      operationId: expect.any(String),
    });
    expect(reviewChangeCount(afterUndo)).toBeGreaterThan(0);

    const [restoredBeta] = afterUndo.operations ?? [];
    if (!restoredBeta) throw new Error("expected restored partial operation");
    const betaReaccept = await scenario.service.acceptDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      draftId: draft.id,
      userId: USER_ID,
      operationIds: [restoredBeta.operationId],
      draftRevisionToken: afterUndo.draftRevisionToken,
    });
    expect(betaReaccept).toMatchObject({ status: "partial_applied" });
    if (betaReaccept.status !== "partial_applied") throw new Error("expected beta reaccept");
    expect(betaReaccept.writeId).not.toBe(betaWriteId);
    expect(scenario.journal.updateRecords(DOC_ID)).toHaveLength(updateCountBeforeUndo + 2);
    expect(normalizeMarkdown(await liveMarkdown(scenario))).toBe(
      "Seed.\n\nAlpha accepted.\n\nBeta undone.",
    );
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
      confirmedClosure: true,
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

  it("preserves per-row actors when undoing a full accept", async () => {
    const liveAfterUndo = "Seed.";
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
    await scenario.store.appendUpdate({
      draftId: draft.id,
      updateData: appendMarkdownBlockInDoc(draftRuntime, scenario, "Agent proposal."),
      actorTurnId: TURN_A,
    });
    await scenario.store.appendUpdate({
      draftId: draft.id,
      updateData: appendMarkdownBlockInDoc(draftRuntime, scenario, "Writer note."),
      actorUserId: USER_ID,
    });
    draftRuntime.destroy();
    const beforeAccept = await scenario.preview.previewDraft({
      documentId: DOC_ID,
      draftId: draft.id,
    });
    expect(operationContaining(beforeAccept, "Agent proposal.")).toMatchObject({
      operationId: expect.any(String),
    });
    expect(operationContaining(beforeAccept, "Writer note.")).toMatchObject({
      operationId: expect.stringContaining("writer:"),
    });

    const accept = await scenario.service.acceptDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      draftId: draft.id,
      userId: USER_ID,
      draftRevisionToken: beforeAccept.draftRevisionToken,
    });
    expect(accept).toMatchObject({ status: "applied" });
    await expect(
      scenario.service.undoAcceptDraft({
        documentId: DOC_ID,
        threadId: THREAD_ID,
        draftId: draft.id,
        userId: USER_ID,
      }),
    ).resolves.toEqual({ status: "reactivated", draftId: draft.id });

    const afterUndo = await scenario.preview.previewDraft({
      documentId: DOC_ID,
      draftId: draft.id,
    });
    const agent = operationContaining(afterUndo, "Agent proposal.");
    const writer = operationContaining(afterUndo, "Writer note.");
    expect(afterUndo.operations).toHaveLength(2);
    expect(agent.operationId).not.toContain("writer:");
    expect(writer.operationId).toContain("writer:");
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
    ).resolves.toEqual({ status: "conflict", draftId: draft.id });

    await expect(scenario.store.getDraft(draft.id)).resolves.toMatchObject({
      status: "applied",
      acceptGeneration: 1,
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
      confirmedClosure: true,
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
    ).resolves.toEqual({ status: "conflict", draftId: draft.id });

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
      confirmedClosure: true,
    });
    if (accept.status !== "partial_applied") throw new Error("expected partial accept");
    await scenario.store.reactivate({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      draftId: draft.id,
      fromStatus: "active",
    });
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
      confirmedClosure: true,
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
    const events = await scenario.store.listLifecycleEventsByWorkSince({
      workId: WORK_ID,
      since: undoneAt ?? null,
    });
    expect(events.filter((event) => event.status === "undone")).toHaveLength(1);
  });
});
