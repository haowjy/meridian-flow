// Unit coverage for the durable undo lineage selection contract.
import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import type { JournalSnapshot, PersistedUpdate, ReversalRecord } from "../ports/types.js";
import type { WriteMutationRow } from "../ports/update-journal.js";
import { selectUndoClosure } from "./reversal-lineage.js";

const DOC_ID = "doc";
const THREAD_ID = "thread";

describe("selectUndoClosure", () => {
  it("selects a single active handle and its retained forward seq", () => {
    const snapshot = snapshotWithSeqs([1]);
    const closure = selectUndoClosure({
      snapshot,
      reversals: [],
      rowsByHandle: new Map([["w1", [mutation("w1", 1)]]]),
      selectedHandles: ["w1"],
      candidateHandles: ["w1"],
      reversalOpSeqs: new Set(),
      isScopeSelection: false,
    });

    expect(closure.ok && closure.handles).toEqual(["w1"]);
    expect(closure.ok && [...closure.targetSeqs]).toEqual([1]);
  });

  it("uses the earliest compatible lineage group as the seed for scope selections", () => {
    const rowsByHandle = new Map([
      ["w1", [mutation("w1", 1)]],
      ["w2", [mutation("w2", 2)]],
      ["w3", [mutation("w3", 3)]],
    ]);
    const reversals = [
      reversal("w1", "redone", 5, 8),
      reversal("w2", "redone", 5, 8),
      reversal("w3", "redone", 6, 9),
    ];

    const closure = selectUndoClosure({
      snapshot: snapshotWithSeqs([1, 2, 3, 5, 6, 8, 9]),
      reversals,
      rowsByHandle,
      selectedHandles: ["w1", "w2", "w3"],
      candidateHandles: ["w1", "w2", "w3"],
      reversalOpSeqs: new Set([5, 6, 8, 9]),
      isScopeSelection: true,
    });

    expect(closure.ok && closure.handles).toEqual(["w1", "w2"]);
    expect(closure.ok && [...closure.targetSeqs]).toEqual([8]);
  });

  it("expands a selected handle to the compatible active redo boundary", () => {
    const rowsByHandle = new Map([
      ["w1", [mutation("w1", 1)]],
      ["w2", [mutation("w2", 2)]],
      ["w3", [mutation("w3", 3)]],
    ]);
    const reversals = [
      reversal("w1", "redone", 5, 8),
      reversal("w2", "redone", 5, 8),
      reversal("w3", "redone", 6, 9),
    ];

    const closure = selectUndoClosure({
      snapshot: snapshotWithSeqs([1, 2, 3, 5, 6, 8, 9]),
      reversals,
      rowsByHandle,
      selectedHandles: ["w2"],
      candidateHandles: ["w1", "w2", "w3"],
      reversalOpSeqs: new Set([5, 6, 8, 9]),
      isScopeSelection: false,
    });

    expect(closure.ok && closure.handles).toEqual(["w1", "w2"]);
    expect(closure.ok && [...closure.targetSeqs]).toEqual([8]);
  });

  it("expands a selected handle to every handle backed by the same durable update", () => {
    const closure = selectUndoClosure({
      snapshot: snapshotWithSeqs([8]),
      reversals: [],
      rowsByHandle: new Map([
        ["w1", [mutation("w1", 8)]],
        ["w2", [mutation("w2", 8)]],
      ]),
      selectedHandles: ["w2"],
      candidateHandles: ["w1", "w2"],
      reversalOpSeqs: new Set(),
      isScopeSelection: false,
    });

    expect(closure.ok && closure.handles).toEqual(["w1", "w2"]);
    expect(closure.ok && [...closure.targetSeqs]).toEqual([8]);
  });

  it("refuses undo when a later retained write consumes selected content", () => {
    const updates = textUpdates();
    const rowsByHandle = new Map([
      ["w1", [mutation("w1", 1)]],
      ["w2", [mutation("w2", 5)]],
    ]);
    const reversals = [reversal("w1", "redone", 2, 4)];

    const closure = selectUndoClosure({
      snapshot: { checkpoint: null, updates },
      reversals,
      rowsByHandle,
      selectedHandles: ["w1"],
      candidateHandles: ["w1", "w2"],
      reversalOpSeqs: new Set([2, 4]),
      isScopeSelection: false,
    });

    expect(closure).toEqual({
      ok: false,
      status: "cant_undo_dependent",
      blockingWriteIds: ["w2"],
      selectedWriteIds: ["w1"],
    });
  });

  it("ignores retained reversal-op deletes for the selected handle when checking dependencies", () => {
    const updates = textUpdatesWithUndoRedoHistory();
    const closure = selectUndoClosure({
      snapshot: { checkpoint: null, updates },
      reversals: [reversal("w1", "redone", 2, 4)],
      rowsByHandle: new Map([["w1", [mutation("w1", 1)]]]),
      selectedHandles: ["w1"],
      candidateHandles: ["w1"],
      reversalOpSeqs: new Set([2, 4]),
      isScopeSelection: false,
    });

    expect(closure.ok && closure.handles).toEqual(["w1"]);
    expect(closure.ok && [...closure.targetSeqs]).toEqual([4]);
  });

  it("ignores forward updates owned by currently reversed writes when checking dependencies", () => {
    const updates = textUpdates();
    const closure = selectUndoClosure({
      snapshot: { checkpoint: null, updates },
      reversals: [reversal("w1", "redone", 2, 4), reversal("w2", "reversed", 6)],
      rowsByHandle: new Map([
        ["w1", [mutation("w1", 1)]],
        ["w2", [{ ...mutation("w2", 5), status: "reversed", undoUpdateSeq: 6 }]],
      ]),
      selectedHandles: ["w1"],
      candidateHandles: ["w1", "w2"],
      reversalOpSeqs: new Set([2, 4, 6]),
      isScopeSelection: false,
    });

    expect(closure.ok && closure.handles).toEqual(["w1"]);
    expect(closure.ok && [...closure.targetSeqs]).toEqual([4]);
  });

  it("refuses unexplained later deletes against the selected handle's retained history", () => {
    const updates = textUpdates();
    const closure = selectUndoClosure({
      snapshot: { checkpoint: null, updates },
      reversals: [reversal("w1", "redone", 2, 4)],
      rowsByHandle: new Map([["w1", [mutation("w1", 1)]]]),
      selectedHandles: ["w1"],
      candidateHandles: ["w1"],
      reversalOpSeqs: new Set([2, 4]),
      isScopeSelection: false,
    });

    expect(closure).toEqual({
      ok: false,
      status: "cant_undo_dependent",
      blockingWriteIds: ["a later edit"],
      selectedWriteIds: ["w1"],
    });
  });

  it("returns nothing_to_undo when selected rows are not active and retained", () => {
    const snapshot = snapshotWithSeqs([1]);

    expect(
      selectUndoClosure({
        snapshot,
        reversals: [],
        rowsByHandle: new Map([["w1", [{ ...mutation("w1", 1), status: "reversed" }]]]),
        selectedHandles: ["w1"],
        candidateHandles: ["w1"],
        reversalOpSeqs: new Set(),
        isScopeSelection: false,
      }),
    ).toEqual({ ok: false, status: "nothing_to_undo" });

    expect(
      selectUndoClosure({
        snapshot,
        reversals: [],
        rowsByHandle: new Map([["w2", [mutation("w2", 2)]]]),
        selectedHandles: ["w2"],
        candidateHandles: ["w2"],
        reversalOpSeqs: new Set(),
        isScopeSelection: false,
      }),
    ).toEqual({ ok: false, status: "nothing_to_undo" });
  });

  it("returns nothing_to_undo when the active redo target seq is no longer retained", () => {
    const closure = selectUndoClosure({
      snapshot: snapshotWithSeqs([1, 3]),
      reversals: [reversal("w1", "redone", 3, 4)],
      rowsByHandle: new Map([["w1", [mutation("w1", 1)]]]),
      selectedHandles: ["w1"],
      candidateHandles: ["w1"],
      reversalOpSeqs: new Set([3, 4]),
      isScopeSelection: false,
    });

    expect(closure).toEqual({ ok: false, status: "nothing_to_undo" });
  });
});

