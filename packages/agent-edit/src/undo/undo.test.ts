// Reconcile coverage for cold journal undo/redo reconstruction.

import { mdxCodec, UNSCOPED_DOCUMENT_LINKS } from "@meridian/markup";
import {
  AGENT_EDIT_UNDO_CLIENT_ID,
  buildDocumentSchema,
  PROSEMIRROR_FRAGMENT_NAME,
  RESERVED_CLIENT_ID_MAX,
} from "@meridian/prosemirror-schema";
import { Fragment } from "prosemirror-model";
import { describe, expect, it } from "vitest";
import { prosemirrorToYXmlFragment } from "y-prosemirror";
import * as Y from "yjs";
import { applyEdits } from "../apply/apply-edits.js";
import type { ApplyResult, ResolvedEdit } from "../apply/types.js";
import { createAgentEditCodec } from "../codec-adapter.js";
import type { BlockRef } from "../handles.js";
import { toRef } from "../handles.js";
import { yProsemirrorModel } from "../model/y-prosemirror.js";
import type { UpdateMeta } from "../ports/types.js";
import { InMemoryAgentEditJournal } from "../test-support/index.js";
import { reconstructUndoUpdateFromSnapshot } from "./reconstruction.js";

const schema = buildDocumentSchema();
const codec = createAgentEditCodec(mdxCodec({ schema }), UNSCOPED_DOCUMENT_LINKS);
const model = yProsemirrorModel(schema);
const DOC_ID = "doc-1";
const FILE = "chapter.md";
const THREAD_A = "thread-a";
const LIVE_CLIENT_ID = RESERVED_CLIENT_ID_MAX + 1;
const REVERSAL_CLIENT_ID = AGENT_EDIT_UNDO_CLIENT_ID;

describe("cold undo reconstruction boundaries", () => {
  it.each([
    ["human built inside agent-inserted paragraph", caseHumanInsideAgentInsertedParagraph],
    ["discontiguous multi-range", caseDiscontiguousMultiRange],
    ["markdown/whitespace normalization", caseMarkdownWhitespaceNormalization],
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
    {
      documentId: DOC_ID,
      file: FILE,
      kind: "textRanges",
      block: toRef(block),
      replacements: [{ span, content: inlineText(newText) }],
      output: newText,
    },
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
    {
      documentId: DOC_ID,
      file: FILE,
      kind: "insert",
      ...(after ? { after: toRef(after) } : {}),
      newText,
      blocks: codec.parse(newText).blocks,
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
  const result = applyEdits(ctx.doc, model, edits, threadOrigin(ctx, threadId));
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
  return {
    documentId: DOC_ID,
    file: FILE,
    kind: "textRanges",
    block: toRef(element),
    replacements: [{ span, content: inlineText(newText) }],
    output: newText,
  };
}

function expectOk(result: ApplyResult): asserts result is Extract<ApplyResult, { ok: true }> {
  expect(result).toMatchObject({ ok: true });
  if (!result.ok) throw new Error(result.error.message);
}

function blockTexts(doc: Y.Doc): string[] {
  return model.getBlocks(doc).map((block) => model.getText(block));
}

function serializeDoc(doc: Y.Doc): string {
  return codec.serialize(model.projectBlocks(doc));
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

function casePartialReversal(): MatrixCase {
  const ctx = createScenario("Alpha\n\nBeta");
  agentTurn(ctx, "partial", () => {
    applyAgentInsert(ctx, THREAD_A, 0, "Inserted A\n\nInserted B");
  });
  humanDeleteBlock(ctx, 2);
  return { ctx, turnId: "partial", expectedTexts: ["Alpha", "Beta"] };
}

/** Plain inline content standing in for a resolved text replacement. */
function inlineText(text: string): Fragment {
  return text.length === 0 ? Fragment.empty : Fragment.from(schema.text(text));
}
