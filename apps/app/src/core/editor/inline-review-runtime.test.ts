import type { DraftJournalResponse, ReviewOperation } from "@meridian/contracts/drafts";
import { describe, expect, it } from "vitest";

import {
  decodeDraftJournalResponse,
  operationRejectClosure,
  operationRejectNeedsConfirm,
  operationTargetSeqs,
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

  it("uses server reject closure metadata for discard confirmation", () => {
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

    expect(operationRejectClosure(standalone)).toEqual(["op-1"]);
    expect(operationRejectNeedsConfirm(standalone)).toBe(false);
    expect(operationRejectNeedsConfirm(standalone, { includesWriterEdits: true })).toBe(true);
    expect(operationRejectNeedsConfirm(dragged)).toBe(true);
  });

  it("compares state vectors byte-for-byte", () => {
    expect(stateVectorsEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
    expect(stateVectorsEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false);
    expect(stateVectorsEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(false);
  });
});
