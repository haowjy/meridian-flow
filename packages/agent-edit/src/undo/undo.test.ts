// Parity and reconcile coverage for hot UndoManagers and cold journal reconstruction.
import { buildDocumentSchema, PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
import { describe, expect, it } from "vitest";
import { prosemirrorToYXmlFragment } from "y-prosemirror";
import * as Y from "yjs";
import { applyEdits } from "../apply/tiers.js";
import type { ApplyResult, ResolvedEdit } from "../apply/types.js";
import { mdxCodec } from "../codec/presets/mdx.js";
import { yProsemirrorModel } from "../model/y-prosemirror.js";
import type { UpdateMeta } from "../ports/types.js";
import { InMemoryAgentEditJournal } from "../test-support/index.js";
import { compactOnLoad } from "./compaction.js";
import {
  createUndoManagerRegistry,
  type UndoManagerRegistry,
  type UndoManagerRegistryOptions,
} from "./manager-registry.js";
import type { RedoReconstructionResult } from "./reconstruction.js";
import {
  groupUpdatesByTurn,
  reconstructRedoUpdateFromSnapshot,
  reconstructUndoUpdateFromSnapshot,
} from "./reconstruction.js";

const schema = buildDocumentSchema();
const codec = mdxCodec({ schema });
const model = yProsemirrorModel(schema);
const DOC_ID = "doc-1";
const FILE = "chapter.md";
const THREAD_A = "thread-a";
const THREAD_B = "thread-b";
const LIVE_CLIENT_ID = 100;
const REVERSAL_CLIENT_ID = 9_999;

describe("UndoManagerRegistry hot path", () => {
  it("returns the same thread origin object across turns and splits with stopCapturing", () => {
    const ctx = createScenario("Alpha sword.\n\nBeta waits.");
    const originBefore = ctx.registry.getThreadOrigin(DOC_ID, THREAD_A);

    agentTurn(ctx, THREAD_A, "turn-1", () => {
      const entry = ctx.registry.getOrCreate(DOC_ID, THREAD_A, ctx.doc);
      expect(entry.origin).toBe(originBefore);
      applyAgentText(ctx, THREAD_A, 0, { start: 6, end: 11 }, "blade");
    });
    agentTurn(ctx, THREAD_A, "turn-2", () => {
      const entry = ctx.registry.getOrCreate(DOC_ID, THREAD_A, ctx.doc);
      expect(entry.origin).toBe(originBefore);
      applyAgentText(ctx, THREAD_A, 1, { start: 5, end: 10 }, "marches");
    });

    expect(ctx.registry.getThreadOrigin(DOC_ID, THREAD_A)).toBe(originBefore);
    expect(ctx.registry.getState(DOC_ID, THREAD_A)?.undoStack.map((item) => item.turnId)).toEqual([
      "turn-1",
      "turn-2",
    ]);
  });

  it("clears the redo stack on a new forward edit", () => {
    const ctx = createScenario("Alpha sword.\n\nBeta waits.");
    agentTurn(ctx, THREAD_A, "turn-1", () => {
      applyAgentText(ctx, THREAD_A, 0, { start: 6, end: 11 }, "blade");
    });
    const undone = ctx.registry.undoLatest(DOC_ID, THREAD_A, { scope: "turn", turnId: "turn-1" });
    expect(undone).toMatchObject({ ok: true, redoDepth: 1 });

    agentTurn(ctx, THREAD_A, "turn-2", () => {
      applyAgentText(ctx, THREAD_A, 1, { start: 5, end: 10 }, "marches");
    });

    expect(ctx.registry.getState(DOC_ID, THREAD_A)?.redoStack).toEqual([]);
  });

  it("completes a turn after undo-depth cap expiry and leaves cold fallback available", () => {
    const ctx = createScenario("Alpha sword.", { undoDepthCap: 0 });
    ctx.registry.beginTurn(DOC_ID, THREAD_A, ctx.doc, "capped-turn");
    capture(ctx, { origin: "agent:capped-turn", actorTurnId: "capped-turn" }, () => {
      applyAgentText(ctx, THREAD_A, 0, { start: 6, end: 11 }, "blade");
    });

    const endState = ctx.registry.endTurn(DOC_ID, THREAD_A, "capped-turn");

    expect(endState.fallback).toEqual({ reason: "undo_depth_cap", undoDepth: 1, cap: 0 });
    expect(ctx.registry.getState(DOC_ID, THREAD_A)).toBeNull();
    expect(
      ctx.registry.undoLatest(DOC_ID, THREAD_A, { scope: "turn", turnId: "capped-turn" }),
    ).toMatchObject({ ok: false, status: "no_manager" });

    const cold = reconstructUndoUpdateFromSnapshot(ctx.journal.snapshot(DOC_ID), {
      docId: DOC_ID,
      turnId: "capped-turn",
      targetSeqs: targetSeqsForTurn(ctx.journal, "capped-turn"),
      undoClientId: REVERSAL_CLIENT_ID,
    });
    const coldDoc = cloneDoc(ctx.doc, LIVE_CLIENT_ID);
    Y.applyUpdate(coldDoc, cold.undoUpdate);
    expect(blockTexts(coldDoc)).toEqual(["Alpha sword."]);
  });

  it("preserves human text inside an agent-inserted paragraph when undoing hot", () => {
    const ctx = createScenario("Alpha");
    agentTurn(ctx, THREAD_A, "insert-turn", () => {
      applyAgentInsert(ctx, THREAD_A, 0, "Agent seed");
    });
    humanText(ctx, 1, { from: 10, to: 10 }, " + human");

    const result = ctx.registry.undoLatest(DOC_ID, THREAD_A, {
      scope: "turn",
      turnId: "insert-turn",
    });

    expect(result).toMatchObject({ ok: true, turnId: "insert-turn" });
    expect(blockTexts(ctx.doc)).toEqual(["Alpha", " + human"]);
  });
});

describe("cold reconstruction", () => {
  it("captures Y.applyUpdate with the outer doc.transact origin token", () => {
    const source = new Y.Doc({ gc: false });
    const text = source.getText("probe");
    const beforeSource = Y.encodeStateVector(source);
    source.transact(() => text.insert(0, "captured"), Symbol("source"));
    const update = Y.encodeStateAsUpdate(source, beforeSource);

    const token = Symbol("target-turn");
    const replay = new Y.Doc({ gc: false });
    const replayText = replay.getText("probe");
    const seenOrigins: unknown[] = [];
    const um = new Y.UndoManager(replayText, {
      trackedOrigins: new Set([token]),
      captureTimeout: Number.POSITIVE_INFINITY,
    });
    um.on("stack-item-added", (event: { origin: unknown }) => seenOrigins.push(event.origin));

    replay.transact(() => {
      Y.applyUpdate(replay, update);
    }, token);

    expect(seenOrigins).toEqual([token]);
    expect(um.undoStack).toHaveLength(1);
    um.undo();
    expect(replayText.toString()).toBe("");
  });

  it("groups multiple updates per turn by actorTurnId", () => {
    const ctx = createScenario("Alpha sword.\n\nBeta sword.");
    agentTurn(ctx, THREAD_A, "multi", () => {
      applyAgentText(ctx, THREAD_A, 0, { start: 6, end: 11 }, "blade");
      applyAgentText(ctx, THREAD_A, 1, { start: 5, end: 10 }, "blade");
    });

    const groups = groupUpdatesByTurn(ctx.journal.snapshot(DOC_ID).updates);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ turnId: "multi" });
    expect(groups[0]?.updates).toHaveLength(2);
  });
});

