/** Consolidated test contracts; each block retains its original fixture scope. */

import { describe as __mergedSuite, expect, it } from "vitest";
/** Checkpoint persistence accepts adapter identity, not copied coverage or replay functions. */
/** Regression coverage for the persisted trail reducer across successive pushes. */
/** The review list's fingerprint cache must never outlive a journal append or an open room. */
import type { CapturedCheckpointCut } from "../domain/checkpoint-cut.js";
import type { TrailChangeV1 } from "../domain/trail-read-kernel.js";
import { mintCheckpointCut, resolveCheckpointCut } from "./checkpoint-capability.js";
import { mergeTrailChanges } from "./drizzle-change-trail-aggregate.js";

__mergedSuite("checkpoint-capability.test.ts", () => {
  // Merged from apps/server/server/domains/collab/adapters/checkpoint-capability.test.ts.
  it("rejects a spread forgery at the type and runtime boundaries", () => {
    const cut = mintCheckpointCut({
      documentId: "document",
      authority: Object.freeze({ authorityId: "authority", generation: 1n }),
      upToSeq: 1,
      materializeState: async () => new Uint8Array([1]),
      validateInputs: async () => {},
    });
    // @ts-expect-error Spread loses the private nominal member.
    const forged: CapturedCheckpointCut = {
      ...cut,
      upToSeq: 99,
      materializeState: async () => new Uint8Array([99]),
    };
    expect(() => resolveCheckpointCut(forged)).toThrow("Unrecognized checkpoint capability");
    expect(resolveCheckpointCut(cut).upToSeq).toBe(1);
  });
});

__mergedSuite("drizzle-change-trail-aggregate.test.ts", () => {
  // Merged from apps/server/server/domains/collab/adapters/drizzle-change-trail-aggregate.test.ts.
  function change(
    input: Partial<TrailChangeV1> &
      Pick<TrailChangeV1, "changeId" | "documentId" | "beforeText" | "afterTextAtReceipt">,
  ): TrailChangeV1 {
    return {
      ordinal: 0,
      pushId: null,
      receiptId: null,
      kind:
        input.beforeText === null
          ? "insert"
          : input.afterTextAtReceipt === null
            ? "delete"
            : "modify",
      beforeBlockIdentity:
        input.beforeText === null
          ? null
          : {
              documentId: input.documentId as string,
              clientID: input.changeId.charCodeAt(0),
              clock: 0,
            },
      afterBlockIdentity:
        input.afterTextAtReceipt === null
          ? null
          : {
              documentId: input.documentId as string,
              clientID: input.changeId.charCodeAt(0),
              clock: 0,
            },
      navigation: { kind: "unavailable", reason: "capture_failed" },
      ...input,
    };
  }

  __mergedSuite("mergeTrailChanges", () => {
    it("removes an insert cancelled by a later push delete", () => {
      const inserted = change({
        changeId: "x",
        documentId: "doc-a",
        beforeText: null,
        afterTextAtReceipt: "X",
      });
      const deleted = change({
        changeId: "x",
        documentId: "doc-a",
        beforeText: "X",
        afterTextAtReceipt: null,
      });
      expect(mergeTrailChanges(mergeTrailChanges([], [inserted]), [deleted])).toEqual([]);
    });
    it("removes A to B cancelled by a later push B to A", () => {
      const forward = change({
        changeId: "x",
        documentId: "doc-a",
        beforeText: "A",
        afterTextAtReceipt: "B",
      });
      const reverse = change({
        changeId: "x",
        documentId: "doc-a",
        beforeText: "B",
        afterTextAtReceipt: "A",
      });
      expect(mergeTrailChanges(mergeTrailChanges([], [forward]), [reverse])).toEqual([]);
    });
  });
});
