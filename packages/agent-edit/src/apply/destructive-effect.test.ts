// Shared response-scoped destructive-effect algebra.

import { describe, expect, it } from "vitest";
import {
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

const cut = (visible: readonly VisibleProseOccurrence[]) => ({
  id: "cut-1",
  version: 1 as const,
  documentId: "doc-1",
  authorityId: "authority-1",
  generation: 1n,
  admittedThrough: 4n,
  visible,
});

describe("classifyDestructiveEffect", () => {
  it("reports only removed protected root units and projects pointwise to final rendering", () => {
    const before = [occurrence({ targetClock: 0, length: 4, rendering: "block-a" })];
    const afterCandidate = [
      occurrence({ targetClock: 10, rootClock: 0, length: 2, rendering: "new" }),
    ];
    expect(
      classifyDestructiveEffect({
        before,
        afterCandidate,
        protectionScope: [{ clientID: 9, clock: 0, length: 4 }],
        responseCut: cut(before),
        observation: { coveredFinalRenderings: [] },
      }),
    ).toEqual({
      eligibleRanges: [{ clientID: 1, clock: 2, length: 2 }],
      finalRenderingProjections: [
        { finalRendering: "block-a", ranges: [{ clientID: 1, clock: 2, length: 2 }] },
      ],
    });
  });

  it("reports every removed writer root regardless of observation", () => {
    const observed = occurrence({ targetClock: 0, length: 2, rendering: "mixed" });
    const postCut = occurrence({ targetClock: 2, rootClock: 2, length: 2, rendering: "mixed" });
    const result = classifyDestructiveEffect({
      before: [observed, postCut],
      afterCandidate: [],
      protectionScope: [],
      responseCut: cut([observed]),
      observation: { coveredFinalRenderings: ["mixed"] },
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
        protectionScope: [],
        responseCut: cut([]),
        observation: { coveredFinalRenderings: [] },
      }),
    ).toThrow(/length-preserving/);
  });
});