describe("hot/cold parity", () => {
  it("undoes T2 with byte-identical final state and matching redo reconstruction", () => {
    const ctx = createScenario("Alpha sword.\n\nBeta waits.\n\nGamma rests.");
    agentTurn(ctx, THREAD_A, "T1", () => {
      applyAgentText(ctx, THREAD_A, 0, { start: 6, end: 11 }, "blade");
    });
    agentTurn(ctx, THREAD_A, "T2", () => {
      applyAgentText(ctx, THREAD_A, 1, { start: 5, end: 10 }, "marches");
    });
    humanText(ctx, 2, { from: 0, to: 5 }, "Delta");

    const preUndoDoc = cloneDoc(ctx.doc, LIVE_CLIENT_ID);
    const preHotUndoVector = Y.encodeStateVector(ctx.doc);
    const hotUndo = ctx.registry.undoLatest(DOC_ID, THREAD_A, {
      scope: "turn",
      turnId: "T2",
      mutationClientId: REVERSAL_CLIENT_ID,
    });
    expect(hotUndo).toMatchObject({ ok: true, turnId: "T2", redoDepth: 1 });
    const hotUndoUpdate = Y.encodeStateAsUpdate(ctx.doc, preHotUndoVector);

    const cold = reconstructUndoUpdateFromSnapshot(ctx.journal.snapshot(DOC_ID), {
      docId: DOC_ID,
      turnId: "T2",
      targetSeqs: targetSeqsForTurn(ctx.journal, "T2"),
      undoClientId: REVERSAL_CLIENT_ID,
    });
    const coldDoc = cloneDoc(preUndoDoc, LIVE_CLIENT_ID);
    Y.applyUpdate(coldDoc, cold.undoUpdate);

    expect(Array.from(cold.undoUpdate)).toEqual(Array.from(hotUndoUpdate));
    expect(documentBytes(coldDoc)).toEqual(documentBytes(ctx.doc));
    expect(documentJson(coldDoc)).toEqual(documentJson(ctx.doc));
    expect(cold.undoStackDepthBeforeUndo).toBe(1);
    expect(cold.redoStackDepthAfterUndo).toBe(1);

    const journalWithUndo = ctx.journal.clone();
    const undoSeq = journalWithUndo.appendSync(DOC_ID, cold.undoUpdate, {
      origin: "system",
      seq: 0,
    });
    const afterUndoDoc = cloneDoc(ctx.doc, LIVE_CLIENT_ID);
    const preHotRedoVector = Y.encodeStateVector(ctx.doc);
    const hotRedo = ctx.registry.redoLatest(DOC_ID, THREAD_A, {
      mutationClientId: REVERSAL_CLIENT_ID,
    });
    expect(hotRedo).toMatchObject({ ok: true, turnId: "T2" });
    const hotRedoUpdate = Y.encodeStateAsUpdate(ctx.doc, preHotRedoVector);

    const coldRedo = reconstructRedoUpdateFromSnapshot(journalWithUndo.snapshot(DOC_ID), {
      docId: DOC_ID,
      turnId: "T2",
      targetSeqs: targetSeqsForTurn(journalWithUndo, "T2"),
      undoUpdateSeq: undoSeq,
      undoClientId: REVERSAL_CLIENT_ID,
    });
    expectRedoOk(coldRedo);
    const coldRedoDoc = cloneDoc(afterUndoDoc, LIVE_CLIENT_ID);
    Y.applyUpdate(coldRedoDoc, coldRedo.redoUpdate);

    expect(coldRedo.redoStackDepthBeforeRedo).toBe(1);
    expect(Array.from(coldRedo.redoUpdate)).toEqual(Array.from(hotRedoUpdate));
    expect(documentBytes(coldRedoDoc)).toEqual(documentBytes(ctx.doc));
  });

  it("matches hot/cold bytes for same-turn subset undo and redo", () => {
    const ctx = createScenario("Alpha sword.");
    const turnId = "interleaved-subset";

    agentTurn(ctx, THREAD_A, turnId, () => {
      applyAgentText(ctx, THREAD_A, 0, { start: 0, end: 5 }, "Beta");
    });
    const preFirstUndoVector = Y.encodeStateVector(ctx.doc);
    const firstUndo = ctx.registry.undoLatest(DOC_ID, THREAD_A, {
      scope: "turn",
      turnId,
      mutationClientId: REVERSAL_CLIENT_ID,
    });
    expect(firstUndo).toMatchObject({ ok: true, turnId });
    ctx.journal.appendSync(DOC_ID, Y.encodeStateAsUpdate(ctx.doc, preFirstUndoVector), {
      origin: "system",
      seq: 0,
    });

    agentTurn(ctx, THREAD_A, turnId, () => {
      applyAgentText(ctx, THREAD_A, 0, { start: 6, end: 11 }, "blade");
    });
    const subsetSeq = lastUpdateSeq(ctx.journal);
    const targetSeqs = new Set([subsetSeq]);

    const preSubsetUndoDoc = cloneDoc(ctx.doc, LIVE_CLIENT_ID);
    const preSubsetUndoVector = Y.encodeStateVector(ctx.doc);
    const hotUndo = ctx.registry.undoLatest(DOC_ID, THREAD_A, {
      scope: "turn",
      turnId,
      mutationClientId: REVERSAL_CLIENT_ID,
    });
    expect(hotUndo).toMatchObject({ ok: true, turnId });
    const hotUndoUpdate = Y.encodeStateAsUpdate(ctx.doc, preSubsetUndoVector);

    const coldUndo = reconstructUndoUpdateFromSnapshot(ctx.journal.snapshot(DOC_ID), {
      docId: DOC_ID,
      turnId,
      targetSeqs,
      undoClientId: REVERSAL_CLIENT_ID,
    });
    const coldUndoDoc = cloneDoc(preSubsetUndoDoc, LIVE_CLIENT_ID);
    Y.applyUpdate(coldUndoDoc, coldUndo.undoUpdate);

    expect(coldUndo.targetUpdateSeqs).toEqual([subsetSeq]);
    expect(Array.from(coldUndo.undoUpdate)).toEqual(Array.from(hotUndoUpdate));
    expect(blockTexts(coldUndoDoc)).toEqual(["Alpha sword."]);
    expect(documentBytes(coldUndoDoc)).toEqual(documentBytes(ctx.doc));

    const undoUpdateSeq = ctx.journal.appendSync(DOC_ID, hotUndoUpdate, {
      origin: "system",
      seq: 0,
    });
    const afterSubsetUndoDoc = cloneDoc(ctx.doc, LIVE_CLIENT_ID);
    const preSubsetRedoVector = Y.encodeStateVector(ctx.doc);
    const hotRedo = ctx.registry.redoLatest(DOC_ID, THREAD_A, {
      mutationClientId: REVERSAL_CLIENT_ID,
    });
    expect(hotRedo).toMatchObject({ ok: true, turnId });
    const hotRedoUpdate = Y.encodeStateAsUpdate(ctx.doc, preSubsetRedoVector);

    const coldRedo = reconstructRedoUpdateFromSnapshot(ctx.journal.snapshot(DOC_ID), {
      docId: DOC_ID,
      turnId,
      targetSeqs,
      undoUpdateSeq,
      undoClientId: REVERSAL_CLIENT_ID,
    });
    expectRedoOk(coldRedo);
    const coldRedoDoc = cloneDoc(afterSubsetUndoDoc, LIVE_CLIENT_ID);
    Y.applyUpdate(coldRedoDoc, coldRedo.redoUpdate);

    expect(coldRedo.targetUpdateSeqs).toEqual([subsetSeq]);
    expect(Array.from(coldRedo.redoUpdate)).toEqual(Array.from(hotRedoUpdate));
    expect(blockTexts(coldRedoDoc)).toEqual(["Alpha blade."]);
    expect(documentBytes(coldRedoDoc)).toEqual(documentBytes(ctx.doc));
  });

  it("rejects cold redo after a new forward edit clears the hot redo stack", () => {
    const ctx = createScenario("Alpha sword.\n\nBeta waits.");
    agentTurn(ctx, THREAD_A, "old-turn", () => {
      applyAgentText(ctx, THREAD_A, 0, { start: 6, end: 11 }, "blade");
    });

    const preHotUndoVector = Y.encodeStateVector(ctx.doc);
    const hotUndo = ctx.registry.undoLatest(DOC_ID, THREAD_A, {
      scope: "turn",
      turnId: "old-turn",
      mutationClientId: REVERSAL_CLIENT_ID,
    });
    expect(hotUndo).toMatchObject({ ok: true, turnId: "old-turn", redoDepth: 1 });
    const undoSeq = ctx.journal.appendSync(
      DOC_ID,
      Y.encodeStateAsUpdate(ctx.doc, preHotUndoVector),
      {
        origin: "system",
        seq: 0,
      },
    );

    agentTurn(ctx, THREAD_A, "new-turn", () => {
      applyAgentText(ctx, THREAD_A, 1, { start: 5, end: 10 }, "marches");
    });

    const hotRedo = ctx.registry.redoLatest(DOC_ID, THREAD_A, {
      mutationClientId: REVERSAL_CLIENT_ID,
    });
    const coldRedo = reconstructRedoUpdateFromSnapshot(ctx.journal.snapshot(DOC_ID), {
      docId: DOC_ID,
      turnId: "old-turn",
      targetSeqs: targetSeqsForTurn(ctx.journal, "old-turn"),
      undoUpdateSeq: undoSeq,
      undoClientId: REVERSAL_CLIENT_ID,
    });

    expect(hotRedo).toMatchObject({ ok: false, status: "no_redo" });
    expect(coldRedo).toMatchObject({
      ok: false,
      status: "no_redo",
      reason: "forward_update_after_undo",
      blockingUpdateSeq: undoSeq + 1,
      blockingUpdateOrigin: "agent:new-turn",
      blockingUpdateActorTurnId: "new-turn",
    });
  });

  it("matches hot/cold bytes, JSON, markdown, and redo for human text inside an agent paragraph", () => {
    const ctx = createScenario("Alpha");
    agentTurn(ctx, THREAD_A, "insert", () => {
      applyAgentInsert(ctx, THREAD_A, 0, "Agent seed");
    });
    humanText(ctx, 1, { from: 10, to: 10 }, " + human");

    const preUndoDoc = cloneDoc(ctx.doc, LIVE_CLIENT_ID);
    const preHotUndoVector = Y.encodeStateVector(ctx.doc);
    const hotUndo = ctx.registry.undoLatest(DOC_ID, THREAD_A, {
      scope: "turn",
      turnId: "insert",
      mutationClientId: REVERSAL_CLIENT_ID,
    });
    expect(hotUndo).toMatchObject({ ok: true, turnId: "insert", redoDepth: 1 });
    const hotUndoUpdate = Y.encodeStateAsUpdate(ctx.doc, preHotUndoVector);

    const cold = reconstructUndoUpdateFromSnapshot(ctx.journal.snapshot(DOC_ID), {
      docId: DOC_ID,
      turnId: "insert",
      targetSeqs: targetSeqsForTurn(ctx.journal, "insert"),
      undoClientId: REVERSAL_CLIENT_ID,
    });
    const coldDoc = cloneDoc(preUndoDoc, LIVE_CLIENT_ID);
    Y.applyUpdate(coldDoc, cold.undoUpdate);

    expect(Array.from(cold.undoUpdate)).toEqual(Array.from(hotUndoUpdate));
    expect(documentBytes(coldDoc)).toEqual(documentBytes(ctx.doc));
    expect(documentJson(coldDoc)).toEqual(documentJson(ctx.doc));
    expect(serializeDoc(coldDoc)).toBe(serializeDoc(ctx.doc));

    const journalWithUndo = ctx.journal.clone();
    const undoSeq = journalWithUndo.appendSync(DOC_ID, cold.undoUpdate, {
      origin: "system",
      seq: 0,
    });
    const afterUndoDoc = cloneDoc(ctx.doc, LIVE_CLIENT_ID);
    const preHotRedoVector = Y.encodeStateVector(ctx.doc);
    const hotRedo = ctx.registry.redoLatest(DOC_ID, THREAD_A, {
      mutationClientId: REVERSAL_CLIENT_ID,
    });
    expect(hotRedo).toMatchObject({ ok: true, turnId: "insert" });
    const hotRedoUpdate = Y.encodeStateAsUpdate(ctx.doc, preHotRedoVector);

    const coldRedo = reconstructRedoUpdateFromSnapshot(journalWithUndo.snapshot(DOC_ID), {
      docId: DOC_ID,
      turnId: "insert",
      targetSeqs: targetSeqsForTurn(journalWithUndo, "insert"),
      undoUpdateSeq: undoSeq,
      undoClientId: REVERSAL_CLIENT_ID,
    });
    expectRedoOk(coldRedo);
    const coldRedoDoc = cloneDoc(afterUndoDoc, LIVE_CLIENT_ID);
    Y.applyUpdate(coldRedoDoc, coldRedo.redoUpdate);

    expect(Array.from(coldRedo.redoUpdate)).toEqual(Array.from(hotRedoUpdate));
    expect(documentBytes(coldRedoDoc)).toEqual(documentBytes(ctx.doc));
    expect(documentJson(coldRedoDoc)).toEqual(documentJson(ctx.doc));
    expect(serializeDoc(coldRedoDoc)).toBe(serializeDoc(ctx.doc));
  });

  it("changes a deleted block hash when undo re-inserts identical content", () => {
    const ctx = createScenario(
      "Alpha waits at dawn.\n\nBeta waits in the clearing, sword drawn.\n\nGamma keeps watch.",
    );
    const beta = model.getBlocks(ctx.doc)[1];
    const betaTextBefore = model.getText(beta);
    const betaHashBefore = model.getBlockId(beta);

    agentTurn(ctx, THREAD_A, "delete-beta", () => {
      const block = model.getBlocks(ctx.doc)[1];
      applyAgentEdits(ctx, THREAD_A, [
        { documentId: DOC_ID, file: FILE, kind: "delete", element: block },
      ]);
    });

    expect(blockTexts(ctx.doc)).toEqual(["Alpha waits at dawn.", "Gamma keeps watch."]);
    const afterDeleteDoc = cloneDoc(ctx.doc, LIVE_CLIENT_ID);

    const preHotUndoVector = Y.encodeStateVector(ctx.doc);
    const hotUndo = ctx.registry.undoLatest(DOC_ID, THREAD_A, {
      scope: "turn",
      turnId: "delete-beta",
      mutationClientId: REVERSAL_CLIENT_ID,
    });
    expect(hotUndo).toMatchObject({ ok: true, turnId: "delete-beta", redoDepth: 1 });
    const hotUndoUpdate = Y.encodeStateAsUpdate(ctx.doc, preHotUndoVector);

    expect(blockTexts(ctx.doc)).toEqual([
      "Alpha waits at dawn.",
      betaTextBefore,
      "Gamma keeps watch.",
    ]);
    const betaHashAfterUndo = model.getBlockId(model.getBlocks(ctx.doc)[1]);
    expect(betaHashAfterUndo).not.toBe(betaHashBefore);

    const cold = reconstructUndoUpdateFromSnapshot(ctx.journal.snapshot(DOC_ID), {
      docId: DOC_ID,
      turnId: "delete-beta",
      targetSeqs: targetSeqsForTurn(ctx.journal, "delete-beta"),
      undoClientId: REVERSAL_CLIENT_ID,
    });
    const coldDoc = cloneDoc(afterDeleteDoc, LIVE_CLIENT_ID);
    Y.applyUpdate(coldDoc, cold.undoUpdate);

    expect(Array.from(cold.undoUpdate)).toEqual(Array.from(hotUndoUpdate));
    expect(documentBytes(coldDoc)).toEqual(documentBytes(ctx.doc));
    expect(documentJson(coldDoc)).toEqual(documentJson(ctx.doc));

    const journalWithUndo = ctx.journal.clone();
    const undoSeq = journalWithUndo.appendSync(DOC_ID, cold.undoUpdate, {
      origin: "system",
      seq: 0,
    });
    const afterUndoDoc = cloneDoc(ctx.doc, LIVE_CLIENT_ID);
    const preHotRedoVector = Y.encodeStateVector(ctx.doc);
    const hotRedo = ctx.registry.redoLatest(DOC_ID, THREAD_A, {
      mutationClientId: REVERSAL_CLIENT_ID,
    });
    expect(hotRedo).toMatchObject({ ok: true, turnId: "delete-beta" });
    const hotRedoUpdate = Y.encodeStateAsUpdate(ctx.doc, preHotRedoVector);

    const coldRedo = reconstructRedoUpdateFromSnapshot(journalWithUndo.snapshot(DOC_ID), {
      docId: DOC_ID,
      turnId: "delete-beta",
      targetSeqs: targetSeqsForTurn(journalWithUndo, "delete-beta"),
      undoUpdateSeq: undoSeq,
      undoClientId: REVERSAL_CLIENT_ID,
    });
    expectRedoOk(coldRedo);
    const coldRedoDoc = cloneDoc(afterUndoDoc, LIVE_CLIENT_ID);
    Y.applyUpdate(coldRedoDoc, coldRedo.redoUpdate);

    expect(Array.from(coldRedo.redoUpdate)).toEqual(Array.from(hotRedoUpdate));
    expect(blockTexts(ctx.doc)).toEqual(["Alpha waits at dawn.", "Gamma keeps watch."]);
    expect(documentBytes(coldRedoDoc)).toEqual(documentBytes(ctx.doc));
    expect(documentJson(coldRedoDoc)).toEqual(documentJson(ctx.doc));
  });

  it("uses fresh cold-path tokens for each reconstruction", () => {
    const ctx = createScenario("Alpha sword.");
    agentTurn(ctx, THREAD_A, "T1", () => {
      applyAgentText(ctx, THREAD_A, 0, { start: 6, end: 11 }, "blade");
    });

    const first = reconstructUndoUpdateFromSnapshot(ctx.journal.snapshot(DOC_ID), {
      docId: DOC_ID,
      turnId: "T1",
      targetSeqs: targetSeqsForTurn(ctx.journal, "T1"),
      undoClientId: REVERSAL_CLIENT_ID,
    });
    const second = reconstructUndoUpdateFromSnapshot(ctx.journal.snapshot(DOC_ID), {
      docId: DOC_ID,
      turnId: "T1",
      targetSeqs: targetSeqsForTurn(ctx.journal, "T1"),
      undoClientId: REVERSAL_CLIENT_ID,
    });

    expect(first.targetOriginToken).not.toBe(second.targetOriginToken);
    expect(first.nonTargetOriginToken).not.toBe(second.nonTargetOriginToken);
  });
});

