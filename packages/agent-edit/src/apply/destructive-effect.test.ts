// Shared response-scoped destructive-effect algebra.

import { describe, expect, it } from "vitest";
import {
  buildDestructiveEffectInput,
  classifyDestructiveEffect,
  type VisibleProseOccurrence,
} from "./destructive-classification.js";

const occurrence = (input: {
  targetClock: number;
  rootClock?: number;
  length: number;
  rendering: string;
  provenance?: "writer_protected" | "agent";
}): VisibleProseOccurrence => ({
  target: { clientID: 1, clock: input.targetClock, length: input.length },
  root: { clientID: 9, clock: input.rootClock ?? input.targetClock, length: input.length },
  provenance: input.provenance ?? "writer_protected",
  finalRendering: input.rendering,
});

describe("classifyDestructiveEffect", () => {
  it("materializes rendering identity and provenance from typed snapshots once", () => {
    const input = buildDestructiveEffectInput({
      before: [
        {
          hash: "a",
          clientID: 1,
          clock: 2,
          renderedContent: "paragraph|writer text",
          body: "writer text",
          serialized: "a|writer text",
          lineage: [{ clientID: 3, clock: 4, length: 5 }],
        },
      ],
      afterCandidate: [],
      beforeProvenance: [
        {
          target: { clientID: 3, clock: 4, length: 5 },
          root: { clientID: 9, clock: 10, length: 5 },
          provenance: "writer_protected",
        },
      ],
      afterCandidateProvenance: [],
    });

    expect(input.before).toEqual([
      {
        target: { clientID: 3, clock: 4, length: 5 },
        root: { clientID: 9, clock: 10, length: 5 },
        provenance: "writer_protected",
        finalRendering: "1:2:paragraph|writer text",
      },
    ]);
  });

  it("reports only removed protected root units and projects pointwise to final rendering", () => {
    const before = [occurrence({ targetClock: 0, length: 4, rendering: "block-a" })];
    const afterCandidate = [
      occurrence({ targetClock: 10, rootClock: 0, length: 2, rendering: "new" }),
    ];
    expect(
      classifyDestructiveEffect({
        before,
        afterCandidate,
      }),
    ).toEqual({
      eligibleRanges: [{ clientID: 1, clock: 2, length: 2 }],
      finalRenderingProjections: [
        { finalRendering: "block-a", ranges: [{ clientID: 1, clock: 2, length: 2 }] },
      ],
    });
  });

  it("reports every removed writer root", () => {
    const observed = occurrence({ targetClock: 0, length: 2, rendering: "mixed" });
    const postCut = occurrence({ targetClock: 2, rootClock: 2, length: 2, rendering: "mixed" });
    const result = classifyDestructiveEffect({
      before: [observed, postCut],
      afterCandidate: [],
    });
    expect(result.eligibleRanges).toEqual([{ clientID: 1, clock: 0, length: 4 }]);
  });

  it("rejects non-length-preserving continuation input", () => {
    const bad = occurrence({ targetClock: 0, length: 2, rendering: "bad" });
    bad.root.length = 1;
    expect(() =>
      classifyDestructiveEffect({
        before: [bad],
        afterCandidate: [],
      }),
    ).toThrow(/length-preserving/);
  });
});
