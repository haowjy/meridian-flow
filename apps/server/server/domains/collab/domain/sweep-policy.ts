/** Per-writer, causal policy for elevating ephemeral AI change marks. */

import {
  type AgentEditCodec,
  classifyDestructiveSnapshotEffect,
  snapshotBlocks,
  toDocHandle,
  type WriterLineageRange,
  type YProsemirrorDocumentModel,
} from "@meridian/agent-edit/integration";
import type { UserId } from "@meridian/contracts/runtime";
import { createCollabYDoc } from "@meridian/prosemirror-schema";
import * as Y from "yjs";
import type { PendingLiveSettlement } from "./branch-push-contracts.js";
import {
  type AttributedJournalRow,
  type AttributionRunV1,
  journalInsertionRanges,
  materializeCandidateProvenance,
  materializeProvenanceForDoc,
  type ProvenanceRun,
} from "./provenance.js";
import { canonicalBlockKey } from "./trail-read-kernel.js";

export const SWEEP_RECIPIENT_CAP = 100;

export type SweepEvidence = {
  byUser: ReadonlyArray<{ userId: UserId; provenance: readonly ProvenanceRun[] }>;
};

export type SweptChangeRecipients = ReadonlyMap<string, ReadonlySet<UserId>>;

export function materializeSweepEvidence(input: {
  doc: Y.Doc;
  rows: readonly AttributedJournalRow[];
  observedBaseUpdateSeq: number;
  retainedAttributions?: readonly AttributionRunV1[];
}): SweepEvidence {
  const visible = materializeProvenanceForDoc({
    doc: input.doc,
    rows: input.rows,
    retainedAttributions: input.retainedAttributions,
    fallbackBirthClass: "agent",
  });
  const rootsByUser = new Map<UserId, WriterLineageRange[]>();
  for (const row of input.rows) {
    if (
      row.originType !== "human" ||
      !row.actorUserId ||
      row.journalRowId <= BigInt(input.observedBaseUpdateSeq)
    ) {
      continue;
    }
    const userId = row.actorUserId as UserId;
    rootsByUser.set(userId, [
      ...(rootsByUser.get(userId) ?? []),
      ...journalInsertionRanges(row.update),
    ]);
  }

  return {
    byUser: [...rootsByUser.entries()].slice(-SWEEP_RECIPIENT_CAP).map(([userId, roots]) => ({
      userId,
      provenance: projectWriterProvenance(visible, roots),
    })),
  };
}

export function detectSweptChanges(input: {
  pending: PendingLiveSettlement;
  prePushDoc: Y.Doc;
  model: YProsemirrorDocumentModel;
  codec: AgentEditCodec;
}): SweptChangeRecipients {
  if (!input.pending.sweepEvidence) return new Map();
  const before = snapshotBlocks(toDocHandle(input.prePushDoc), input.model, input.codec);
  const afterDoc = createCollabYDoc({ gc: false });
  try {
    Y.applyUpdate(afterDoc, Y.encodeStateAsUpdate(input.prePushDoc));
    Y.applyUpdate(afterDoc, input.pending.pushUpdate);
    const after = snapshotBlocks(toDocHandle(afterDoc), input.model, input.codec);
    const recipients = new Map<string, Set<UserId>>();
    for (const evidence of input.pending.sweepEvidence.byUser) {
      const afterProvenance = materializeCandidateProvenance(afterDoc, evidence.provenance);
      const { affectedBefore } = classifyDestructiveSnapshotEffect({
        before,
        afterCandidate: after,
        beforeProvenance: evidence.provenance.map((run) => ({
          target: run.target,
          root: run.root,
          provenance: run.birthClass,
        })),
        afterCandidateProvenance: afterProvenance.map((run) => ({
          target: run.target,
          root: run.root,
          provenance: run.birthClass,
        })),
      });
      const affectedIdentities = new Set(
        affectedBefore.map(({ block }) =>
          canonicalBlockKey({
            documentId: input.pending.push.documentId,
            clientID: block.clientID,
            clock: block.clock,
          }),
        ),
      );
      for (const change of input.pending.trail.changes) {
        if (
          !change.beforeBlockIdentity ||
          !affectedIdentities.has(canonicalBlockKey(change.beforeBlockIdentity))
        ) {
          continue;
        }
        const users = recipients.get(change.changeId) ?? new Set<UserId>();
        users.add(evidence.userId);
        recipients.set(change.changeId, users);
      }
    }
    return recipients;
  } finally {
    afterDoc.destroy();
  }
}

function projectWriterProvenance(
  visible: readonly ProvenanceRun[],
  writerRoots: readonly WriterLineageRange[],
): ProvenanceRun[] {
  const projected: ProvenanceRun[] = [];
  for (const run of visible) {
    for (let offset = 0; offset < run.root.length; offset += 1) {
      const root = { clientID: run.root.clientID, clock: run.root.clock + offset, length: 1 };
      const target = {
        clientID: run.target.clientID,
        clock: run.target.clock + offset,
        length: 1,
      };
      const birthClass = writerRoots.some(
        (candidate) =>
          candidate.clientID === root.clientID &&
          candidate.clock <= root.clock &&
          candidate.clock + candidate.length > root.clock,
      )
        ? "writer_protected"
        : "agent";
      const previous = projected.at(-1);
      if (
        previous &&
        previous.birthClass === birthClass &&
        previous.target.clientID === target.clientID &&
        previous.target.clock + previous.target.length === target.clock &&
        previous.root.clientID === root.clientID &&
        previous.root.clock + previous.root.length === root.clock
      ) {
        previous.target.length += 1;
        previous.root.length += 1;
      } else {
        projected.push({ target, root, birthClass });
      }
    }
  }
  return projected;
}
