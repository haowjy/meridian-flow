/** Sole ordering owner for durable branch-push settlement and recovery. */
import { createHash, randomUUID } from "node:crypto";
import type {
  AgentEditCodec,
  DocumentCoordinator,
  YProsemirrorDocumentModel,
} from "@meridian/agent-edit/integration";
import { createCollabYDoc } from "@meridian/prosemirror-schema";
import * as Y from "yjs";
import type {
  CompletionFenceResult,
  PendingLiveSettlement,
  PreparedPushCommit,
  PushCommitStore,
  SweepProjectionDiagnostics,
} from "./branch-push-contracts.js";
import { trailContributionReplacement } from "./branch-trail-projection.js";
import { projectCommittedChangeEvent } from "./change-event-projection.js";
import type { ChangeEventDelivery } from "./ports/change-event-delivery.js";
import type { CommittedChangeTrailProjection } from "./ports/change-trail-persistence.js";
import { isCorruptDurableProjectionError } from "./ports/durable-projection.js";
import type { PendingSettlementStore } from "./ports/pending-settlement-store.js";
import type { WriterIngressBarrier } from "./ports/writer-ingress-barrier.js";
import { detectSweptChanges, type SweptChangeRecipients } from "./sweep-policy.js";

const MAX_SETTLEMENT_ATTEMPTS = 3;

export class PendingLiveSettlementError extends Error {
  constructor(readonly pushId: number) {
    super(`Push ${pushId} remains in pending_live_settlement after bounded retries`);
    this.name = "PendingLiveSettlementError";
  }
}