describe("8-case reconcile matrix", () => {
  it.each([
    ["clean reverse", caseCleanReverse],
    ["human edited different paragraph", caseHumanDifferentParagraph],
    ["human edited around agent edit", caseHumanAroundAgentEdit],
    ["human built inside agent-inserted paragraph", caseHumanInsideAgentInsertedParagraph],
    ["discontiguous multi-range", caseDiscontiguousMultiRange],
    ["markdown/whitespace normalization", caseMarkdownWhitespaceNormalization],
    ["cross-unload rebuild", caseCrossUnloadRebuild],
    ["partial reversal", casePartialReversal],
  ] satisfies Array<[string, () => MatrixCase]>)("%s", (_name, buildCase) => {
    const matrixCase = buildCase();
    const cold = reconstructUndoUpdateFromSnapshot(matrixCase.ctx.journal.snapshot(DOC_ID), {
      docId: DOC_ID,
      turnId: matrixCase.turnId,
      targetSeqs: targetSeqsForTurn(matrixCase.ctx.journal, matrixCase.turnId),
      undoClientId: REVERSAL_CLIENT_ID,
    });
    const coldDoc = cloneDoc(matrixCase.ctx.doc, LIVE_CLIENT_ID);
    Y.applyUpdate(coldDoc, cold.undoUpdate);

    expect(blockTexts(coldDoc)).toEqual(matrixCase.expectedTexts);
    if (matrixCase.expectedMarkdown)
      expect(serializeDoc(coldDoc)).toBe(matrixCase.expectedMarkdown);
  });
});

