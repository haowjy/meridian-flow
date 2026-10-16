/** Projects a locked branch push into durable change-trail rows. */
import {
  type AgentEditCodecFactory,
  snapshotBlocks,
  toDocHandle,
  type YProsemirrorDocumentModel,
} from "@meridian/agent-edit/integration";
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import { createCollabYDoc, PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
import * as Y from "yjs";
import type { BranchSnapshot } from "./branch-coordinator.js";
import type { BranchJournalRow, PreparedPush } from "./branch-push-contracts.js";
import { publicationBlockChanges } from "./branch-push-plan.js";
import {
  draftPriorDoc,
  journalAttributionByChangedBlock,
  preparedTrailChanges,
} from "./branch-trail-projection.js";
import { type DocumentLinkScopes, LIVE_VIEW } from "./ports/document-link-scope.js";
import type { RawTrailChange } from "./trail-read-kernel.js";

export type PushPreparationPhase = {
  branch: BranchSnapshot;
  /** The draft rows whose chats own the trail: a content Apply moves none, so the pending rows name them. */
  rows: BranchJournalRow[];
  pushUpdate: Uint8Array;
  idempotencyKey: string;
  receiptId: string;
};

type PushPreparationInput = {
  model: YProsemirrorDocumentModel;
  codec: AgentEditCodecFactory;
  /** The push's open scope: the trail text the writer reads spells through it. */
  links: DocumentLinkScopes;
};

/** A content Apply moves no draft rows, so the chats behind the pending rows own what it writes. */
function contentApplyOwners(phase: PushPreparationPhase) {
  const owners: Array<{ threadId: ThreadId; turnId: TurnId }> = [];
  for (const row of phase.rows) {
    if (!row.threadId || !row.turnId) continue;
    const { threadId, turnId } = row;
    if (!owners.some((o) => o.threadId === threadId && o.turnId === turnId)) {
      owners.push({ threadId, turnId });
    }
  }
  return owners.length > 0 ? owners : undefined;
}

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
    const holder = { documentId: phase.branch.documentId, view: LIVE_VIEW };
    await input.links.prepare({ holders: [holder], docs: [lockCutDoc, afterDoc] });
    const codec = input.codec.forScope(input.links.holder(holder));
    const before = snapshotBlocks(toDocHandle(lockCutDoc), input.model, codec);
    const after = snapshotBlocks(toDocHandle(afterDoc), input.model, codec);
    const priorDoc = draftPriorDoc(phase.branch.state, phase.rows);
    const attribution = journalAttributionByChangedBlock({
      priorDoc,
      rows: phase.rows,
      model: input.model,
    });
    priorDoc.destroy();
    const afterXmlBlocks = afterDoc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME).toArray();
    const afterById = new Map(
      after.flatMap((block, index) => {
        const xml = afterXmlBlocks[index];
        return xml instanceof Y.XmlElement ? [[block.hash, xml] as const] : [];
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
    const beforeBodies = new Map(
      before.map((block) => [`${block.clientID}:${block.clock}`, block.serialized]),
    );
    const afterBodies = new Map(
      after.map((block) => [`${block.clientID}:${block.clock}`, block.serialized]),
    );
    const changedBlocks = publicationBlockChanges({
      model: input.model,
      beforeDoc: lockCutDoc,
      afterDoc,
      renderBlock(doc, block) {
        const identity = input.model.getCanonicalBlockIdentity(block);
        const body = (doc === lockCutDoc ? beforeBodies : afterBodies).get(
          `${identity.clientID}:${identity.clock}`,
        );
        if (body === undefined) throw new Error("Publication block is missing its rich snapshot");
        return body;
      },
    });
    const changes: RawTrailChange[] = preparedTrailChanges({
      documentId: phase.branch.documentId,
      changedBlocks,
      receiptId,
      ownersByBlock: attribution.ownersByBlock,
      fallbackOwners: contentApplyOwners(phase),
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
      attributionRows: phase.rows,
      lockCutUpdate,
      prepared: {
        branch: phase.branch,
        pushUpdate: phase.pushUpdate,
        idempotencyKey: phase.idempotencyKey,
        receiptId,
      } satisfies PreparedPush["prepared"],
    };
  } finally {
    afterDoc.destroy();
    lockCutDoc.destroy();
  }
}
