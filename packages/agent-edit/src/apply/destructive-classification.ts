// Lifecycle-neutral destructive-effect classification over canonical provenance ranges.

import * as Y from "yjs";
import type { AgentEditCodec } from "../codec-adapter.js";
import { type DocHandle, toDocHandle } from "../handles.js";
import {
  intersectLineageRanges,
  type LineageRange,
  lineageRangesContain,
  normalizeLineageRanges,
  type ResponseCausalCutV1,
  subtractLineageRanges,
} from "../lineage/range-set.js";
import { digestRenderedContent, observationCoversRendering } from "../observation-snapshot.js";
import type { AgentEditModel, ContentLineage } from "../ports/model.js";
import type { ObservationSnapshot } from "../ports/observation-snapshot.js";
import type { DestructiveProvenanceRun, UpdateJournal } from "../ports/update-journal.js";
import { type BlockSnapshot, snapshotBlocks } from "./echo.js";

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

/** Compute the shared pointwise destructive effect without imposing lifecycle policy. */
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

export interface DestructiveDocumentEffectInput {
  documentId: string;
  before: DocHandle;
  afterCandidate: DocHandle;
  observationSnapshot: ObservationSnapshot | null;
  observedBlocks?: readonly BlockSnapshot[];
  attributedLineage?: readonly (ContentLineage & { origin: "human" | "agent" })[];
}

/**
 * Materializes durable provenance, then delegates destructive policy to
 * classifyDestructiveEffect. This is the reporting boundary for live commits.
 */
export async function classifyDestructiveDocumentEffect(
  deps: {
    journal: UpdateJournal;
    model: AgentEditModel;
    codec: AgentEditCodec;
  },
  input: DestructiveDocumentEffectInput,
): Promise<BlockSnapshot[]> {
  const beforeBlocks = snapshotBlocks(input.before, deps.model, deps.codec);
  const afterBlocks = snapshotBlocks(input.afterCandidate, deps.model, deps.codec);
  const provenance = deps.journal.materializeDestructiveProvenance
    ? await deps.journal.materializeDestructiveProvenance({
        docId: input.documentId,
        before: input.before,
        afterCandidate: input.afterCandidate,
      })
    : await reconstructConservativeProvenance({
        ...deps,
        documentId: input.documentId,
        beforeBlocks,
        afterBlocks,
      });
  const before = occurrencesFor(
    beforeBlocks,
    applyAttributedLineage(provenance.before, input.attributedLineage ?? []),
  );
  const afterCandidate = occurrencesFor(
    afterBlocks,
    applyAttributedLineage(provenance.afterCandidate, input.attributedLineage ?? []),
  );
  const observedLineage = (input.observedBlocks ?? [])
    .filter((block) => wasObserved(input.observationSnapshot, input.documentId, block))
    .flatMap((block) => block.lineage ?? []);
  const effect = classifyDestructiveEffect({
    before,
    afterCandidate,
    protectionScope: before
      .filter(
        (occurrence) =>
          occurrence.provenance === "writer_protected" &&
          !lineageRangesContain(observedLineage, occurrence.target),
      )
      .map((occurrence) => occurrence.root),
    responseCut: {
      id: "live-commit-current-rendering",
      version: 1,
      documentId: input.documentId,
      authorityId: "live-commit-current-rendering",
      generation: 0n,
      admittedThrough: 0n,
      visible: before,
    },
    observation: {
      coveredFinalRenderings: beforeBlocks.flatMap((block) =>
        wasObserved(input.observationSnapshot, input.documentId, block)
          ? [finalRenderingKey(block)]
          : [],
      ),
    },
  });
  const affected = new Set(
    effect.finalRenderingProjections.map((projection) => projection.finalRendering),
  );
  return beforeBlocks.filter((block) => affected.has(finalRenderingKey(block)));
}

function applyAttributedLineage(
  runs: readonly DestructiveProvenanceRun[],
  attributions: readonly (ContentLineage & { origin: "human" | "agent" })[],
): DestructiveProvenanceRun[] {
  return runs.flatMap((run) => {
    const attributed = attributions.flatMap((attribution) =>
      intersectLineageRanges([run.target], [attribution]).map((target) => ({
        target,
        root: provenanceTargetSliceToRoot(run, target),
        provenance:
          attribution.origin === "agent" ? ("agent" as const) : ("writer_protected" as const),
      })),
    );
    const unexplained = subtractLineageRanges(
      [run.target],
      attributed.map((item) => item.target),
    ).map((target) => ({
      target,
      root: provenanceTargetSliceToRoot(run, target),
      provenance: run.provenance,
    }));
    return [...attributed, ...unexplained];
  });
}