describe("Q2b interleaved multi-agent turns", () => {
  it("keeps interleaved thread undo independent in hot and cold paths", () => {
    const ctx = createScenario("A one.\n\nB one.\n\nC one.");

    ctx.registry.beginTurn(DOC_ID, THREAD_B, ctx.doc, "B1");
    capture(ctx, { origin: "agent:B1", actorTurnId: "B1" }, () => {
      applyAgentText(ctx, THREAD_B, 1, { start: 2, end: 5 }, "two");
    });

    agentTurn(ctx, THREAD_A, "A1", () => {
      applyAgentText(ctx, THREAD_A, 0, { start: 2, end: 5 }, "two");
    });

    capture(ctx, { origin: "agent:B1", actorTurnId: "B1" }, () => {
      applyAgentText(ctx, THREAD_B, 2, { start: 2, end: 5 }, "two");
    });
    ctx.registry.endTurn(DOC_ID, THREAD_B, "B1");

    expect(ctx.registry.getState(DOC_ID, THREAD_B)?.undoStack.map((item) => item.turnId)).toEqual([
      "B1",
    ]);
    expect(ctx.registry.getState(DOC_ID, THREAD_A)?.undoStack.map((item) => item.turnId)).toEqual([
      "A1",
    ]);

    const preUndo = cloneDoc(ctx.doc, LIVE_CLIENT_ID);
    const hot = ctx.registry.undoLatest(DOC_ID, THREAD_B, {
      scope: "turn",
      turnId: "B1",
      mutationClientId: REVERSAL_CLIENT_ID,
    });
    expect(hot).toMatchObject({ ok: true, turnId: "B1" });
    expect(blockTexts(ctx.doc)).toEqual(["A two.", "B one.", "C one."]);

    const cold = reconstructUndoUpdateFromSnapshot(ctx.journal.snapshot(DOC_ID), {
      docId: DOC_ID,
      turnId: "B1",
      targetSeqs: targetSeqsForTurn(ctx.journal, "B1"),
      undoClientId: REVERSAL_CLIENT_ID,
    });
    const coldDoc = cloneDoc(preUndo, LIVE_CLIENT_ID);
    Y.applyUpdate(coldDoc, cold.undoUpdate);

    expect(blockTexts(coldDoc)).toEqual(["A two.", "B one.", "C one."]);
    expect(documentBytes(coldDoc)).toEqual(documentBytes(ctx.doc));
  });
});

