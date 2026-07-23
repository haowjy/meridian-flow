// Lifecycle-neutral destructive-effect classification over canonical provenance ranges.

import * as Y from "yjs";
import type { AgentEditCodec } from "../codec-adapter.js";
import type { DocHandle } from "../handles.js";
import {
  intersectLineageRanges,
  type LineageRange,
  normalizeLineageRanges,
  type ResponseCausalCutV1,
  subtractLineageRanges,
} from "../lineage/range-set.js";
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
  const protectedRoots = normalizeLineageRanges(
    input.before
      .filter((occurrence) => occurrence.provenance === "writer_protected")
      .map((occurrence) => occurrence.root),
  );
  const eligibleByRendering = new Map<string, LineageRange[]>();

  for (const occurrence of input.before) {
    const protectedParts = intersectLineageRanges([occurrence.root], protectedRoots);
    for (const protectedRoot of protectedParts) {
      const deletedRoot = subtractLineageRanges([protectedRoot], survivingRoots);
      for (const deleted of deletedRoot) {
        const target = rootSliceToTarget(occurrence, deleted);
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
  const effect = classifyDestructiveEffect({
    before,
    afterCandidate,
    protectionScope: before
      .filter((occurrence) => occurrence.provenance === "writer_protected")
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
    observation: { coveredFinalRenderings: [] },
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
  const agentRoots: LineageRange[] = [];
  for (const row of snapshot.updates) {
    if (!row.meta.origin.startsWith("agent:")) continue;
    agentRoots.push(
      ...Y.decodeUpdate(row.update).structs.map((struct) => ({
        clientID: struct.id.client,
        clock: struct.id.clock,
        length: struct.length,
      })),
    );
  }
  const before = provenanceForKnownRoots(input.beforeBlocks, agentRoots);
  return {
    before,
    afterCandidate: candidateProvenance(input.afterBlocks, before),
  };
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