function occurrencesFor(
  blocks: readonly BlockSnapshot[],
  provenance: readonly DestructiveProvenanceRun[],
): VisibleProseOccurrence[] {
  return blocks.flatMap((block) =>
    provenance.flatMap((run) =>
      intersectLineageRanges(block.lineage ?? [], [run.target]).map((target) => ({
        target,
        root: provenanceTargetSliceToRoot(run, target),
        provenance: run.provenance,
        finalRendering: finalRenderingKey(block),
      })),
    ),
  );
}

function finalRenderingKey(block: BlockSnapshot): string {
  return `${block.clientID ?? "?"}:${block.clock ?? "?"}:${block.renderedContent ?? ""}`;
}

function wasObserved(
  snapshot: ObservationSnapshot | null,
  documentId: string,
  block: BlockSnapshot,
): boolean {
  if (
    block.clientID === undefined ||
    block.clock === undefined ||
    block.renderedContent === undefined
  ) {
    return false;
  }
  const observation = snapshot?.entries.find(
    (entry) =>
      entry.documentId === documentId &&
      entry.clientID === block.clientID &&
      entry.clock === block.clock,
  );
  return observationCoversRendering({
    observation: observation?.value ?? null,
    renderedContent: block.renderedContent,
    digestRenderedContent,
  });
}

async function reconstructConservativeProvenance(input: {
  journal: UpdateJournal;
  model: AgentEditModel;
  codec: AgentEditCodec;
  documentId: string;
  beforeBlocks: readonly BlockSnapshot[];
  afterBlocks: readonly BlockSnapshot[];
}): Promise<{
  before: DestructiveProvenanceRun[];
  afterCandidate: DestructiveProvenanceRun[];
}> {
  const snapshot = input.journal.readAttribution
    ? await input.journal.readAttribution(input.documentId)
    : await input.journal.read(input.documentId);
  const replay = new Y.Doc({ gc: false });
  try {
    if (snapshot.checkpoint) Y.applyUpdate(replay, snapshot.checkpoint);
    const agentRoots: LineageRange[] = [];
    for (const row of snapshot.updates) {
      const before = visibleLineage(snapshotBlocks(toDocHandle(replay), input.model, input.codec));
      Y.applyUpdate(replay, row.update);
      if (!row.meta.origin.startsWith("agent:")) continue;
      const after = visibleLineage(snapshotBlocks(toDocHandle(replay), input.model, input.codec));
      agentRoots.push(...subtractLineageRanges(after, before));
    }
    const before = provenanceForKnownRoots(input.beforeBlocks, agentRoots);
    return {
      before,
      afterCandidate: candidateProvenance(input.afterBlocks, before),
    };
  } finally {
    replay.destroy();
  }
}

function visibleLineage(blocks: readonly BlockSnapshot[]): LineageRange[] {
  return blocks.flatMap((block) => block.lineage ?? []);
}

function provenanceForKnownRoots(
  blocks: readonly BlockSnapshot[],
  agentRoots: readonly LineageRange[],
): DestructiveProvenanceRun[] {
  return visibleLineage(blocks).flatMap((target) => {
    const agent = intersectLineageRanges([target], agentRoots);
    const writer = subtractLineageRanges([target], agent);
    return [
      ...agent.map((range) => ({ target: range, root: range, provenance: "agent" as const })),
      ...writer.map((range) => ({
        target: range,
        root: range,
        provenance: "writer_protected" as const,
      })),
    ];
  });
}

function candidateProvenance(
  blocks: readonly BlockSnapshot[],
  retained: readonly DestructiveProvenanceRun[],
): DestructiveProvenanceRun[] {
  return visibleLineage(blocks).flatMap((target) => {
    const retainedRuns = retained.flatMap((run) =>
      intersectLineageRanges([target], [run.target]).map((intersection) => ({
        target: intersection,
        root: provenanceTargetSliceToRoot(run, intersection),
        provenance: run.provenance,
      })),
    );
    const fresh = subtractLineageRanges(
      [target],
      retainedRuns.map((run) => run.target),
    ).map((range) => ({ target: range, root: range, provenance: "agent" as const }));
    return [...retainedRuns, ...fresh];
  });
}

function provenanceTargetSliceToRoot(
  run: Pick<DestructiveProvenanceRun, "target" | "root">,
  target: LineageRange,
): LineageRange {
  return {
    clientID: run.root.clientID,
    clock: run.root.clock + target.clock - run.target.clock,
    length: target.length,
  };
}
