/** Reconciles offline live updates with journal-attributed agent deletions. */
import {
  type AgentEditCodec,
  getBlockItemId,
  type ObservationSnapshotStore,
  observationCoversRendering,
  snapshotBlocks,
  toDocHandle,
  type UpdateJournal,
  unwrapBlock,
  type YProsemirrorDocumentModel,
} from "@meridian/agent-edit";
import { createCollabYDoc } from "@meridian/prosemirror-schema";
import * as Y from "yjs";
import type { ChangeTrailPersistence } from "./ports/change-trail-persistence.js";
import {
  bodyFromHashline,
  type CanonicalBlockIdentityV1,
  canonicalBlockKey,
  deletionBoundaryTarget,
  type NavigationTargetV1,
  type TrailChangeV1,
} from "./trail-read-kernel.js";

type SnapshotBlock = {
  hash: string;
  serialized: string;
  renderedContent: string;
  clientID: number;
  clock: number;
  block: Y.XmlElement;
};

export type OfflineReconciliation = {
  reconcile(input: {
    documentId: string;
    incomingUpdate: Uint8Array;
    convergedState: Uint8Array;
  }): Promise<{ reported: number; degraded: boolean }>;
};

export function createOfflineReconciliation(deps: {
  journal: UpdateJournal;
  observations: ObservationSnapshotStore;
  changeTrails: Pick<ChangeTrailPersistence, "record">;
  model: YProsemirrorDocumentModel;
  codec: AgentEditCodec;
  digestRenderedContent(content: string): string;
  identifyUpdate(update: Uint8Array): string;
  resolveThreadId(turnId: string): Promise<string | null>;
  resolveDocumentTitle(documentId: string): Promise<string>;
}): OfflineReconciliation {
  return { reconcile };

  async function reconcile(input: {
    documentId: string;
    incomingUpdate: Uint8Array;
    convergedState: Uint8Array;
  }): Promise<{ reported: number; degraded: boolean }> {
    const journal = await deps.journal.read(input.documentId);
    const replay = createCollabYDoc({ gc: false });
    const converged = createCollabYDoc({ gc: false });
    let reported = 0;
    let degraded = false;
    try {
      if (journal.checkpoint) Y.applyUpdate(replay, journal.checkpoint);
      Y.applyUpdate(converged, input.convergedState);
      for (const row of journal.updates) {
        const beforeState = Y.encodeStateAsUpdate(replay);
        const before = snapshot(replay);
        Y.applyUpdate(replay, row.update);
        const after = snapshot(replay);
        const changed = changedBeforeBlocks(before, after);

        if (row.meta.origin.startsWith("human:")) continue;
        if (!row.meta.origin.startsWith("agent:") || !row.meta.authoringResponseId) continue;

        const preSync = createCollabYDoc({ gc: false });
        try {
          Y.applyUpdate(preSync, beforeState);
          Y.applyUpdate(preSync, input.incomingUpdate);
          const preSyncBlocks = snapshot(preSync);
          const convergedBlocks = snapshot(converged);
          const incomingWriterBlocks = new Set(
            [
              ...changedBeforeBlocks(before, preSyncBlocks),
              ...insertedBlocks(before, preSyncBlocks),
            ].map(identityKey),
          );
          for (const affected of changed) {
            // The sync-step-2 delta is writer-origin by definition. Prior ownership of
            // the edited block cannot erase that authorship.
            if (!incomingWriterBlocks.has(identityKey(affected))) continue;
            const writerBlock = findIdentity(preSyncBlocks, affected);
            if (!writerBlock) {
              degraded = true;
              continue;
            }
            const mergedBlock = findIdentity(convergedBlocks, affected);
            if (mergedBlock?.renderedContent === writerBlock.renderedContent) continue;
            const observation = await lookupObservation(
              deps.observations,
              row.meta.authoringResponseId,
              input.documentId,
              writerBlock,
            );
            if (
              observationCoversRendering({
                observation,
                renderedContent: writerBlock.renderedContent,
                digestRenderedContent: deps.digestRenderedContent,
              })
            ) {
              continue;
            }
            const turnId = row.meta.actorTurnId;
            const threadId = turnId ? await deps.resolveThreadId(turnId) : null;
            if (!turnId || !threadId) {
              degraded = true;
              continue;
            }
            await persistCollision({
              documentId: input.documentId,
              updateIdentity: deps.identifyUpdate(input.incomingUpdate),
              agentSeq: row.seq,
              writerBlock,
              mergedBlock,
              preSyncBlocks,
              converged,
              convergedBlocks,
              threadId,
              turnId,
            });
            reported += 1;
          }
        } finally {
          preSync.destroy();
        }
      }
      return { reported, degraded };
    } finally {
      replay.destroy();
      converged.destroy();
    }
  }

  async function persistCollision(input: {
    documentId: string;
    updateIdentity: string;
    agentSeq: number;
    writerBlock: SnapshotBlock;
    mergedBlock?: SnapshotBlock;
    preSyncBlocks: readonly SnapshotBlock[];
    converged: Y.Doc;
    convergedBlocks: readonly SnapshotBlock[];
    threadId: string;
    turnId: string;
  }): Promise<void> {
    const blockIdentity: CanonicalBlockIdentityV1 = {
      documentId: input.documentId,
      clientID: input.writerBlock.clientID,
      clock: input.writerBlock.clock,
    };
    const target = navigation(input);
    if (target.kind !== "deletion_boundary") return;
    const change: TrailChangeV1 = {
      changeId: `offline:${input.agentSeq}:${canonicalBlockKey(blockIdentity)}`,
      ordinal: 0,
      documentId: input.documentId,
      pushId: null,
      receiptId: `offline:${input.agentSeq}:${input.updateIdentity}`,
      kind: "delete",
      beforeBlockId: input.writerBlock.hash,
      afterBlockId: null,
      beforeBlockIdentity: blockIdentity,
      afterBlockIdentity: null,
      beforeText: input.writerBlock.serialized,
      afterTextAtReceipt: null,
      navigation: target,
      swept: {
        affectedBlockHash: input.writerBlock.hash,
        affectedBlockIdentity: blockIdentity,
        removed: bodyFromHashline(input.writerBlock.serialized),
        beforeContentRef: input.agentSeq - 1 || null,
      },
      writerProtection: {
        kind: "sweep",
        body: bodyFromHashline(input.writerBlock.serialized),
      },
      reversible: false,
    };
    await deps.changeTrails.record({
      trails: [
        {
          owner: { kind: "turn", threadId: input.threadId, turnId: input.turnId },
          changes: [change],
          counts: { changes: 1, swept: 1, documents: 1 },
        },
      ],
      documentTitles: new Map([
        [input.documentId, await deps.resolveDocumentTitle(input.documentId)],
      ]),
    });
  }

  function snapshot(doc: Y.Doc): SnapshotBlock[] {
    const handle = toDocHandle(doc);
    const blocks = deps.model.getBlocks(handle);
    const hashes = deps.model.getDocumentBlockIds(handle);
    const serialized = deps.model.serializeBlockLines(handle, deps.codec);
    const canonical = snapshotBlocks(handle, deps.model, deps.codec);
    return blocks.map((blockRef, index) => {
      const block = unwrapBlock(blockRef);
      const id = getBlockItemId(block);
      return {
        hash: hashes[index] as string,
        serialized: serialized[index] as string,
        renderedContent: canonical[index]?.renderedContent ?? serialized[index] ?? "",
        clientID: id.clientID,
        clock: id.clock,
        block,
      };
    });
  }
}

