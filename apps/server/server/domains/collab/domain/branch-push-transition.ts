/** Sole ordering owner for durable branch-push batch settlement and recovery. */
import { createHash, randomUUID } from "node:crypto";
import type {
  AgentEditCodecFactory,
  DocumentCoordinator,
  YProsemirrorDocumentModel,
} from "@meridian/agent-edit/integration";
import type { DocumentId } from "@meridian/contracts/runtime";
import { UNSCOPED_DOCUMENT_LINKS } from "@meridian/markup";
import { createCollabYDoc } from "@meridian/prosemirror-schema";
import * as Y from "yjs";
import {
  FIRST_CLAIM_EPOCH,
  type PendingLiveSettlement,
  type PendingSettlementBatch,
  type PreparedPushCommit,
  type PushCommitStore,
  type PushLineageRow,
  type SettlementClaim,
  type SweepProjectionDiagnostics,
} from "./branch-push-contracts.js";
import { trailContributionReplacement } from "./branch-trail-projection.js";
import { projectCommittedChangeEvent } from "./change-event-projection.js";
import type { ChangeEventDelivery } from "./ports/change-event-delivery.js";
import type { DocumentLinkScopes } from "./ports/document-link-scope.js";
import { isCorruptDurableProjectionError } from "./ports/durable-projection.js";
import type { PendingSettlementStore, SettlementCut } from "./ports/pending-settlement-store.js";
import type { WriterIngressBarrier } from "./ports/writer-ingress-barrier.js";
import { detectSweptChanges, type SweptChangesByRecipient } from "./sweep-policy.js";

const MAX_SETTLEMENT_ATTEMPTS = 3;

export class PendingLiveSettlementError extends Error {
  constructor(readonly batchId: string) {
    super(`Settlement batch ${batchId} remains pending after bounded retries`);
    this.name = "PendingLiveSettlementError";
  }
}

type LiveDocs = ReadonlyMap<DocumentId, Y.Doc>;