describe("compactOnLoad", () => {
  it("delegates to journal.compact, returns retained updates, and refuses active live UndoManagers", async () => {
    const ctx = createScenario("Alpha sword.");
    agentTurn(ctx, THREAD_A, "T1", () => {
      applyAgentText(ctx, THREAD_A, 0, { start: 6, end: 11 }, "blade");
    });
    const liveBefore = documentBytes(ctx.doc);

    await expect(
      compactOnLoad(ctx.journal, {
        docId: DOC_ID,
        before: new Date("2026-06-20T00:00:00.000Z"),
        registry: ctx.registry,
      }),
    ).rejects.toThrow(/live UndoManagers/);
    expect(ctx.journal.compactCalls).toBe(0);
    expect(documentBytes(ctx.doc)).toEqual(liveBefore);

    ctx.registry.evictDocument(DOC_ID);
    const result = await compactOnLoad(ctx.journal, {
      docId: DOC_ID,
      before: new Date("2026-06-20T00:00:00.000Z"),
      registry: ctx.registry,
    });

    expect(ctx.journal.compactCalls).toBe(1);
    expect(result).toMatchObject({ updatesFolded: 1, reversalsExpired: 0 });
    expect(result.retainedUpdates).toEqual([]);
    expect(result.checkpoint).toBeInstanceOf(Uint8Array);
    expect(documentBytes(ctx.doc)).toEqual(liveBefore);
  });
});

