/** Per-writer, causal policy for elevating ephemeral AI change marks. */

import {
  type AgentEditCodec,
  type BlockSnapshot,
  intersectLineageRanges,
  normalizeLineageRanges,
  snapshotBlocks,
  subtractLineageRanges,
  toDocHandle,
  type WriterLineageRange,
  type YProsemirrorDocumentModel,
} from "@meridian/agent-edit/integration";
import type { UserId } from "@meridian/contracts/runtime";
import { createCollabYDoc } from "@meridian/prosemirror-schema";
import * as Y from "yjs";
import type { PendingLiveSettlement } from "./branch-push-contracts.js";
import {
  journalInsertionRanges,
  materializeRootLineageForDoc,
  type RootLineageRun,
} from "./provenance.js";
import { canonicalBlockKey } from "./trail-read-kernel.js";

export type SweepEvidence = {
  candidates: ReadonlyArray<{
    precedingUpdates: readonly Uint8Array[];
    update: Uint8Array;
    byUser: ReadonlyArray<{
      userId: UserId;
      rootsAfterObservationWatermark: readonly WriterLineageRange[];
    }>;
  }>;
};

export type SweptChangesByRecipient = ReadonlyMap<UserId, ReadonlySet<string>>;

export function materializeSweepEvidence(input: {
  rows: readonly {
    journalRowId: bigint;
    originType: string | null;
    actorUserId: string | null;
    update: Uint8Array;
  }[];
  candidates: readonly {
    precedingUpdates: readonly Uint8Array[];
    update: Uint8Array;
    observedBaseUpdateSeq: number;
    /** Neutral checkpoint floor: later sync payloads cannot claim these old roots. */
    retainedRoots: readonly WriterLineageRange[];
  }[];
}): SweepEvidence {
  return {
    candidates: input.candidates.map((candidate) => ({
      precedingUpdates: candidate.precedingUpdates,
      update: candidate.update,
      byUser: [
        ...recentWriterRootsByUser(
          input.rows,
          candidate.observedBaseUpdateSeq,
          candidate.retainedRoots,
        ),
      ].map(([userId, rootsAfterObservationWatermark]) => ({
        userId,
        rootsAfterObservationWatermark,
      })),
    })),
  };
}

export function detectSweptChanges(input: {
  pending: PendingLiveSettlement;
  prePushDoc: Y.Doc;
  model: YProsemirrorDocumentModel;
  codec: AgentEditCodec;
}): SweptChangesByRecipient {
  if (!input.pending.sweepEvidence) return new Map();
  const changesByRecipient = new Map<UserId, Set<string>>();
  for (const candidate of input.pending.sweepEvidence.candidates) {
    const candidateBeforeDoc = createCollabYDoc({ gc: false });
    const candidateAfterDoc = createCollabYDoc({ gc: false });
    try {
      Y.applyUpdate(candidateBeforeDoc, Y.encodeStateAsUpdate(input.prePushDoc));
      for (const update of candidate.precedingUpdates) Y.applyUpdate(candidateBeforeDoc, update);
      Y.applyUpdate(candidateAfterDoc, Y.encodeStateAsUpdate(candidateBeforeDoc));
      Y.applyUpdate(candidateAfterDoc, candidate.update);

      const beforeBlocks = snapshotBlocks(
        toDocHandle(candidateBeforeDoc),
        input.model,
        input.codec,
      );
      const beforeLineage = materializeRootLineageForDoc(candidateBeforeDoc);
      const survivingRoots = materializeRootLineageForDoc(candidateAfterDoc).map((run) => run.root);
      for (const evidence of candidate.byUser) {
        const affectedIdentities = affectedBlockIdentities({
          documentId: input.pending.push.documentId,
          beforeBlocks,
          beforeLineage,
          survivingRoots,
          recipientRoots: evidence.rootsAfterObservationWatermark,
        });
        for (const change of input.pending.trail.changes) {
          if (
            !change.beforeBlockIdentity ||
            !affectedIdentities.has(canonicalBlockKey(change.beforeBlockIdentity))
          ) {
            continue;
          }
          const changeIds = changesByRecipient.get(evidence.userId) ?? new Set<string>();
          changeIds.add(change.changeId);
          changesByRecipient.set(evidence.userId, changeIds);
        }
      }
    } finally {
      candidateBeforeDoc.destroy();
      candidateAfterDoc.destroy();
    }
  }
  return changesByRecipient;
}

function affectedBlockIdentities(input: {
  documentId: string;
  beforeBlocks: readonly BlockSnapshot[];
  beforeLineage: readonly RootLineageRun[];
  survivingRoots: readonly WriterLineageRange[];
  recipientRoots: readonly WriterLineageRange[];
}): Set<string> {
  const visibleBeforeRoots = input.beforeLineage.map((run) => run.root);
  const deletedRecipientRoots = subtractLineageRanges(
    intersectLineageRanges(visibleBeforeRoots, input.recipientRoots),
    input.survivingRoots,
  );
  if (deletedRecipientRoots.length === 0) return new Set();

  const deletedTargets = input.beforeLineage.flatMap((run) =>
    intersectLineageRanges([run.root], deletedRecipientRoots).map((root) => ({
      clientID: run.target.clientID,
      clock: run.target.clock + root.clock - run.root.clock,
      length: root.length,
    })),
  );
  return new Set(
    input.beforeBlocks.flatMap((block) =>
      intersectLineageRanges(block.lineage, deletedTargets).length === 0
        ? []
        : [
            canonicalBlockKey({
              documentId: input.documentId,
              clientID: block.clientID,
              clock: block.clock,
            }),
          ],
    ),
  );
}

function recentWriterRootsByUser(
  rows: readonly {
    journalRowId: bigint;
    originType: string | null;
    actorUserId: string | null;
    update: Uint8Array;
  }[],
  observedBaseUpdateSeq: number,
  retainedRoots: readonly WriterLineageRange[],
): Map<UserId, WriterLineageRange[]> {
  const rootsByUser = new Map<UserId, WriterLineageRange[]>();
  let coveredRoots = normalizeLineageRanges(retainedRoots);
  for (const row of rows) {
    const insertedRoots = normalizeLineageRanges(journalInsertionRanges(row.update));
    const firstBornRoots = subtractLineageRanges(insertedRoots, coveredRoots);
    coveredRoots = normalizeLineageRanges([...coveredRoots, ...insertedRoots]);
    if (
      row.originType !== "human" ||
      !row.actorUserId ||
      row.journalRowId <= BigInt(observedBaseUpdateSeq) ||
      firstBornRoots.length === 0
    ) {
      continue;
    }
    const userId = row.actorUserId as UserId;
    rootsByUser.set(userId, [...(rootsByUser.get(userId) ?? []), ...firstBornRoots]);
  }
  for (const [userId, roots] of rootsByUser) {
    rootsByUser.set(userId, normalizeLineageRanges(roots));
  }
  return rootsByUser;
}
