/** Durable push-settlement state machine shared by warm pushes and cold recovery. */
import {
  type AgentEditCodec,
  type DocumentCoordinator,
  snapshotBlocks,
  toDocHandle,
  type YProsemirrorDocumentModel,
} from "@meridian/agent-edit";
import { createCollabYDoc } from "@meridian/prosemirror-schema";
import * as Y from "yjs";
import type {
  BranchPushStore,
  PendingLiveSettlement,
  PreparedPushCommit,
  PushSweptTrail,
} from "./branch-push-executor.js";
import { canonicalBlockKey } from "./trail-read-kernel.js";

const MAX_SETTLEMENT_ATTEMPTS = 3;

export class PendingLiveSettlementError extends Error {
  constructor(readonly pushId: number) {
    super(`Push ${pushId} remains in pending_live_settlement after bounded retries`);
    this.name = "PendingLiveSettlementError";
  }
}

export function createPushSettlementMachine(input: {
  pushStore: BranchPushStore;
  liveCoordinator: DocumentCoordinator;
  model: YProsemirrorDocumentModel;
  codec: AgentEditCodec;
}) {
  type Blocks = ReturnType<typeof snapshotBlocks>;

  function prepare(
    durable: Omit<PendingLiveSettlement, "push" | "writerUpdates" | "attemptCount" | "state">,
  ): Omit<PendingLiveSettlement, "push"> {
    return {
      ...durable,
      writerUpdates: [],
      attemptCount: 0,
      state: "pending_live_settlement",
    };
  }

  const commit = (prepared: PreparedPushCommit) => input.pushStore.commitPush(prepared);
  const commitBatch = (prepared: { pushes: PreparedPushCommit[] }) => {
    if (!input.pushStore.commitPushBatch)
      throw new Error("Branch push store does not support atomic companion pushes");
    return input.pushStore.commitPushBatch(prepared);
  };

  function classify(
    pending: PendingLiveSettlement,
    lockSnapshot: Blocks,
    prePushDoc: Y.Doc,
  ): {
    trail: PendingLiveSettlement["trail"];
    swept: PushSweptTrail;
    stateVector: Uint8Array;
  } | null {
    const before = snapshotBlocks(toDocHandle(prePushDoc), input.model, input.codec);
    const afterDoc = createCollabYDoc({ gc: false });
    try {
      Y.applyUpdate(afterDoc, Y.encodeStateAsUpdate(prePushDoc));
      Y.applyUpdate(afterDoc, pending.pushUpdate);
      const after = snapshotBlocks(toDocHandle(afterDoc), input.model, input.codec);
      const key = (block: (typeof before)[number]) =>
        block.clientID === undefined || block.clock === undefined
          ? null
          : canonicalBlockKey({
              documentId: pending.push.documentId,
              clientID: block.clientID,
              clock: block.clock,
            });
      const byIdentity = (blocks: typeof before) =>
        new Map(blocks.flatMap((block) => (key(block) ? [[key(block) as string, block]] : [])));
      const locked = byIdentity(lockSnapshot);
      const current = byIdentity(before);
      const pushed = byIdentity(after);
      const affected = pending.deletedParentIdentities.flatMap((identity) => {
        const identityKey = canonicalBlockKey(identity);
        const atLock = locked.get(identityKey);
        const atCut = current.get(identityKey);
        const afterPush = pushed.get(identityKey);
        if (
          !atLock ||
          !atCut ||
          atLock.renderedContent === atCut.renderedContent ||
          afterPush?.renderedContent === atCut.renderedContent
        )
          return [];
        return [{ identity, block: atCut }];
      });
      if (affected.length === 0) return null;
      const affectedByIdentity = new Map(
        affected.map(({ identity, block }) => [canonicalBlockKey(identity), block]),
      );
      const lateChanges = pending.trail.changes.flatMap((change) => {
        if (!change.beforeBlockIdentity) return [];
        const block = affectedByIdentity.get(canonicalBlockKey(change.beforeBlockIdentity));
        if (!block) return [];
        const markdown = block.renderedContent?.slice(block.renderedContent.indexOf("|") + 1) ?? "";
        return [
          {
            ...change,
            beforeText: block.serialized,
            swept: {
              affectedBlockHash: block.hash,
              affectedBlockIdentity: change.beforeBlockIdentity,
              removed: { status: "available" as const, markdown },
              beforeContentRef: pending.beforeContentRef,
            },
            writerProtection: {
              kind: "sweep" as const,
              body: { status: "available" as const, markdown },
            },
          },
        ];
      });
      if (lateChanges.length === 0) return null;
      const swept: PushSweptTrail = {
        affectedBlockHashes: affected.map(({ block }) => block.hash).sort(),
        capturedDeletedBodies: lateChanges.map((change) => ({
          hash: change.swept.affectedBlockHash,
          body: change.swept.removed.markdown,
        })),
        beforeContentRef: pending.beforeContentRef,
        receiptId: pending.trail.receiptId,
        locations: lateChanges.map((change) => ({
          changeId: change.changeId,
          affectedBlockHash: change.swept.affectedBlockHash,
          outcome: change.kind === "modify" ? "modify" : "delete",
          navigation: change.navigation,
        })),
        reversible: false,
      };
      return {
        trail: {
          ...pending.trail,
          changes: lateChanges,
          transactionalNotice: {
            kind: "push_swept",
            scope: { kind: "document", documentId: pending.push.documentId },
            writerVisible: true,
            message:
              "AI applied changes that removed words not yet synced to the agent — View change",
            data: {
              documentId: pending.push.documentId,
              documentName: pending.documentTitle,
              pushId: String(pending.push.id),
              ...swept,
            },
          },
        },
        swept,
        stateVector: Y.encodeStateVector(prePushDoc),
      };
    } finally {
      afterDoc.destroy();
    }
  }

  async function settle(inputSettlement: {
    pending: PendingLiveSettlement;
    lockSnapshot: Blocks;
    liveDoc: Y.Doc;
    signal?: AbortSignal;
  }): Promise<PushSweptTrail | undefined> {
    let latest: PushSweptTrail | undefined;
    for (let attempt = 0; attempt < MAX_SETTLEMENT_ATTEMPTS; attempt += 1) {
      inputSettlement.signal?.throwIfAborted();
      const cut = classify(
        inputSettlement.pending,
        inputSettlement.lockSnapshot,
        inputSettlement.liveDoc,
      );
      if (!cut) {
        Y.applyUpdate(inputSettlement.liveDoc, inputSettlement.pending.pushUpdate);
        await input.pushStore.completeLiveSettlement?.(inputSettlement.pending.push.id);
        return latest;
      }
      if (!input.pushStore.settlePushTrail)
        throw new Error("branch push store must durably settle late writer cuts");
      await input.pushStore.settlePushTrail({
        push: inputSettlement.pending.push,
        trail: cut.trail,
      });
      inputSettlement.signal?.throwIfAborted();
      latest = cut.swept;
      // No await separates this recheck from apply: a later edit becomes another durable cut.
      if (Buffer.from(Y.encodeStateVector(inputSettlement.liveDoc)).equals(cut.stateVector)) {
        Y.applyUpdate(inputSettlement.liveDoc, inputSettlement.pending.pushUpdate);
        await input.pushStore.completeLiveSettlement?.(inputSettlement.pending.push.id);
        return latest;
      }
    }
    const attemptCount = inputSettlement.pending.attemptCount + MAX_SETTLEMENT_ATTEMPTS;
    await input.pushStore.recordLiveSettlementFailure?.({
      pushId: inputSettlement.pending.push.id,
      attemptCount,
      error: "live document changed during settlement",
      parked: true,
      nextAttemptAt: new Date(Date.now() + Math.min(60_000, 1_000 * 2 ** attemptCount)),
    });
    throw new PendingLiveSettlementError(inputSettlement.pending.push.id);
  }

  async function recover(recoveryInput?: { signal?: AbortSignal }): Promise<number> {
    if (!input.pushStore.listPendingLiveSettlements) return 0;
    const pending = await input.pushStore.listPendingLiveSettlements();
    let recovered = 0;
    for (const row of pending) {
      recoveryInput?.signal?.throwIfAborted();
      try {
        await input.liveCoordinator.withDocument(
          row.push.documentId,
          async (liveDoc) => {
            const prePushDoc = createCollabYDoc({ gc: false });
            try {
              Y.applyUpdate(prePushDoc, row.baselineState);
              const lockSnapshot = snapshotBlocks(
                toDocHandle(prePushDoc),
                input.model,
                input.codec,
              );
              for (const update of row.writerUpdates) Y.applyUpdate(prePushDoc, update);
              await settle({
                pending: row,
                lockSnapshot,
                liveDoc: prePushDoc,
                signal: recoveryInput?.signal,
              });
              // The recovered state machine applies to its reconstructed pre-push cut. The
              // coordinator may already contain the journaled push; replay is idempotent.
              Y.applyUpdate(liveDoc, row.pushUpdate);
            } finally {
              prePushDoc.destroy();
            }
          },
          { timeoutMs: 30_000, ...(recoveryInput?.signal ? { signal: recoveryInput.signal } : {}) },
        );
        recovered += 1;
      } catch (cause) {
        if (cause instanceof PendingLiveSettlementError) continue;
        const attemptCount = row.attemptCount + 1;
        await input.pushStore.recordLiveSettlementFailure?.({
          pushId: row.push.id,
          attemptCount,
          error: cause instanceof Error ? cause.message : String(cause),
          parked: attemptCount >= MAX_SETTLEMENT_ATTEMPTS,
          nextAttemptAt: new Date(Date.now() + 1_000 * 2 ** Math.min(6, attemptCount)),
        });
      }
    }
    return recovered;
  }

  return { prepare, commit, commitBatch, settle, recover };
}