interface ScenarioContext {
  doc: Y.Doc;
  registry: UndoManagerRegistry;
  journal: MemoryJournal;
}

interface MatrixCase {
  ctx: ScenarioContext;
  turnId: string;
  expectedTexts: string[];
  expectedMarkdown?: string;
}

class MemoryJournal extends InMemoryAgentEditJournal {
  compactCalls = 0;

  constructor(checkpoint: Uint8Array | null) {
    super({ now: () => new Date("2026-06-19T00:00:00.000Z") });
    if (checkpoint) this.setCheckpoint(DOC_ID, checkpoint, 0);
  }

  override clone(): MemoryJournal {
    const copy = this.cloneInto(new MemoryJournal(null));
    copy.compactCalls = this.compactCalls;
    return copy;
  }

  override async compact(docId: string, before: Date) {
    this.compactCalls += 1;
    return super.compact(docId, before);
  }
}

function lastUpdateSeq(journal: MemoryJournal): number {
  const seq = journal.updateRecords(DOC_ID).at(-1)?.seq;
  if (seq === undefined) throw new Error("No updates in journal");
  return seq;
}

function targetSeqsForTurn(
  journal: {
    snapshot(docId: string): {
      updates: readonly { seq: number; meta: { actorTurnId?: string } }[];
    };
  },
  turnId: string,
): ReadonlySet<number> {
  return new Set(
    journal
      .snapshot(DOC_ID)
      .updates.filter((update) => update.meta.actorTurnId === turnId)
      .map((update) => update.seq),
  );
}

