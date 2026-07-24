/** Sole ordering owner for durable branch-push settlement and recovery. */
import { createHash, randomUUID } from "node:crypto";
import {
  type AgentEditCodec,
  classifyDestructiveEffect,
  type DocumentCoordinator,
  digestRenderedContent,
  intersectLineageRanges,
  type LineageRange,
  normalizeLineageRanges,
  observationCoversRendering,
  snapshotBlocks,
  toDocHandle,
  type VisibleProseOccurrence,
  type YProsemirrorDocumentModel,
} from "@meridian/agent-edit";
import type { ChangeEventProjection, ChangeEventWsMessage } from "@meridian/contracts/protocol";
import { createCollabYDoc } from "@meridian/prosemirror-schema";
import * as Y from "yjs";
import type {
  BranchPushStore,
  CompletionFenceResult,
  PendingLiveSettlement,
  PreparedPushCommit,
  PushSweptTrail,
} from "./branch-push-executor.js";
import type { ChangeEventDelivery } from "./ports/change-event-delivery.js";
import type { CommittedChangeTrailProjection } from "./ports/change-trail-persistence.js";
import type { WriterIngressBarrier } from "./ports/writer-ingress-barrier.js";
import { materializeCandidateProvenance, ProvenanceMaterializationError } from "./provenance.js";
import { bodyFromHashline, canonicalBlockKey } from "./trail-read-kernel.js";

const MAX_SETTLEMENT_ATTEMPTS = 3;

export class PendingLiveSettlementError extends Error {
  constructor(readonly pushId: number) {
    super(`Push ${pushId} remains in pending_live_settlement after bounded retries`);
    this.name = "PendingLiveSettlementError";
  }
}