export function createBranchPushTransition(input: {
  commitStore: PushCommitStore;
  settlementStore: PendingSettlementStore;
  liveCoordinator: DocumentCoordinator;
  model: YProsemirrorDocumentModel;
  codec: AgentEditCodec;
  changeEventDelivery: ChangeEventDelivery;
  writerIngressBarrier?: WriterIngressBarrier;
  sweepProjectionDiagnostics?: SweepProjectionDiagnostics;
}) {
  type PreparedTransition<T> =
    | { kind: "return"; value: T }
    | {
        kind: "push";
        pushes: PreparedPushCommit[];
        afterDurableCommit?: (documentIds: readonly string[]) => Promise<void>;
        onConflict: (push: PendingLiveSettlement["push"]) => T;
        finish: (input: {
          pushes: readonly PendingLiveSettlement["push"][];
          docs: ReadonlyMap<PendingLiveSettlement["push"]["documentId"], Y.Doc>;
        }) => T | Promise<T>;
      };

  async function execute<T>(inputExecution: {
    documentIds: readonly PendingLiveSettlement["push"]["documentId"][];
    signal?: AbortSignal;
    prepare: (input: {
      docs: ReadonlyMap<PendingLiveSettlement["push"]["documentId"], Y.Doc>;
      lockCuts: ReadonlyMap<PendingLiveSettlement["push"]["documentId"], Uint8Array>;
    }) => Promise<PreparedTransition<T>>;
  }): Promise<T> {
    return withDocumentLocks(
      inputExecution.documentIds,
      inputExecution.signal,
      async (docs, lockCuts) => {
        const prepared = await inputExecution.prepare({ docs, lockCuts });
        if (prepared.kind === "return") return prepared.value;
        if (prepared.pushes.length === 0) throw new Error("Branch push transition requires a push");
        const committed =
          prepared.pushes.length === 1
            ? await commit(prepared.pushes[0] as PreparedPushCommit)
            : await commitBatch({ pushes: prepared.pushes });
        if ("status" in committed && committed.status === "conflict") {
          return prepared.onConflict(committed.push);
        }
        const pushes = "status" in committed ? [committed.push] : committed.pushes;
        await prepared.afterDurableCommit?.(prepared.pushes.map((push) => push.branch.documentId));
        for (const push of pushes) {
          const durable = await input.settlementStore.loadLiveSettlement(push.id);
          const liveDoc = docs.get(push.documentId);
          if (!liveDoc) throw new Error("Branch push transition lost its live document lock");
          await settle({ pending: durable, liveDoc, signal: inputExecution.signal });
        }
        return prepared.finish({ pushes, docs });
      },
    );
  }

  async function withDocumentLocks<T>(
    documentIds: readonly PendingLiveSettlement["push"]["documentId"][],
    signal: AbortSignal | undefined,
    run: (
      docs: ReadonlyMap<PendingLiveSettlement["push"]["documentId"], Y.Doc>,
      lockCuts: ReadonlyMap<PendingLiveSettlement["push"]["documentId"], Uint8Array>,
    ) => Promise<T>,
  ): Promise<T> {
    const sorted = [...new Set(documentIds)].sort();
    const acquire = async (
      index: number,
      docs: Map<PendingLiveSettlement["push"]["documentId"], Y.Doc>,
      lockCuts: Map<PendingLiveSettlement["push"]["documentId"], Uint8Array>,
    ): Promise<T> => {
      const documentId = sorted[index];
      if (!documentId) return run(docs, lockCuts);
      return input.liveCoordinator.withDocument(
        documentId,
        async (doc) => {
          const lockCutUpdate = Y.encodeStateAsUpdate(doc);
          docs.set(documentId, doc);
          lockCuts.set(documentId, lockCutUpdate);
          try {
            return await acquire(index + 1, docs, lockCuts);
          } finally {
            docs.delete(documentId);
            lockCuts.delete(documentId);
          }
        },
        { timeoutMs: 30_000, ...(signal ? { signal } : {}) },
      );
    };
    return acquire(0, new Map(), new Map());
  }

  function prepare(
    durable: Omit<
      PendingLiveSettlement,
      | "push"
      | "postCutUpdates"
      | "attemptCount"
      | "state"
      | "joinVersion"
      | "settledJoinVersion"
      | "claim"
    >,
  ): Omit<PendingLiveSettlement, "push"> {
    return {
      ...durable,
      postCutUpdates: [],
      joinVersion: 0,
      settledJoinVersion: null,
      claim: {
        token: randomUUID(),
        epoch: 1,
        kind: "warm",
        // Persistence replaces this sentinel with its database-clock lease.
        leaseExpiresAt: new Date(0),
      },
      attemptCount: 0,
      state: "pending",
    };
  }

  const commit = (prepared: PreparedPushCommit) => input.commitStore.commitPush(prepared);
  const commitBatch = (prepared: { pushes: PreparedPushCommit[] }) =>
    input.commitStore.commitPushBatch(prepared);

  function detectSweptChangesBestEffort(
    pending: PendingLiveSettlement,
    prePushDoc: Y.Doc,
  ): SweptChangeRecipients {
    try {
      return detectSweptChanges({
        pending,
        prePushDoc,
        model: input.model,
        codec: input.codec,
      });
    } catch (cause) {
      input.sweepProjectionDiagnostics?.unavailable({
        pushId: pending.push.id,
        documentId: pending.push.documentId,
        cause,
      });
      return new Map();
    }
  }

  async function settle(inputSettlement: {
    pending: PendingLiveSettlement;
    liveDoc: Y.Doc;
    signal?: AbortSignal;
  }): Promise<void> {
    let pending = inputSettlement.pending;
    let committedProjections: readonly CommittedChangeTrailProjection[] = [];
    for (let attempt = 0; attempt < MAX_SETTLEMENT_ATTEMPTS; attempt += 1) {
      inputSettlement.signal?.throwIfAborted();
      const renewed = await input.settlementStore.renewClaim({
        pushId: pending.push.id,
        claim: pending.claim,
      });
      if (!renewed) throw new PendingLiveSettlementError(pending.push.id);
      pending = { ...pending, claim: renewed };
      const ingressGeneration = await input.writerIngressBarrier?.drain(pending.push.documentId);
      pending = await input.settlementStore.loadLiveSettlement(pending.push.id);
      const finalPrePush = materializeFinalPrePush(pending);
      try {
        const sweep = detectSweptChangesBestEffort(pending, finalPrePush);
        const settled = await input.settlementStore.settlePushTrail({
          push: pending.push,
          trail: pending.trail,
          replacement: trailContributionReplacement(pending.trail, pending.push),
          claim: pending.claim,
          joinVersion: pending.joinVersion,
        });
        if (settled === false) throw new PendingLiveSettlementError(pending.push.id);
        committedProjections = settled;

        let completion: CompletionFenceResult;
        try {
          completion = await completeUnderFence({
            pending,
            liveDoc: inputSettlement.liveDoc,
            finalPrePush,
            ingressGeneration,
          });
        } catch (cause) {
          if (isCorruptDurableProjectionError(cause)) {
            await input.settlementStore.block({
              pushId: pending.push.id,
              claim: pending.claim,
              code: cause.code,
              error: cause.message,
            });
          }
          throw cause;
        }
        if (completion === "applied" || completion === "already_applied") {
          for (const projection of committedProjections) {
            if (projection.documentId !== pending.push.documentId) continue;
            try {
              input.changeEventDelivery.deliver(
                projectCommittedChangeEvent(projection, sweep, input.codec),
              );
            } catch {
              // Delivery is an ephemeral session hint; durable push completion
              // and the trail must never be reported as failed because it missed.
            }
          }
          return;
        }
      } finally {
        finalPrePush.destroy();
      }
    }
    await input.settlementStore.recordFailure({
      pushId: pending.push.id,
      claim: pending.claim,
      error: "live document changed during settlement",
    });
    throw new PendingLiveSettlementError(pending.push.id);
  }

  async function completeUnderFence(inputFence: {
    pending: PendingLiveSettlement;
    liveDoc: Y.Doc;
    finalPrePush: Y.Doc;
    ingressGeneration?: number;
  }): Promise<CompletionFenceResult> {
    const complete = (): CompletionFenceResult => {
      if (
        inputFence.ingressGeneration !== undefined &&
        !input.writerIngressBarrier?.isGenerationCurrent(
          inputFence.pending.push.documentId,
          inputFence.ingressGeneration,
        )
      ) {
        return "retry";
      }
      const durableFingerprint = fullStateFingerprint(inputFence.finalPrePush);
      const liveFingerprint = fullStateFingerprint(inputFence.liveDoc);
      if (liveFingerprint === durableFingerprint) {
        Y.applyUpdate(inputFence.liveDoc, inputFence.pending.pushUpdate);
        return "applied";
      }
      const pushed = createCollabYDoc({ gc: false });
      try {
        Y.applyUpdate(pushed, Y.encodeStateAsUpdate(inputFence.finalPrePush));
        Y.applyUpdate(pushed, inputFence.pending.pushUpdate);
        return liveFingerprint === fullStateFingerprint(pushed) ? "already_applied" : "retry";
      } finally {
        pushed.destroy();
      }
    };
    return input.settlementStore.withCompletionFence(
      {
        pushId: inputFence.pending.push.id,
        documentId: inputFence.pending.push.documentId,
        claim: inputFence.pending.claim,
        settledJoinVersion: inputFence.pending.joinVersion,
      },
      complete,
    );
  }

  async function recover(recoveryInput?: { signal?: AbortSignal }): Promise<number> {
    const recoverableIds = await input.settlementStore.listRecoverableSettlementIds();
    let recovered = 0;
    for (const pushId of recoverableIds) {
      recoveryInput?.signal?.throwIfAborted();
      let row: PendingLiveSettlement | null = null;
      try {
        row = await input.settlementStore.claimRecoverable({ pushId, token: randomUUID() });
        if (!row) continue;
        await input.liveCoordinator.withDocument(
          row.push.documentId,
          async (liveDoc) => {
            await settle({
              pending: row as PendingLiveSettlement,
              liveDoc,
              signal: recoveryInput?.signal,
            });
          },
          { timeoutMs: 30_000, ...(recoveryInput?.signal ? { signal: recoveryInput.signal } : {}) },
        );
        recovered += 1;
      } catch (cause) {
        if (!row || cause instanceof PendingLiveSettlementError) continue;
        await input.settlementStore.recordFailure({
          pushId: row.push.id,
          claim: row.claim,
          error: cause instanceof Error ? cause.message : String(cause),
        });
      }
    }
    return recovered;
  }

  return { execute, prepare, recover };
}

/** The only reconstruction path for final pre-push content, warm or cold. */
export function materializeFinalPrePush(row: PendingLiveSettlement): Y.Doc {
  const doc = createCollabYDoc({ gc: false });
  Y.applyUpdate(doc, row.lockCutUpdate);
  for (const update of row.postCutUpdates) Y.applyUpdate(doc, update);
  return doc;
}

export function fullStateFingerprint(doc: Y.Doc): string {
  return createHash("sha256").update(Y.encodeStateAsUpdate(doc)).digest("base64");
}
