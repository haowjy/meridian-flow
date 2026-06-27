// Unit coverage for durable reversal lineage grouping and dependency policy.
import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import type { PersistedUpdate, ReversalRecord } from "../ports/types.js";
import type { WriteMutationRow } from "../ports/update-journal.js";
import {
  activeClosureForHandles,
  compatibleLineageGroups,
  evaluateLineageDependencies,
  seqToHandleFromMutations,
} from "./reversal-lineage.js";

const DOC_ID = "doc";
const THREAD_ID = "thread";

describe("reversal lineage", () => {
  it("builds the active closure from forward seqs plus the current redone seq", () => {
    const rows = new Map([["w1", [mutation("w1", 1)]]]);
    const reversals = [reversal("w1", "redone", 3, 4)];

    const closure = activeClosureForHandles({ handles: ["w1"], rowsByHandle: rows, reversals });

    expect(closure && [...closure.forwardSeqs]).toEqual([1]);
    expect(closure && [...closure.targetSeqs]).toEqual([4]);
    expect(closure && [...closure.lineageSeqs]).toEqual([1, 3, 4]);
    expect(closure?.earliestForwardSeq).toBe(1);
  });

  it("partitions selected handles by active cycle boundary", () => {
    const rows = new Map([
      ["w1", [mutation("w1", 1)]],
      ["w2", [mutation("w2", 2)]],
      ["w3", [mutation("w3", 3)]],
    ]);
    const reversals = [
      reversal("w1", "redone", 5, 8),
      reversal("w2", "redone", 5, 8),
      reversal("w3", "redone", 6, 9),
    ];

    const groups = compatibleLineageGroups({
      handles: ["w1", "w2", "w3"],
      rowsByHandle: rows,
      reversals,
    });

    expect(groups.map((group) => group.handles)).toEqual([["w1", "w2"], ["w3"]]);
    expect(groups.map((group) => [...group.targetSeqs])).toEqual([[8], [9]]);
  });

  it("blocks non-lineage deletes after the earliest forward seq and exempts lineage seqs", () => {
    const updates = textUpdates();
    const rows = new Map([["w1", [mutation("w1", 1)]]]);
    const reversals = [reversal("w1", "redone", 2, 4)];
    const closure = activeClosureForHandles({ handles: ["w1"], rowsByHandle: rows, reversals });
    if (!closure) throw new Error("expected closure");

    const verdict = evaluateLineageDependencies({
      snapshot: { checkpoint: null, updates },
      closure,
      seqToHandle: seqToHandleFromMutations(rows, reversals),
    });

    expect(verdict).toEqual({ ok: false, blockingWriteIds: ["a later edit"] });
  });
});

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
  push(5, "human:user", () => text.delete(0, 5));
  return rows;
}
