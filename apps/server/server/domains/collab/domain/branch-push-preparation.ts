/** Projects a locked branch push into durable change-trail rows. */
import {
  type AgentEditCodec,
  snapshotBlocks,
  toDocHandle,
  type YProsemirrorDocumentModel,
} from "@meridian/agent-edit/integration";
import { createCollabYDoc, PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
import * as Y from "yjs";
import type { BranchSnapshot } from "./branch-coordinator.js";
import type {
  BranchJournalRow,
  PreparedPush,
  PreparedPushCommit,
} from "./branch-push-contracts.js";
import { publicationBlockChanges } from "./branch-push-plan.js";
import {
  journalAttributionByChangedBlock,
  preparedTrailChanges,
} from "./branch-trail-projection.js";
import type { RawTrailChange } from "./trail-read-kernel.js";

export type PushPreparationPhase = {
  branch: BranchSnapshot;
  rows: BranchJournalRow[];
  pushUpdate: Uint8Array;
  idempotencyKey: string;
  receiptId: string;
};

type PushPreparationInput = {
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
  const afterDoc = createCollabYDoc({ gc: false });
  try {
    Y.applyUpdate(afterDoc, lockCutUpdate);
    Y.applyUpdate(afterDoc, phase.pushUpdate);
    const before = snapshotBlocks(toDocHandle(lockCutDoc), input.model, input.attributionCodec);
    const after = snapshotBlocks(toDocHandle(afterDoc), input.model, input.attributionCodec);
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
    const changedBlocks = publicationBlockChanges({
      model: input.model,
      beforeDoc: lockCutDoc,
      afterDoc,
    });
    const changes: RawTrailChange[] = preparedTrailChanges({
      documentId: phase.branch.documentId,
      changedBlocks,
      receiptId,
      ownersByBlock: attribution.ownersByBlock,
      operations: attribution.operations.map((operation) => ({
        ...operation,
        insertedBlocks: operation.insertedBlockIds.flatMap((blockId) => {
          const block = afterById.get(blockId);
          return block ? [{ blockId, block }] : [];
        }),
      })),
      before,
      blockIdentities,
      afterIds: new Set(after.map((block) => block.hash)),
      afterById,
      afterDoc,
    });
    return {
      trailChanges: changes,
      lockCutUpdate,
      prepared: {
        branch: phase.branch,
        journalRows: phase.rows,
        pushUpdate: phase.pushUpdate,
        idempotencyKey: phase.idempotencyKey,
        receiptId,
      } satisfies Omit<PreparedPushCommit, "pushedByUserId" | "trail" | "pendingLiveSettlement">,
    };
  } finally {
    afterDoc.destroy();
    lockCutDoc.destroy();
  }
}