function createScenario(
  markdown: string,
  registryOptions: UndoManagerRegistryOptions = {},
): ScenarioContext {
  const doc = createDoc(markdown, LIVE_CLIENT_ID);
  return {
    doc,
    registry: createUndoManagerRegistry(registryOptions),
    journal: new MemoryJournal(Y.encodeStateAsUpdate(doc)),
  };
}

function createDoc(markdown: string, clientID: number): Y.Doc {
  const doc = new Y.Doc({ gc: false });
  doc.clientID = clientID;
  const parsed = codec.parse(markdown);
  const root = schema.node("doc", null, parsed.blocks);
  prosemirrorToYXmlFragment(root, doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME));
  doc.clientID = clientID;
  return doc;
}

function cloneDoc(source: Y.Doc, clientID: number): Y.Doc {
  const doc = new Y.Doc({ gc: false });
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(source));
  doc.clientID = clientID;
  return doc;
}

function agentTurn(ctx: ScenarioContext, threadId: string, turnId: string, fn: () => void): void {
  ctx.registry.beginTurn(DOC_ID, threadId, ctx.doc, turnId);
  capture(ctx, { origin: `agent:${turnId}`, actorTurnId: turnId }, fn);
  ctx.registry.endTurn(DOC_ID, threadId, turnId);
}

function capture(ctx: ScenarioContext, meta: Omit<UpdateMeta, "seq">, fn: () => void): void {
  const updates: Uint8Array[] = [];
  const handler = (update: Uint8Array) => updates.push(update);
  ctx.doc.on("update", handler);
  try {
    fn();
  } finally {
    ctx.doc.off("update", handler);
  }
  for (const update of updates) ctx.journal.appendSync(DOC_ID, update, { ...meta, seq: 0 });
}

function applyAgentText(
  ctx: ScenarioContext,
  threadId: string,
  blockIndex: number,
  span: { start: number; end: number },
  newText: string,
): void {
  const block = model.getBlocks(ctx.doc)[blockIndex];
  const result = applyEdits(
    ctx.doc,
    model,
    codec,
    { documentId: DOC_ID, file: FILE, kind: "text", element: block, span, newText },
    ctx.registry.getThreadOrigin(DOC_ID, threadId),
  );
  expectOk(result);
}

function applyAgentInsert(
  ctx: ScenarioContext,
  threadId: string,
  afterBlockIndex: number | null,
  newText: string,
): void {
  const after = afterBlockIndex === null ? undefined : model.getBlocks(ctx.doc)[afterBlockIndex];
  const result = applyEdits(
    ctx.doc,
    model,
    codec,
    { documentId: DOC_ID, file: FILE, kind: "insert", after, newText },
    ctx.registry.getThreadOrigin(DOC_ID, threadId),
  );
  expectOk(result);
}

function applyAgentEdits(
  ctx: ScenarioContext,
  threadId: string,
  edits: readonly ResolvedEdit[],
): void {
  const result = applyEdits(
    ctx.doc,
    model,
    codec,
    edits,
    ctx.registry.getThreadOrigin(DOC_ID, threadId),
  );
  expectOk(result);
}

function humanText(
  ctx: ScenarioContext,
  blockIndex: number,
  span: { from: number; to: number },
  newText: string,
): void {
  capture(ctx, { origin: "human:user-1" }, () => {
    const block = model.getBlocks(ctx.doc)[blockIndex];
    ctx.doc.transact(() => model.applyTextEdit(ctx.doc, block, span, newText), {
      type: "human",
      userId: "user-1",
    });
  });
}

function humanDeleteBlock(ctx: ScenarioContext, blockIndex: number): void {
  capture(ctx, { origin: "human:user-1" }, () => {
    const block = model.getBlocks(ctx.doc)[blockIndex];
    ctx.doc.transact(() => model.deleteBlock(ctx.doc, block), { type: "human", userId: "user-1" });
  });
}