export function createBranchPushTransition(input: {
  commitStore: PushCommitStore;
  settlementStore: PendingSettlementStore;
  liveCoordinator: DocumentCoordinator;
  model: YProsemirrorDocumentModel;
  codec: AgentEditCodecFactory;
  /** Settlement runs in its documents' scope, so nested document doors join it. */
  links: DocumentLinkScopes;
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
        onConflict: (push: PushLineageRow) => T;
        finish: (input: { pushes: readonly PushLineageRow[]; docs: LiveDocs }) => T | Promise<T>;
      };

  async function execute<T>(inputExecution: {
    documentIds: readonly DocumentId[];
    signal?: AbortSignal;
    prepare: (input: {
      docs: LiveDocs;
      lockCuts: ReadonlyMap<DocumentId, Uint8Array>;
    }) => Promise<PreparedTransition<T>>;
  }): Promise<T> {
    return withDocumentLocks(
      inputExecution.documentIds,
      inputExecution.signal,
      async (docs, lockCuts) => {
        const prepared = await inputExecution.prepare({ docs, lockCuts });
        if (prepared.kind === "return") return prepared.value;
        if (prepared.pushes.length === 0) throw new Error("Branch push transition requires a push");
        const settlement = { batchId: randomUUID(), claimToken: randomUUID() };
        const committed = await input.commitStore.commitPushBatch({
          settlement,
          pushes: prepared.pushes,
        });
        if (committed.status === "conflict") return prepared.onConflict(committed.push);
        await prepared.afterDurableCommit?.(prepared.pushes.map((push) => push.branch.documentId));
        // The committer holds the batch's first claim; it never adopts a later one.
        const batch = await input.settlementStore.loadSettlementBatch({
          batchId: settlement.batchId,
          owner: { token: settlement.claimToken, epoch: FIRST_CLAIM_EPOCH },
        });
        if (!batch) throw new PendingLiveSettlementError(settlement.batchId);
        await settle({ batch, docs, signal: inputExecution.signal });
        return prepared.finish({ pushes: committed.pushes, docs });
      },
    );
  }

  /** Coordinator locks in document-id order, each capturing its LOCK-WS cut first. */
  async function withDocumentLocks<T>(
    documentIds: readonly DocumentId[],
    signal: AbortSignal | undefined,
    run: (docs: LiveDocs, lockCuts: ReadonlyMap<DocumentId, Uint8Array>) => Promise<T>,
  ): Promise<T> {
    const sorted = [...new Set(documentIds)].sort();
    const acquire = async (
      index: number,
      docs: Map<DocumentId, Y.Doc>,
      lockCuts: Map<DocumentId, Uint8Array>,
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

  function detectSweptChangesBestEffort(
    pending: PendingLiveSettlement,
    prePushDoc: Y.Doc,
  ): SweptChangesByRecipient {
    try {
      return detectSweptChanges({
        pending,
        prePushDoc,
        model: input.model,
        // Sweep detection compares the document with itself: stored bytes are its identity.
        codec: input.codec.forScope(UNSCOPED_DOCUMENT_LINKS),
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

  type Settlement = { batch: PendingSettlementBatch; docs: LiveDocs; signal?: AbortSignal };

  function settle(settlement: Settlement): Promise<void> {
    const documentIds = settlement.batch.members.map((member) => member.push.documentId);
    const [documentId] = documentIds;
    // A batch with no text members (tree-only, or whose documents were hard-deleted)
    // still settles through the same transaction, with nothing to admit.
    if (!documentId) return settleBatch(settlement);
    return input.links.within({ documentId, documentIds }, () => settleBatch(settlement));
  }

  async function settleBatch(settlement: Settlement): Promise<void> {
    const { batchId } = settlement.batch;
    let claim: SettlementClaim = settlement.batch.claim;
    for (let attempt = 0; attempt < MAX_SETTLEMENT_ATTEMPTS; attempt += 1) {
      settlement.signal?.throwIfAborted();
      const renewed = await input.settlementStore.renewClaim({ batchId, claim });
      if (!renewed) throw new PendingLiveSettlementError(batchId);
      claim = renewed;
      const ingress = new Map<DocumentId, number>();
      for (const member of settlement.batch.members) {
        const generation = await input.writerIngressBarrier?.drain(member.push.documentId);
        if (generation !== undefined) ingress.set(member.push.documentId, generation);
      }
      const owned = await input.settlementStore.loadSettlementBatch({ batchId, owner: claim });
      if (!owned) throw new PendingLiveSettlementError(batchId);
      const { members } = owned;
      const sweeps = new Map<DocumentId, SweptChangesByRecipient>();
      for (const member of members) {
        const prePush = materializeFinalPrePush(member);
        try {
          sweeps.set(member.push.documentId, detectSweptChangesBestEffort(member, prePush));
        } finally {
          prePush.destroy();
        }
      }
      let completion: Awaited<ReturnType<PendingSettlementStore["completeBatch"]>>;
      try {
        completion = await input.settlementStore.completeBatch({
          batchId,
          claim,
          members: members.map((member) => ({
            push: member.push,
            joinVersion: member.joinVersion,
            trail: member.trail,
            replacement: trailContributionReplacement(member.trail, member.push),
          })),
          recheck: (cuts) => recheckWarmState(cuts, settlement.docs, ingress),
          afterCommit: () => applyToWarmRooms(members, settlement.docs),
        });
      } catch (cause) {
        if (isCorruptDurableProjectionError(cause)) {
          await input.settlementStore.block({
            batchId,
            claim,
            code: cause.code,
            error: cause.message,
          });
        }
        throw cause;
      }
      if (completion.status === "completed") {
        for (const projection of completion.projections) {
          const sweep = sweeps.get(projection.documentId as DocumentId);
          if (!sweep) continue;
          try {
            input.changeEventDelivery.deliver(
              projectCommittedChangeEvent(projection, input.codec),
              sweep,
            );
          } catch {
            // Delivery is an ephemeral session hint; durable push completion
            // and the trail must never be reported as failed because it missed.
          }
        }
        return;
      }
    }
    await input.settlementStore.recordFailure({
      batchId,
      claim,
      error: "live document changed during settlement",
    });
    throw new PendingLiveSettlementError(batchId);
  }

  /**
   * The LOCK-WS fence for a whole batch, inside the completion transaction: every
   * warm document must equal its durable pre-push cut, or already hold the push,
   * and no writer admission may have started since its drain. Nothing is applied
   * here; the transaction has not committed.
   */
  function recheckWarmState(
    cuts: readonly SettlementCut[],
    docs: LiveDocs,
    ingress: ReadonlyMap<DocumentId, number>,
  ): "commit" | "retry" {
    for (const cut of cuts) {
      const generation = ingress.get(cut.documentId);
      if (
        generation !== undefined &&
        !input.writerIngressBarrier?.isGenerationCurrent(cut.documentId, generation)
      ) {
        return "retry";
      }
      const liveDoc = docs.get(cut.documentId);
      if (!liveDoc) throw new Error("Batch settlement lost a live document lock");
      const prePush = materializeFinalPrePush(cut);
      try {
        const liveFingerprint = fullStateFingerprint(liveDoc);
        if (liveFingerprint === fullStateFingerprint(prePush)) continue;
        Y.applyUpdate(prePush, cut.pushUpdate);
        if (liveFingerprint !== fullStateFingerprint(prePush)) return "retry";
      } finally {
        prePush.destroy();
      }
    }
    return "commit";
  }

  /**
   * After commit. Writer admissions that start after the recheck wait on the
   * document mutation locks until commit, so they journal after the push; Yjs
   * merges both in any order to the durable state.
   */
  function applyToWarmRooms(members: readonly PendingLiveSettlement[], docs: LiveDocs): void {
    for (const member of members) {
      const liveDoc = docs.get(member.push.documentId);
      if (liveDoc) Y.applyUpdate(liveDoc, member.pushUpdate);
    }
  }

  async function recover(recoveryInput?: { signal?: AbortSignal }): Promise<number> {
    const recoverableIds = await input.settlementStore.listRecoverableBatchIds();
    let recovered = 0;
    for (const batchId of recoverableIds) {
      recoveryInput?.signal?.throwIfAborted();
      let batch: PendingSettlementBatch | null = null;
      try {
        batch = await input.settlementStore.claimRecoverableBatch({ batchId, token: randomUUID() });
        if (!batch) continue;
        const claimed = batch;
        await withDocumentLocks(
          claimed.members.map((member) => member.push.documentId),
          recoveryInput?.signal,
          (docs) => settle({ batch: claimed, docs, signal: recoveryInput?.signal }),
        );
        recovered += 1;
      } catch (cause) {
        if (!batch || cause instanceof PendingLiveSettlementError) continue;
        await input.settlementStore.recordFailure({
          batchId: batch.batchId,
          claim: batch.claim,
          error: cause instanceof Error ? cause.message : String(cause),
        });
      }
    }
    return recovered;
  }

  return { execute, recover };
}

/** The only reconstruction path for final pre-push content, warm or cold. */
export function materializeFinalPrePush(
  row: Pick<PendingLiveSettlement, "lockCutUpdate" | "postCutUpdates">,
): Y.Doc {
  const doc = createCollabYDoc({ gc: false });
  Y.applyUpdate(doc, row.lockCutUpdate);
  for (const update of row.postCutUpdates) Y.applyUpdate(doc, update);
  return doc;
}

export function fullStateFingerprint(doc: Y.Doc): string {
  return createHash("sha256").update(Y.encodeStateAsUpdate(doc)).digest("base64");
}
