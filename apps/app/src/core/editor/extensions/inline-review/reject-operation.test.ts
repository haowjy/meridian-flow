import type { DraftJournalResponse, ReviewOperation } from "@meridian/contracts/drafts";
import { describe, expect, it } from "vitest";

import { decodeDraftJournalResponse, operationTargetSeqs } from "./reject-operation";

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

  it("uses the operation source update ids as reconstruct target seqs", () => {
    const operation: ReviewOperation = {
      operationId: "op-1",
      sourceUpdateIds: [3, 9, 4],
      kind: "agent",
      hunkCount: 2,
    };

    expect([...operationTargetSeqs(operation)].sort((left, right) => left - right)).toEqual([
      3, 4, 9,
    ]);
  });
});