function textEdit(
  element: Y.XmlElement,
  span: { start: number; end: number },
  newText: string,
): ResolvedEdit {
  return { documentId: DOC_ID, file: FILE, kind: "text", element, span, newText };
}

function expectOk(result: ApplyResult): asserts result is Extract<ApplyResult, { ok: true }> {
  expect(result).toMatchObject({ ok: true });
  if (!result.ok) throw new Error(result.error.message);
}

function expectRedoOk(
  result: RedoReconstructionResult,
): asserts result is Extract<RedoReconstructionResult, { ok: true }> {
  expect(result).toMatchObject({ ok: true });
  if (!result.ok)
    throw new Error(`Expected cold redo bytes, got ${result.status}:${result.reason}`);
}

function blockTexts(doc: Y.Doc): string[] {
  return model.getBlocks(doc).map((block) => model.getText(block));
}

function serializeDoc(doc: Y.Doc): string {
  return codec.serialize(model.getBlocks(doc).map((block) => model.toProsemirrorBlock(doc, block)));
}

function documentJson(doc: Y.Doc): unknown {
  return schema
    .node(
      "doc",
      null,
      model.getBlocks(doc).map((block) => model.toProsemirrorBlock(doc, block)),
    )
    .toJSON();
}

function documentBytes(doc: Y.Doc): number[] {
  return Array.from(Y.encodeStateAsUpdate(doc));
}

function caseCleanReverse(): MatrixCase {
  const ctx = createScenario("Alpha sword.");
  agentTurn(ctx, THREAD_A, "clean", () => {
    applyAgentText(ctx, THREAD_A, 0, { start: 6, end: 11 }, "blade");
  });
  return { ctx, turnId: "clean", expectedTexts: ["Alpha sword."] };
}

function caseHumanDifferentParagraph(): MatrixCase {
  const ctx = createScenario("Alpha sword.\n\nBeta waits.");
  agentTurn(ctx, THREAD_A, "agent", () => {
    applyAgentText(ctx, THREAD_A, 0, { start: 6, end: 11 }, "blade");
  });
  humanText(ctx, 1, { from: 5, to: 10 }, "marches");
  return { ctx, turnId: "agent", expectedTexts: ["Alpha sword.", "Beta marches."] };
}

function caseHumanAroundAgentEdit(): MatrixCase {
  const ctx = createScenario("Alpha sword.");
  agentTurn(ctx, THREAD_A, "agent", () => {
    applyAgentText(ctx, THREAD_A, 0, { start: 6, end: 11 }, "blade");
  });
  humanText(ctx, 0, { from: 0, to: 0 }, "Old ");
  humanText(
    ctx,
    0,
    {
      from: model.getText(model.getBlocks(ctx.doc)[0]).length,
      to: model.getText(model.getBlocks(ctx.doc)[0]).length,
    },
    " now",
  );
  return { ctx, turnId: "agent", expectedTexts: ["Old Alpha sword. now"] };
}

function caseHumanInsideAgentInsertedParagraph(): MatrixCase {
  const ctx = createScenario("Alpha");
  agentTurn(ctx, THREAD_A, "insert", () => {
    applyAgentInsert(ctx, THREAD_A, 0, "Agent seed");
  });
  humanText(ctx, 1, { from: 10, to: 10 }, " + human");
  return { ctx, turnId: "insert", expectedTexts: ["Alpha", " + human"] };
}

function caseDiscontiguousMultiRange(): MatrixCase {
  const ctx = createScenario("Alpha sword.\n\nBeta waits.\n\nGamma sword.");
  agentTurn(ctx, THREAD_A, "multi", () => {
    const blocks = model.getBlocks(ctx.doc);
    applyAgentEdits(ctx, THREAD_A, [
      textEdit(blocks[0], { start: 6, end: 11 }, "blade"),
      textEdit(blocks[2], { start: 6, end: 11 }, "blade"),
    ]);
  });
  return { ctx, turnId: "multi", expectedTexts: ["Alpha sword.", "Beta waits.", "Gamma sword."] };
}

function caseMarkdownWhitespaceNormalization(): MatrixCase {
  const ctx = createScenario("Alpha sword.");
  agentTurn(ctx, THREAD_A, "format", () => {
    applyAgentText(ctx, THREAD_A, 0, { start: 6, end: 11 }, "**blade**");
  });
  return {
    ctx,
    turnId: "format",
    expectedTexts: ["Alpha sword."],
    expectedMarkdown: "Alpha sword.\n",
  };
}

function caseCrossUnloadRebuild(): MatrixCase {
  const ctx = createScenario("Alpha sword.\n\nBeta waits.");
  agentTurn(ctx, THREAD_A, "agent", () => {
    applyAgentText(ctx, THREAD_A, 1, { start: 5, end: 10 }, "marches");
  });
  ctx.registry.evictDocument(DOC_ID);
  return { ctx, turnId: "agent", expectedTexts: ["Alpha sword.", "Beta waits."] };
}

function casePartialReversal(): MatrixCase {
  const ctx = createScenario("Alpha\n\nBeta");
  agentTurn(ctx, THREAD_A, "partial", () => {
    applyAgentInsert(ctx, THREAD_A, 0, "Inserted A\n\nInserted B");
  });
  humanDeleteBlock(ctx, 2);
  return { ctx, turnId: "partial", expectedTexts: ["Alpha", "Beta"] };
}