function changedBeforeBlocks(
  before: readonly SnapshotBlock[],
  after: readonly SnapshotBlock[],
): SnapshotBlock[] {
  const afterByIdentity = new Map(after.map((block) => [identityKey(block), block]));
  return before.filter(
    (block) => afterByIdentity.get(identityKey(block))?.serialized !== block.serialized,
  );
}

function insertedBlocks(
  before: readonly SnapshotBlock[],
  after: readonly SnapshotBlock[],
): SnapshotBlock[] {
  const beforeIds = new Set(before.map(identityKey));
  return after.filter((block) => !beforeIds.has(identityKey(block)));
}

function identityKey(block: Pick<SnapshotBlock, "clientID" | "clock">): string {
  return `${block.clientID}:${block.clock}`;
}

function findIdentity(
  blocks: readonly SnapshotBlock[],
  target: Pick<SnapshotBlock, "clientID" | "clock">,
): SnapshotBlock | undefined {
  const key = identityKey(target);
  return blocks.find((block) => identityKey(block) === key);
}

async function lookupObservation(
  store: ObservationSnapshotStore,
  responseId: string,
  documentId: string,
  block: SnapshotBlock,
) {
  const snapshot = await store.load(responseId);
  return (
    snapshot?.entries.find(
      (entry) =>
        entry.documentId === documentId &&
        entry.clientID === block.clientID &&
        entry.clock === block.clock,
    )?.value ?? null
  );
}

function navigation(input: {
  writerBlock: SnapshotBlock;
  mergedBlock?: SnapshotBlock;
  preSyncBlocks: readonly SnapshotBlock[];
  converged: Y.Doc;
  convergedBlocks: readonly SnapshotBlock[];
}): NavigationTargetV1 {
  const index = input.preSyncBlocks.findIndex(
    (block) => identityKey(block) === identityKey(input.writerBlock),
  );
  const liveIds = new Set(input.convergedBlocks.map(identityKey));
  const next = input.preSyncBlocks
    .slice(index + 1)
    .find((block) => liveIds.has(identityKey(block)));
  const previous = [...input.preSyncBlocks.slice(0, Math.max(0, index))]
    .reverse()
    .find((block) => liveIds.has(identityKey(block)));
  return deletionBoundaryTarget({
    doc: input.converged,
    next: next ? findIdentity(input.convergedBlocks, next)?.block : input.mergedBlock?.block,
    previous: previous ? findIdentity(input.convergedBlocks, previous)?.block : null,
  });
}
