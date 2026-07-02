import type { DraftJournalResponse, ReviewOperation } from "@meridian/contracts/drafts";
import { describe, expect, it } from "vitest";

import {
  decodeDraftJournalResponse,
  operationRejectIsMixed,
  operationTargetSeqs,
  stateVectorsEqual,
} from "./reject-operation";

describe("inline review operation reject helpers", () => {
  it("decodes the base64 journal wire shape into a reconstruction snapshot", () => {
    const wire: DraftJournalResponse = {
      draftId: "draft-1",
      revisionToken: 7,
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

  it("uses the server reject closure as reconstruct target seqs", () => {
    const operation: ReviewOperation = {
      operationId: "op-1",
      sourceUpdateIds: [3, 9, 4],
      rejectSourceUpdateIds: [3, 9, 4, 11],
      kind: "agent",
      hunkCount: 2,
    };

    expect([...operationTargetSeqs(operation)].sort((left, right) => left - right)).toEqual([
      3, 4, 9, 11,
    ]);
  });

  it("does not treat physical reject closure rows as writer-overlap confirmation", () => {
    const operation: ReviewOperation = {
      operationId: "op-1",
      sourceUpdateIds: [124],
      rejectSourceUpdateIds: [124, 129, 130],
      kind: "agent",
      hunkCount: 1,
    };

    expect(operationRejectIsMixed(operation)).toBe(false);
    expect(operationRejectIsMixed(operation, { includesWriterEdits: true })).toBe(true);
  });

  it("compares state vectors byte-for-byte", () => {
    expect(stateVectorsEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
    expect(stateVectorsEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false);
    expect(stateVectorsEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(false);
  });
});
