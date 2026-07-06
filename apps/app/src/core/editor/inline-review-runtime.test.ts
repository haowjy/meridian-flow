import {
  createAgentEditCodec,
  type PersistedUpdate,
  replayDraftRowUpdate,
  toDocHandle,
  yProsemirrorModel,
} from "@meridian/agent-edit";
import type { DraftJournalResponse, ReviewOperation } from "@meridian/contracts/drafts";
import { mdxCodec } from "@meridian/markup";
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import {
  decodeDraftJournalResponse,
  operationRejectClosure,
  operationTargetSeqs,
  reconstructOperationRejectUpdate,
  stateVectorsEqual,
} from "./inline-review-runtime";

describe("inline review operation reject helpers", () => {
  it("decodes the base64 journal wire shape into a reconstruction snapshot", () => {
    const wire: DraftJournalResponse = {
      draftId: "draft-1",
      draftRevisionToken: 7,
      checkpoint: "AQID",
      updates: [
        { seq: 5, update: "BAU=" },
        { seq: 7, update: "Bgc=" },
      ],
    };

    const snapshot = decodeDraftJournalResponse(wire);

    expect(Array.from(snapshot.checkpoint ?? [])).toEqual([1, 2, 3]);
    expect(snapshot.updates.map((update) => update.seq)).toEqual([5, 7]);
    expect(snapshot.updates.map((update) => Array.from(update.update))).toEqual([
      [4, 5],
      [6, 7],
    ]);
    expect(snapshot.updates.map((update) => update.meta)).toEqual([
      { origin: "system", seq: 5 },
      { origin: "system", seq: 7 },
    ]);
  });

  it("submits exactly the server reject closure rows once", () => {
    const operation: ReviewOperation = {
      operationId: "op-1",
      rejectClosureOperationIds: ["op-1", "writer:9-abc"],
      rejectSourceUpdateIds: [3, 9, 4, 11, 9],
      kind: "agent",
      contribution: "edited",
      classification: "rewrite",
      hunkCount: 2,
    };

    expect([...operationTargetSeqs(operation)].sort((left, right) => left - right)).toEqual([
      3, 4, 9, 11,
    ]);
  });

  it("falls back to the operation's own id when no server reject closure is set", () => {
    const standalone: ReviewOperation = {
      operationId: "op-1",
      rejectSourceUpdateIds: [124, 129, 130],
      kind: "agent",
      contribution: "edited",
      classification: "rewrite",
      hunkCount: 1,
    };
    const dragged: ReviewOperation = {
      ...standalone,
      rejectClosureOperationIds: ["op-1", "writer:129-abc"],
    };

    // Under closure=card the whole class discards together with no prompt, but
    // the reject closure still drives which journal rows the discard retires.
    expect(operationRejectClosure(standalone)).toEqual(["op-1"]);
    expect(operationRejectClosure(dragged)).toEqual(["op-1", "writer:129-abc"]);
  });

  it("reconstructs reject through replaceAll rows without duplicating or going stale", () => {
    const baseDoc = docFromMarkdown("Alpha.\n\nBeta.\n\nGamma.");
    const checkpoint = Y.encodeStateAsUpdate(baseDoc);
    const authoringDoc = cloneDoc(baseDoc);
    const replace = replaceTextUpdate(authoringDoc, "Beta.", "Beta interim.");
    const overwrite = replaceAllUpdate(authoringDoc, "Alpha.\n\nGamma.\n\nBeta-revised.\n");
    const updates: PersistedUpdate[] = [
      { seq: 1, update: replace, meta: { origin: "system", seq: 1 } },
      { seq: 2, update: overwrite, updateKind: "replaceAll", meta: { origin: "system", seq: 2 } },
    ];

    const { inverseUpdate } = reconstructOperationRejectUpdate({
      snapshot: { checkpoint, updates },
      operation: {
        operationId: "overwrite",
        rejectSourceUpdateIds: [2],
        kind: "agent",
        contribution: "edited",
        classification: "rewrite",
        hunkCount: 1,
      },
      documentId: "doc-1",
    });
    const currentDraftDoc = cloneDoc(baseDoc);
    for (const update of updates) replayDraftRowUpdate(currentDraftDoc, update);

    Y.applyUpdate(currentDraftDoc, inverseUpdate);

    expect(blockTexts(currentDraftDoc)).toEqual(["Alpha.", "Beta interim.", "Gamma."]);
  });

  it("reconstructs reject for deleted block operations", () => {
    const baseDoc = docFromMarkdown("Alpha.\n\n- cut one\n- cut two\n\nOmega.");
    const checkpoint = Y.encodeStateAsUpdate(baseDoc);
    const authoringDoc = cloneDoc(baseDoc);
    const deleteList = deleteBlockUpdate(authoringDoc, 1);
    const updates: PersistedUpdate[] = [
      { seq: 3, update: deleteList, meta: { origin: "system", seq: 3 } },
    ];

    const { inverseUpdate } = reconstructOperationRejectUpdate({
      snapshot: { checkpoint, updates },
      operation: {
        operationId: "delete-list",
        rejectSourceUpdateIds: [3],
        kind: "agent",
        contribution: "removed",
        classification: "removal",
        hunkCount: 1,
      },
      documentId: "doc-1",
    });
    const currentDraftDoc = cloneDoc(baseDoc);
    for (const update of updates) replayDraftRowUpdate(currentDraftDoc, update);

    Y.applyUpdate(currentDraftDoc, inverseUpdate);

    expect(blockTexts(currentDraftDoc)).toEqual(["Alpha.", "cut onecut two", "Omega."]);
  });

  it("compares state vectors byte-for-byte", () => {
    expect(stateVectorsEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
    expect(stateVectorsEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false);
    expect(stateVectorsEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(false);
  });
});

const schema = buildDocumentSchema();
const model = yProsemirrorModel(schema);
const codec = createAgentEditCodec(mdxCodec({ schema }));

function docFromMarkdown(markdown: string): Y.Doc {
  const doc = new Y.Doc({ gc: false });
  model.transact(
    toDocHandle(doc),
    () => model.replaceAllBlocks(toDocHandle(doc), codec.parse(markdown)),
    { type: "system" },
  );
  return doc;
}

function cloneDoc(source: Y.Doc): Y.Doc {
  const doc = new Y.Doc({ gc: false });
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(source));
  return doc;
}

function replaceTextUpdate(doc: Y.Doc, find: string, replacement: string): Uint8Array {
  const handle = toDocHandle(doc);
  const block = model
    .getBlocks(handle)
    .find((candidate) => model.getText(candidate).includes(find));
  if (!block) throw new Error(`Missing block for ${find}`);
  const text = model.getText(block);
  const from = text.indexOf(find);
  const before = Y.encodeStateVector(doc);
  model.transact(
    handle,
    () => model.applyTextEdit(handle, block, { from, to: from + find.length }, replacement),
    { type: "agent" },
  );
  return Y.encodeStateAsUpdate(doc, before);
}

function replaceAllUpdate(doc: Y.Doc, markdown: string): Uint8Array {
  const before = Y.encodeStateVector(doc);
  model.transact(
    toDocHandle(doc),
    () => model.replaceAllBlocks(toDocHandle(doc), codec.parse(markdown)),
    { type: "agent" },
  );
  return Y.encodeStateAsUpdate(doc, before);
}

function deleteBlockUpdate(doc: Y.Doc, blockIndex: number): Uint8Array {
  const handle = toDocHandle(doc);
  const block = model.getBlocks(handle)[blockIndex];
  if (!block) throw new Error(`Missing block ${blockIndex}`);
  const before = Y.encodeStateVector(doc);
  model.transact(handle, () => model.deleteBlock(handle, block), { type: "agent" });
  return Y.encodeStateAsUpdate(doc, before);
}

function blockTexts(doc: Y.Doc): string[] {
  return model.getBlocks(toDocHandle(doc)).map((block) => model.getText(block));
}
