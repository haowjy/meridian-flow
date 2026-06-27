// Reconcile coverage for cold journal undo/redo reconstruction.

import { mdxCodec } from "@meridian/markup";
import {
  AGENT_EDIT_UNDO_CLIENT_ID,
  buildDocumentSchema,
  PROSEMIRROR_FRAGMENT_NAME,
  RESERVED_CLIENT_ID_MAX,
} from "@meridian/prosemirror-schema";
import { describe, expect, it } from "vitest";
import { prosemirrorToYXmlFragment } from "y-prosemirror";
import * as Y from "yjs";
import { applyEdits } from "../apply/tiers.js";
import type { ApplyResult, ResolvedEdit } from "../apply/types.js";
import type { BlockRef } from "../block-ref.js";
import { createAgentEditCodec } from "../codec-adapter.js";
import { toRef } from "../model/block-ref.js";
import { yProsemirrorModel } from "../model/y-prosemirror.js";
import type { UpdateMeta } from "../ports/types.js";
import { InMemoryAgentEditJournal } from "../test-support/index.js";
import { reconstructUndoUpdateFromSnapshot } from "./reconstruction.js";
import { createThreadOriginRegistry } from "./thread-origin-registry.js";

const schema = buildDocumentSchema();
const codec = createAgentEditCodec(mdxCodec({ schema }));
const model = yProsemirrorModel(schema);
const DOC_ID = "doc-1";
const FILE = "chapter.md";
const THREAD_A = "thread-a";
const LIVE_CLIENT_ID = RESERVED_CLIENT_ID_MAX + 1;
const REVERSAL_CLIENT_ID = AGENT_EDIT_UNDO_CLIENT_ID;

describe("thread origins", () => {
  it("returns a stable transaction origin per document/thread", () => {
    const origins = createThreadOriginRegistry();
    const first = origins.getThreadOrigin(DOC_ID, THREAD_A);

    expect(origins.getThreadOrigin(DOC_ID, THREAD_A)).toBe(first);
    expect(origins.getThreadOrigin("doc-2", THREAD_A)).not.toBe(first);
    expect(origins.getThreadOrigin(DOC_ID, "thread-b")).not.toBe(first);

    origins.evictThread(DOC_ID, THREAD_A);
    expect(origins.getThreadOrigin(DOC_ID, THREAD_A)).not.toBe(first);
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

interface ScenarioContext {
  doc: Y.Doc;
  origins: Map<string, symbol>;
  journal: MemoryJournal;
}

interface MatrixCase {
  ctx: ScenarioContext;
  turnId: string;
  expectedTexts: string[];
  expectedMarkdown?: string;
}

class MemoryJournal extends InMemoryAgentEditJournal {
  constructor(checkpoint: Uint8Array | null) {
    super({ now: () => new Date("2026-06-19T00:00:00.000Z") });
    if (checkpoint) this.setCheckpoint(DOC_ID, checkpoint, 0);
  }
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

function createScenario(markdown: string): ScenarioContext {
  const doc = createDoc(markdown, LIVE_CLIENT_ID);
  return {
    doc,
    origins: new Map(),
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

function agentTurn(ctx: ScenarioContext, turnId: string, fn: () => void): void {
  capture(ctx, { origin: `agent:${turnId}`, actorTurnId: turnId }, fn);
}

function threadOrigin(ctx: ScenarioContext, threadId: string): symbol {
  let origin = ctx.origins.get(threadId);
  if (!origin) {
    origin = Symbol(`thread-${threadId}`);
    ctx.origins.set(threadId, origin);
  }
  return origin;
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
    { documentId: DOC_ID, file: FILE, kind: "text", block: toRef(block), span, newText },
    threadOrigin(ctx, threadId),
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
    {
      documentId: DOC_ID,
      file: FILE,
      kind: "insert",
      ...(after ? { after: toRef(after) } : {}),
      newText,
    },
    threadOrigin(ctx, threadId),
  );
  expectOk(result);
}

function applyAgentEdits(
  ctx: ScenarioContext,
  threadId: string,
  edits: readonly ResolvedEdit[],
): void {
  const result = applyEdits(ctx.doc, model, codec, edits, threadOrigin(ctx, threadId));
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
  element: BlockRef,
  span: { start: number; end: number },
  newText: string,
): ResolvedEdit {
  return { documentId: DOC_ID, file: FILE, kind: "text", block: toRef(element), span, newText };
}

function expectOk(result: ApplyResult): asserts result is Extract<ApplyResult, { ok: true }> {
  expect(result).toMatchObject({ ok: true });
  if (!result.ok) throw new Error(result.error.message);
}

function blockTexts(doc: Y.Doc): string[] {
  return model.getBlocks(doc).map((block) => model.getText(block));
}

function serializeDoc(doc: Y.Doc): string {
  return codec.serialize(model.getBlocks(doc).map((block) => model.toProsemirrorBlock(doc, block)));
}

function caseCleanReverse(): MatrixCase {
  const ctx = createScenario("Alpha sword.");
  agentTurn(ctx, "clean", () => {
    applyAgentText(ctx, THREAD_A, 0, { start: 6, end: 11 }, "blade");
  });
  return { ctx, turnId: "clean", expectedTexts: ["Alpha sword."] };
}

function caseHumanDifferentParagraph(): MatrixCase {
  const ctx = createScenario("Alpha sword.\n\nBeta waits.");
  agentTurn(ctx, "agent", () => {
    applyAgentText(ctx, THREAD_A, 0, { start: 6, end: 11 }, "blade");
  });
  humanText(ctx, 1, { from: 5, to: 10 }, "marches");
  return { ctx, turnId: "agent", expectedTexts: ["Alpha sword.", "Beta marches."] };
}

function caseHumanAroundAgentEdit(): MatrixCase {
  const ctx = createScenario("Alpha sword.");
  agentTurn(ctx, "agent", () => {
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
  agentTurn(ctx, "insert", () => {
    applyAgentInsert(ctx, THREAD_A, 0, "Agent seed");
  });
  humanText(ctx, 1, { from: 10, to: 10 }, " + human");
  return { ctx, turnId: "insert", expectedTexts: ["Alpha", " + human"] };
}

function caseDiscontiguousMultiRange(): MatrixCase {
  const ctx = createScenario("Alpha sword.\n\nBeta waits.\n\nGamma sword.");
  agentTurn(ctx, "multi", () => {
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
  agentTurn(ctx, "format", () => {
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
  agentTurn(ctx, "agent", () => {
    applyAgentText(ctx, THREAD_A, 1, { start: 5, end: 10 }, "marches");
  });
  return { ctx, turnId: "agent", expectedTexts: ["Alpha sword.", "Beta waits."] };
}

function casePartialReversal(): MatrixCase {
  const ctx = createScenario("Alpha\n\nBeta");
  agentTurn(ctx, "partial", () => {
    applyAgentInsert(ctx, THREAD_A, 0, "Inserted A\n\nInserted B");
  });
  humanDeleteBlock(ctx, 2);
  return { ctx, turnId: "partial", expectedTexts: ["Alpha", "Beta"] };
}