function snapshotWithSeqs(seqs: readonly number[]): JournalSnapshot {
  return {
    checkpoint: null,
    updates: seqs.map((seq) => ({ seq, update: new Uint8Array(), meta: { origin: "test", seq } })),
  };
}

function mutation(handle: string, seq: number): WriteMutationRow {
  const wId = Number(handle.slice(1));
  return { writeId: handle, handle, wId, turnId: "turn", createdSeq: seq, status: "active" };
}

function reversal(
  writeId: string,
  status: ReversalRecord["status"],
  undoUpdateSeq: number,
  redoUpdateSeq?: number,
): ReversalRecord {
  return {
    documentId: DOC_ID,
    threadId: THREAD_ID,
    turnId: "turn",
    writeIds: [writeId],
    status,
    undoUpdateSeq,
    ...(redoUpdateSeq !== undefined ? { redoUpdateSeq } : {}),
  };
}

function textUpdatesWithUndoRedoHistory(): PersistedUpdate[] {
  const doc = new Y.Doc({ gc: false });
  const text = doc.getText("t");
  const rows: PersistedUpdate[] = [];
  const push = (seq: number, origin: string, mutate: () => void) => {
    const before = Y.encodeStateVector(doc);
    doc.transact(mutate, origin);
    rows.push({ seq, update: Y.encodeStateAsUpdate(doc, before), meta: { origin, seq } });
  };
  push(1, "agent:turn", () => text.insert(0, "blade"));
  push(2, "system", () => text.delete(0, 5));
  push(4, "system", () => text.insert(0, "blade"));
  return rows;
}

function textUpdates(): PersistedUpdate[] {
  const doc = new Y.Doc({ gc: false });
  const text = doc.getText("t");
  const rows: PersistedUpdate[] = [];
  const push = (seq: number, origin: string, mutate: () => void) => {
    const before = Y.encodeStateVector(doc);
    doc.transact(mutate, origin);
    rows.push({ seq, update: Y.encodeStateAsUpdate(doc, before), meta: { origin, seq } });
  };
  push(1, "agent:turn", () => text.insert(0, "blade"));
  push(2, "system", () => text.delete(0, 5));
  push(4, "system", () => text.insert(0, "blade"));
  push(5, "agent:later", () => text.delete(0, 5));
  return rows;
}
