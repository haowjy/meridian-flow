/** Immutable-base writer-impact preparation for branch-push trail projection. */
import {
  type AgentEditCodec,
  diffSnapshots,
  snapshotBlocks,
  toDocHandle,
  type UpdateJournal,
  type YProsemirrorDocumentModel,
} from "@meridian/agent-edit/integration";
import { createCollabYDoc, PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
import * as Y from "yjs";
import type { BranchSnapshot } from "./branch-coordinator.js";
import type {
  BranchJournalRow,
  PreparedPush,
  PreparedPushCommit,
  PushReceiptPayload,
} from "./branch-push-contracts.js";
import { buildReceipt } from "./branch-push-plan.js";
import {
  journalAttributionByChangedBlock,
  preparedTrailChanges,
} from "./branch-trail-projection.js";
import { partitionByBlockCoverage } from "./branch-update-attribution.js";
import type { RawTrailChange } from "./trail-read-kernel.js";

export type PushPreparationPhase = {
  branch: BranchSnapshot;
  rows: BranchJournalRow[];
  pushUpdate: Uint8Array;
  receipt: PushReceiptPayload;
  idempotencyKey: string;
  receiptId: string;
  rowBaselineStates: ReadonlyMap<number, Uint8Array>;
};

type PushPreparationInput = {
  journal: UpdateJournal;
  model: YProsemirrorDocumentModel;
  attributionCodec: AgentEditCodec;
};

export async function preparePushUnderLiveLock(
  input: PushPreparationInput,
  phase: PushPreparationPhase,
  lockCutUpdate: Uint8Array,
  receiptId = phase.receiptId,
): Promise<PreparedPush> {
  const lockCutDoc = createCollabYDoc({ gc: false });
  Y.applyUpdate(lockCutDoc, lockCutUpdate);
  const before = snapshotBlocks(toDocHandle(lockCutDoc), input.model, input.attributionCodec);
  const afterDoc = createCollabYDoc({ gc: false });
  try {
    Y.applyUpdate(afterDoc, lockCutUpdate);
    Y.applyUpdate(afterDoc, phase.pushUpdate);
    const after = snapshotBlocks(toDocHandle(afterDoc), input.model, input.attributionCodec);
    const candidateEffects = diffSnapshots(before, after);
    const journal = await input.journal.read(phase.branch.documentId);
    const beforeByHash = new Map(before.map((block) => [block.hash, block]));
    const writerImpactBlocks = new Set<string>();
    const resurrectionBodies = new Map<string, (typeof before)[number]>();
    const rowAssociatedEffects = new Set<string>();
    let protectedDeletionSeen = false;
    for (const row of phase.rows) {
      const baselineState = phase.rowBaselineStates.get(row.draftBaseUpdateSeq);
      if (!baselineState) throw new Error(`missing immutable draft base ${row.draftBaseUpdateSeq}`);
      const coverage = partitionByBlockCoverage({
        baselineState,
        upstreamState: lockCutUpdate,
        rows: journal.updates
          .filter((update) => update.seq > row.draftBaseUpdateSeq)
          .map((update) => ({
            id: update.seq,
            source: update.meta.origin.startsWith("human:") ? "writer" : "agent",
            actorTurnId: update.meta.actorTurnId,
            update: update.update,
          })),
        model: input.model,
        codec: input.attributionCodec,
      });
      const humanTouched = new Set(coverage.humanResidualHashes);
      for (const [hash, owner] of coverage.coverage) {
        if (owner.origin === "writer") humanTouched.add(hash);
      }
      for (const [hash, owner] of coverage.deletedCoverage) {
        if (owner.origin === "writer") humanTouched.add(hash);
      }
      for (const hash of coverage.humanDeletedHashes) humanTouched.add(hash);

      const rowAfterDoc = createCollabYDoc({ gc: false });
      Y.applyUpdate(rowAfterDoc, lockCutUpdate);
      Y.applyUpdate(rowAfterDoc, row.updateData);
      const rowAfter = snapshotBlocks(
        toDocHandle(rowAfterDoc),
        input.model,
        input.attributionCodec,
      );
      rowAfterDoc.destroy();
      const rowEffects = diffSnapshots(before, rowAfter);
      for (const hash of [...rowEffects.changed, ...rowEffects.deleted, ...rowEffects.inserted]) {
        rowAssociatedEffects.add(hash);
      }
      for (const hash of [...rowEffects.changed, ...rowEffects.deleted]) {
        if (
          humanTouched.has(hash) &&
          (candidateEffects.changed.has(hash) || candidateEffects.deleted.has(hash))
        ) {
          writerImpactBlocks.add(hash);
        }
      }

      const baselineDoc = createCollabYDoc({ gc: false });
      Y.applyUpdate(baselineDoc, baselineState);
      const baselineBlocks = snapshotBlocks(
        toDocHandle(baselineDoc),
        input.model,
        input.attributionCodec,
      );
      baselineDoc.destroy();
      const baselineByHash = new Map(baselineBlocks.map((block) => [block.hash, block]));
      const protectedDeletedHashes = new Set(coverage.humanDeletedHashes);
      for (const [hash, owner] of coverage.deletedCoverage) {
        if (owner.origin === "writer" && !beforeByHash.has(hash)) protectedDeletedHashes.add(hash);
      }
      const deletedBaselineBlocks = [...protectedDeletedHashes].flatMap((hash) => {
        const block = baselineByHash.get(hash);
        return block ? [block] : [];
      });
      if (deletedBaselineBlocks.length > 0) protectedDeletionSeen = true;
      for (const insertedHash of rowEffects.inserted) {
        if (!candidateEffects.inserted.has(insertedHash)) continue;
        const inserted = after.find((block) => block.hash === insertedHash);
        if (!inserted) continue;
        const deletedBase = deletedBaselineBlocks.find(
          (block) => block.clientID === inserted.clientID && block.clock === inserted.clock,
        );
        if (deletedBase) {
          resurrectionBodies.set(insertedHash, deletedBase);
          writerImpactBlocks.add(insertedHash);
        } else if (deletedBaselineBlocks.length > 0) {
          writerImpactBlocks.add(insertedHash);
        }
      }
    }
    if (protectedDeletionSeen && phase.rows.length > 0) {
      for (const insertedHash of candidateEffects.inserted) {
        if (!rowAssociatedEffects.has(insertedHash)) {
          writerImpactBlocks.add(insertedHash);
        }
      }
    }
    const attribution = journalAttributionByChangedBlock({
      liveDoc: lockCutDoc,
      rows: phase.rows,
      model: input.model,
    });
    const afterBlocks = input.model.getBlocks(toDocHandle(afterDoc));
    const afterXmlBlocks = afterDoc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME).toArray();
    const afterById = new Map(
      afterBlocks.flatMap((block, index) => {
        const xml = afterXmlBlocks[index];
        return xml instanceof Y.XmlElement ? [[input.model.getBlockId(block), xml] as const] : [];
      }),
    );
    const afterIds = new Set(after.map((block) => block.hash));
    const beforeBodies = new Map(before.map((block) => [block.hash, block.serialized]));
    for (const [hash, block] of resurrectionBodies) beforeBodies.set(hash, block.serialized);
    const blockIdentities = new Map(
      [...before, ...after].map(
        (block) =>
          [
            block.hash,
            {
              documentId: phase.branch.documentId,
              clientID: block.clientID,
              clock: block.clock,
            },
          ] as const,
      ),
    );
    const changes: RawTrailChange[] = preparedTrailChanges({
      receipt: buildReceipt({
        model: input.model,
        documentId: phase.branch.documentId,
        branch: phase.branch,
        pushKind: phase.receipt.pushKind,
        beforeDoc: lockCutDoc,
        afterDoc,
      }),
      receiptId,
      ownersByBlock: attribution.ownersByBlock,
      operations: attribution.operations.map((operation) => ({
        ...operation,
        insertedBlocks: operation.insertedBlockIds.flatMap((blockId) => {
          const block = afterById.get(blockId);
          return block ? [{ blockId, block }] : [];
        }),
      })),
      writerImpactBlocks: [...writerImpactBlocks].sort(),
      before,
      blockIdentities,
      beforeBodies,
      afterIds,
      afterById,
      afterDoc,
      beforeContentRef: journal.updates.at(-1)?.seq ?? null,
      resurrectionBodies: new Map(
        [...resurrectionBodies].map(([hash, block]) => [hash, block.serialized]),
      ),
    });
    return {
      beforeContentRef: journal.updates.at(-1)?.seq ?? null,
      trailChanges: changes,
      lockCutUpdate,
      prepared: {
        branch: phase.branch,
        journalRows: phase.rows,
        pushUpdate: phase.pushUpdate,
        receiptPayload: buildReceipt({
          model: input.model,
          documentId: phase.branch.documentId,
          branch: phase.branch,
          pushKind: phase.receipt.pushKind,
          beforeDoc: lockCutDoc,
          afterDoc,
        }),
        idempotencyKey: phase.idempotencyKey,
        receiptId,
      } satisfies Omit<PreparedPushCommit, "pushedByUserId" | "trail" | "pendingLiveSettlement">,
    };
  } finally {
    afterDoc.destroy();
    lockCutDoc.destroy();
  }
}