export function createBranchPushTransition(input: {
  pushStore: BranchPushStore;
  liveCoordinator: DocumentCoordinator;
  model: YProsemirrorDocumentModel;
  codec: AgentEditCodec;
  writerIngressBarrier?: WriterIngressBarrier;
  changeEventDelivery?: ChangeEventDelivery;
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
          swept: readonly (PushSweptTrail | undefined)[];
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
        const settlements = "status" in committed ? [committed.settlement] : committed.settlements;
        await prepared.afterDurableCommit?.(prepared.pushes.map((push) => push.branch.documentId));
        const swept: Array<PushSweptTrail | undefined> = [];
        for (const [index, push] of pushes.entries()) {
          const fallback = {
            ...(prepared.pushes[index] as PreparedPushCommit).pendingLiveSettlement,
            push,
          };
          let durable: PendingLiveSettlement;
          try {
            durable = input.pushStore.loadLiveSettlement
              ? await input.pushStore.loadLiveSettlement(push.id)
              : (settlements?.[index] ?? fallback);
          } catch (cause) {
            if (cause instanceof ProvenanceMaterializationError) {
              await input.pushStore.blockLiveSettlement?.({
                pushId: push.id,
                claim: fallback.claim,
                code: "corrupt_settlement_authority",
                error: cause.message,
              });
            }
            throw cause;
          }
          const liveDoc = docs.get(push.documentId);
          if (!liveDoc) throw new Error("Branch push transition lost its live document lock");
          swept.push(await settle({ pending: durable, liveDoc, signal: inputExecution.signal }));
        }
        return prepared.finish({ pushes, swept, docs });
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

  const commit = (prepared: PreparedPushCommit) => input.pushStore.commitPush(prepared);
  const commitBatch = (prepared: { pushes: PreparedPushCommit[] }) => {
    if (!input.pushStore.commitPushBatch)
      throw new Error("Branch push store does not support atomic companion pushes");
    return input.pushStore.commitPushBatch(prepared);
  };

  function occurrencesFor(
    blocks: ReturnType<typeof snapshotBlocks>,
    provenance: PendingLiveSettlement["provenanceView"],
  ): VisibleProseOccurrence[] {
    return blocks.flatMap((block) =>
      block.renderedContent === undefined
        ? []
        : provenance.flatMap((run) =>
            intersectLineageRanges(block.lineage ?? [], [run.target]).map((target) => ({
              target,
              root: {
                clientID: run.root.clientID,
                clock: run.root.clock + target.clock - run.target.clock,
                length: target.length,
              },
              provenance: run.birthClass,
              finalRendering: renderingKey(block),
            })),
          ),
    );
  }

  function renderingKey(block: ReturnType<typeof snapshotBlocks>[number]): string {
    return `${block.clientID ?? "?"}:${block.clock ?? "?"}:${block.renderedContent ?? ""}`;
  }

  /** Response-scoped causal-cut algebra; every evidence item earns credit independently. */
  function classify(
    pending: PendingLiveSettlement,
    prePushDoc: Y.Doc,
  ): {
    trail: PendingLiveSettlement["trail"];
    swept?: PushSweptTrail;
    refineToEmpty?: boolean;
  } | null {
    const before = snapshotBlocks(toDocHandle(prePushDoc), input.model, input.codec);
    const afterDoc = createCollabYDoc({ gc: false });
    try {
      Y.applyUpdate(afterDoc, Y.encodeStateAsUpdate(prePushDoc));
      Y.applyUpdate(afterDoc, pending.pushUpdate);
      const after = snapshotBlocks(toDocHandle(afterDoc), input.model, input.codec);
      const preProvenance = pending.provenanceView;
      const beforeOccurrences = occurrencesFor(before, preProvenance);
      const afterProvenance = materializeCandidateProvenance(afterDoc, preProvenance);
      const afterOccurrences = occurrencesFor(after, afterProvenance);
      const evidenceById = new Map(pending.responseEvidence.map((item) => [item.evidenceId, item]));
      const eligibleByRendering = new Map<string, LineageRange[]>();

      // A selected row may legitimately predate response sealing. It contributes
      // Ri = empty: no protected roots and no causal/observation credit. The shared
      // classifier still derives Hi from writer roots outside that empty cut.
      const evidenceItems =
        pending.lineageEvidence.items.length > 0 ? pending.lineageEvidence.items : [null];
      for (const item of evidenceItems) {
        const response = item ? evidenceById.get(item.evidenceId) : undefined;
        if (item && !response) {
          throw new ProvenanceMaterializationError("Settlement response evidence is unavailable");
        }
        const coveredFinalRenderings = before.flatMap((block) => {
          if (
            block.clientID === undefined ||
            block.clock === undefined ||
            block.renderedContent === undefined
          )
            return [];
          const observation = response?.observations.find(
            (entry) =>
              entry.documentId === pending.push.documentId &&
              entry.clientID === block.clientID &&
              entry.clock === block.clock,
          );
          return observationCoversRendering({
            observation: observation?.value ?? null,
            renderedContent: block.renderedContent,
            digestRenderedContent,
          })
            ? [renderingKey(block)]
            : [];
        });
        const effect = classifyDestructiveEffect({
          before: beforeOccurrences,
          afterCandidate: afterOccurrences,
          protectionScope: item?.token.protectedRoots ?? [],
          responseCut: {
            ...(response?.responseCut ?? {
              id: "unsealed-selection",
              version: 1 as const,
              documentId: pending.push.documentId,
              authorityId: `unsealed:${pending.push.documentId}`,
              generation: 0n,
              admittedThrough: 0n,
            }),
            visible: (response?.visibleAtCut ?? []).map((run) => ({
              target: run.target,
              root: run.root,
              provenance: run.birthClass,
              finalRendering: "",
            })),
          },
          observation: { coveredFinalRenderings },
        });
        for (const projection of effect.finalRenderingProjections) {
          const ranges = eligibleByRendering.get(projection.finalRendering) ?? [];
          ranges.push(...projection.ranges);
          eligibleByRendering.set(projection.finalRendering, ranges);
        }
      }

      if (eligibleByRendering.size === 0) {
        return { trail: pending.trail, refineToEmpty: true };
      }
      const affected = before.filter((block) => {
        return block.renderedContent !== undefined && eligibleByRendering.has(renderingKey(block));
      });
      const affectedByIdentity = new Map(
        affected.flatMap((block) =>
          block.clientID === undefined || block.clock === undefined
            ? []
            : [
                [
                  canonicalBlockKey({
                    documentId: pending.push.documentId,
                    clientID: block.clientID,
                    clock: block.clock,
                  }),
                  block,
                ] as const,
              ],
        ),
      );
      const lateChanges = pending.trail.changes.flatMap((change) => {
        if (!change.beforeBlockIdentity) return [];
        const block = affectedByIdentity.get(canonicalBlockKey(change.beforeBlockIdentity));
        if (!block) return [];
        const rendering = block.renderedContent as string;
        const markdown = rendering.slice(rendering.indexOf("|") + 1);
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
              ranges: normalizeLineageRanges(eligibleByRendering.get(renderingKey(block)) ?? []),
            },
          },
        ];
      });
      if (lateChanges.length === 0) return null;
      const swept: PushSweptTrail = {
        affectedBlockHashes: affected.map((block) => block.hash).sort(),
        capturedDeletedBodies: lateChanges.map((change) => ({
          hash: change.swept.affectedBlockHash,
          body: change.swept.removed.status === "available" ? change.swept.removed.markdown : "",
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
        },
        swept,
      };
    } finally {
      afterDoc.destroy();
    }
  }

  async function settle(inputSettlement: {
    pending: PendingLiveSettlement;
    liveDoc: Y.Doc;
    signal?: AbortSignal;
  }): Promise<PushSweptTrail | undefined> {
    let pending = inputSettlement.pending;
    let latest: PushSweptTrail | undefined;
    let committedProjections: readonly CommittedChangeTrailProjection[] = [];
    for (let attempt = 0; attempt < MAX_SETTLEMENT_ATTEMPTS; attempt += 1) {
      inputSettlement.signal?.throwIfAborted();
      if (input.pushStore.renewSettlementClaim) {
        const renewed = await input.pushStore.renewSettlementClaim({
          pushId: pending.push.id,
          claim: pending.claim,
        });
        if (!renewed) throw new PendingLiveSettlementError(pending.push.id);
        pending = { ...pending, claim: renewed };
      }
      const ingressGeneration = await input.writerIngressBarrier?.drain(pending.push.documentId);
      pending = input.pushStore.loadLiveSettlement
        ? await input.pushStore.loadLiveSettlement(pending.push.id)
        : pending;
      const materialized = materializeFinalPrePush(pending);
      try {
        const cut = classify(pending, materialized.doc);
        const settled = input.pushStore.settlePushTrail
          ? await input.pushStore.settlePushTrail({
              push: pending.push,
              ...(cut ? { trail: cut.trail } : {}),
              ...(cut?.refineToEmpty ? { refineToEmpty: true } : {}),
              claim: pending.claim,
              joinVersion: pending.joinVersion,
            })
          : true;
        if (settled === false) throw new PendingLiveSettlementError(pending.push.id);
        if (Array.isArray(settled)) committedProjections = settled;
        if (cut?.swept) latest = cut.swept;

        const completion = await completeUnderFence({
          pending,
          liveDoc: inputSettlement.liveDoc,
          finalPrePush: materialized.doc,
          ingressGeneration,
        });
        if (completion === "applied" || completion === "already_applied") {
          for (const projection of committedProjections) {
            if (projection.documentId !== pending.push.documentId) continue;
            try {
              input.changeEventDelivery?.deliver(changeEventMessage(projection, pending));
            } catch {
              // Delivery is an ephemeral session hint; durable push completion
              // and the trail must never be reported as failed because it missed.
            }
          }
          return latest;
        }
      } finally {
        materialized.doc.destroy();
      }
    }
    await input.pushStore.recordLiveSettlementFailure?.({
      pushId: pending.push.id,
      claim: pending.claim,
      error: "live document changed during settlement",
    });
    throw new PendingLiveSettlementError(pending.push.id);
  }

  function changeEventMessage(
    projection: CommittedChangeTrailProjection,
    pending: PendingLiveSettlement,
  ): Omit<ChangeEventWsMessage, "type"> {
    const capped = projection.changes.slice(0, 100);
    return {
      documentId: projection.documentId as ChangeEventWsMessage["documentId"],
      threadId: projection.owner.threadId,
      trailId: projection.trailId,
      projectionRevision: projection.projectionRevision,
      author:
        pending.push.threadId === null && pending.push.pushedByUserId
          ? { kind: "writer", userId: pending.push.pushedByUserId }
          : projection.owner.kind === "turn"
            ? {
                kind: "agent",
                threadId: projection.owner.threadId,
                turnId: projection.owner.turnId,
              }
            : {
                kind: "agent",
                threadId: projection.owner.threadId,
                turnId: null,
              },
      admittedByUserId: pending.push.pushedByUserId ?? null,
      changes: capped.map(projectChangeEvent),
      truncated: projection.changes.length > capped.length,
    };
  }

  function projectChangeEvent(
    change: CommittedChangeTrailProjection["changes"][number],
  ): ChangeEventProjection {
    // Inserts/modifications show admitted text; deletes show what disappeared.
    // The trail remains the authority for full bodies beyond this bounded cue.
    const hashline = change.kind === "delete" ? change.beforeText : change.afterTextAtReceipt;
    const body = bodyFromHashline(hashline);
    const text = body.status === "available" ? body.markdown : null;
    return {
      changeId: change.changeId,
      kind: change.kind,
      navigation: change.navigation,
      swept: change.writerProtection !== undefined,
      excerpt: text === null ? null : text.slice(0, 500),
    };
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
    if (!input.pushStore.withCompletionFence) return complete();
    return input.pushStore.withCompletionFence(
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
    const recoverableIds = await input.pushStore.listRecoverableSettlementIds?.();
    if (!recoverableIds) throw new Error("Branch push store cannot recover durable settlements");
    let recovered = 0;
    for (const pushId of recoverableIds) {
      recoveryInput?.signal?.throwIfAborted();
      let row: PendingLiveSettlement | null = null;
      try {
        if (!input.pushStore.claimRecoverable) {
          throw new Error("Branch push store cannot claim a durable settlement");
        }
        row = await input.pushStore.claimRecoverable({ pushId, token: randomUUID() });
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
        await input.pushStore.recordLiveSettlementFailure?.({
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

/** The only reconstruction path for settlement authority and provenance, warm or cold. */
export function materializeFinalPrePush(row: PendingLiveSettlement): {
  doc: Y.Doc;
  provenanceView: PendingLiveSettlement["provenanceView"];
} {
  const doc = createCollabYDoc({ gc: false });
  Y.applyUpdate(doc, row.lockCutUpdate);
  for (const update of row.postCutUpdates) Y.applyUpdate(doc, update);
  return { doc, provenanceView: row.provenanceView };
}

export function fullStateFingerprint(doc: Y.Doc): string {
  return createHash("sha256").update(Y.encodeStateAsUpdate(doc)).digest("base64");
}

/** Shared synchronous recheck/apply primitive for already-durable forward actions. */
export function applyCommittedUpdateAtFingerprint(input: {
  liveDoc: Y.Doc;
  update: Uint8Array;
  expectedFingerprint: string;
  origin?: unknown;
}): "applied" | "live_changed" {
  if (fullStateFingerprint(input.liveDoc) !== input.expectedFingerprint) return "live_changed";
  Y.applyUpdate(input.liveDoc, input.update, input.origin);
  return "applied";
}
