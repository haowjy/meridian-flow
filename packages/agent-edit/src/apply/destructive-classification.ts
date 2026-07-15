// Lifecycle-neutral destructive-effect classification over canonical provenance ranges.

import {
  intersectLineageRanges,
  type LineageRange,
  lineageRangesContain,
  normalizeLineageRanges,
  type ResponseCausalCutV1,
  subtractLineageRanges,
} from "../lineage/range-set.js";
import type { ContentLineage } from "../ports/model.js";
import type { BlockSnapshot } from "./echo.js";

export type SafetyProvenance = "writer_protected" | "agent";

export interface VisibleProseOccurrence {
  /** Current canonical target units. */
  target: LineageRange;
  /** Length-preserving target-to-root-offset mapping. */
  root: LineageRange;
  provenance: SafetyProvenance;
  /** Stable key for the exact final-pre-candidate rendering containing the target. */
  finalRendering: string;
}

export interface DestructiveObservation {
  /** Final renderings exactly covered by this response's immutable observation snapshot. */
  coveredFinalRenderings: readonly string[];
}

export interface DestructiveEffectInput {
  before: readonly VisibleProseOccurrence[];
  afterCandidate: readonly VisibleProseOccurrence[];
  protectionScope: readonly LineageRange[];
  responseCut: ResponseCausalCutV1 & { visible: readonly VisibleProseOccurrence[] };
  observation: DestructiveObservation;
}

export interface FinalRenderingProjection {
  finalRendering: string;
  ranges: LineageRange[];
}

export interface DestructiveEffect {
  eligibleRanges: LineageRange[];
  finalRenderingProjections: FinalRenderingProjection[];
}

/**
 * Compute the shared pointwise destructive effect. Enforcement is intentionally absent:
 * tool-time callers deny this result, while settlement callers apply and trail it.
 */
export function classifyDestructiveEffect(input: DestructiveEffectInput): DestructiveEffect {
  validateOccurrences(input.before);
  validateOccurrences(input.afterCandidate);
  validateOccurrences(input.responseCut.visible);

  const survivingRoots = input.afterCandidate.map((occurrence) => occurrence.root);
  const cutTargets = input.responseCut.visible.map((occurrence) => occurrence.target);
  const lateProtectedRoots = input.before.flatMap((occurrence) => {
    if (occurrence.provenance !== "writer_protected") return [];
    const outsideCutTargets = subtractLineageRanges([occurrence.target], cutTargets);
    return outsideCutTargets.map((target) => targetSliceToRoot(occurrence, target));
  });
  const protectedRoots = normalizeLineageRanges([...input.protectionScope, ...lateProtectedRoots]);
  const coveredRenderings = new Set(input.observation.coveredFinalRenderings);
  const eligibleByRendering = new Map<string, LineageRange[]>();

  for (const occurrence of input.before) {
    const protectedParts = intersectLineageRanges([occurrence.root], protectedRoots);
    for (const protectedRoot of protectedParts) {
      const deletedRoot = subtractLineageRanges([protectedRoot], survivingRoots);
      for (const deleted of deletedRoot) {
        const target = rootSliceToTarget(occurrence, deleted);
        const wasInCut = lineageRangesContain(cutTargets, target);
        if (wasInCut && coveredRenderings.has(occurrence.finalRendering)) continue;
        const group = eligibleByRendering.get(occurrence.finalRendering) ?? [];
        group.push(target);
        eligibleByRendering.set(occurrence.finalRendering, group);
      }
    }
  }

  const finalRenderingProjections = [...eligibleByRendering.entries()].map(
    ([finalRendering, ranges]) => ({ finalRendering, ranges: normalizeLineageRanges(ranges) }),
  );
  return {
    eligibleRanges: normalizeLineageRanges(
      finalRenderingProjections.flatMap((projection) => projection.ranges),
    ),
    finalRenderingProjections,
  };
}

function validateOccurrences(occurrences: readonly VisibleProseOccurrence[]): void {
  for (const occurrence of occurrences) {
    if (occurrence.target.length !== occurrence.root.length) {
      throw new Error("Provenance continuation must be length-preserving");
    }
    normalizeLineageRanges([occurrence.target]);
    normalizeLineageRanges([occurrence.root]);
  }
}

function targetSliceToRoot(occurrence: VisibleProseOccurrence, target: LineageRange): LineageRange {
  return {
    clientID: occurrence.root.clientID,
    clock: occurrence.root.clock + target.clock - occurrence.target.clock,
    length: target.length,
  };
}

function rootSliceToTarget(occurrence: VisibleProseOccurrence, root: LineageRange): LineageRange {
  return {
    clientID: occurrence.target.clientID,
    clock: occurrence.target.clock + root.clock - occurrence.root.clock,
    length: root.length,
  };
}

// Compatibility adapter for the current block snapshot safety gate. It routes through the
// shared classifier; provenance materialization will replace this adapter at the merge seam.
export interface DestructiveClassificationInput {
  before: readonly BlockSnapshot[];
  after: readonly BlockSnapshot[];
  protectedLineage: readonly ContentLineage[];
  lineageOrigins: readonly (ContentLineage & { origin: "human" | "agent" })[];
}

export function classifyDestructiveBlocks(input: DestructiveClassificationInput): BlockSnapshot[] {
  const before = legacyOccurrences(input.before, input.lineageOrigins);
  const afterCandidate = legacyOccurrences(input.after, input.lineageOrigins);
  const result = classifyDestructiveEffect({
    before,
    afterCandidate,
    // The legacy argument describes the observed/baseline set, so its complement is protected.
    protectionScope: before
      .filter(
        (occurrence) =>
          occurrence.provenance === "writer_protected" &&
          !lineageRangesContain(input.protectedLineage, occurrence.target),
      )
      .map((occurrence) => occurrence.root),
    responseCut: {
      id: "legacy-snapshot-adapter",
      version: 1,
      documentId: "legacy-snapshot-adapter",
      authorityId: "legacy-snapshot-adapter",
      generation: 0n,
      admittedThrough: 0n,
      visible: before,
    },
    observation: { coveredFinalRenderings: [] },
  });
  const affected = new Set(
    result.finalRenderingProjections.map((projection) => projection.finalRendering),
  );
  return input.before.filter((block) => affected.has(block.hash));
}

function legacyOccurrences(
  blocks: readonly BlockSnapshot[],
  origins: readonly (ContentLineage & { origin: "human" | "agent" })[],
): VisibleProseOccurrence[] {
  return blocks.flatMap((block) =>
    (block.lineage ?? []).map((lineage) => ({
      target: lineage,
      root: lineage,
      provenance: origins.some(
        (origin) => origin.origin === "agent" && lineageRangesContain([origin], lineage),
      )
        ? ("agent" as const)
        : ("writer_protected" as const),
      finalRendering: block.hash,
    })),
  );
}
