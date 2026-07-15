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
import { createCollabYDoc } from "@meridian/prosemirror-schema";
import * as Y from "yjs";
import type {
  BranchPushStore,
  CompletionFenceResult,
  PendingLiveSettlement,
  PreparedPushCommit,
  PushSweptTrail,
} from "./branch-push-executor.js";
import type { WriterIngressBarrier } from "./ports/writer-ingress-barrier.js";
import { materializeCandidateProvenance, ProvenanceMaterializationError } from "./provenance.js";
import { canonicalBlockKey } from "./trail-read-kernel.js";

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
    swept: PushSweptTrail;
  } | null {
    const before = snapshotBlocks(toDocHandle(prePushDoc), input.model, input.codec);
    const afterDoc = createCollabYDoc({ gc: false });
    try {
      Y.applyUpdate(afterDoc, Y.encodeStateAsUpdate(prePushDoc));
      Y.applyUpdate(afterDoc, pending.pushUpdate);
      const after = snapshotBlocks(toDocHandle(afterDoc), input.model, input.codec);
      if (pending.lineageEvidence.items.length === 0) {
        const lockDoc = createCollabYDoc({ gc: false });
        try {
          Y.applyUpdate(lockDoc, pending.lockCutUpdate);
          const locked = new Map(
            snapshotBlocks(toDocHandle(lockDoc), input.model, input.codec).flatMap((block) =>
              block.clientID === undefined || block.clock === undefined
                ? []
                : [[`${block.clientID}:${block.clock}`, block.renderedContent] as const],
            ),
          );
          const hasLateCandidateEffect = before.some(
            (block) =>
              block.clientID !== undefined &&
              block.clock !== undefined &&
              locked.get(`${block.clientID}:${block.clock}`) !== block.renderedContent &&
              pending.deletedParentIdentities.some(
                (identity) =>
                  identity.clientID === block.clientID && identity.clock === block.clock,
              ),
          );
          if (!hasLateCandidateEffect) return null;
        } finally {
          lockDoc.destroy();
        }
      }
      const preProvenance =
        pending.provenanceView.length > 0
          ? pending.provenanceView
          : before.flatMap((block) =>
              (block.lineage ?? []).map((range) => ({
                target: range,
                root: range,
                birthClass: "writer_protected" as const,
              })),
            );
      const beforeOccurrences = occurrencesFor(before, preProvenance);
      const afterProvenance = materializeCandidateProvenance(afterDoc, preProvenance);
      const afterOccurrences = occurrencesFor(after, afterProvenance);
      const evidenceById = new Map(pending.responseEvidence.map((item) => [item.evidenceId, item]));
      const eligibleByRendering = new Map<string, LineageRange[]>();

      const evidenceItems =
        pending.lineageEvidence.items.length > 0
          ? pending.lineageEvidence.items
          : [
              {
                evidenceId: "unsealed-blind-effect",
                authoringResponseId: "00000000-0000-4000-8000-000000000000",
                token: {
                  version: 3 as const,
                  documentId: pending.push.documentId,
                  protectedRoots: [],
                  responseCausalCutId: "unsealed-blind-effect",
                },
              },
            ];
      for (const item of evidenceItems) {
        const response = evidenceById.get(item.evidenceId);
        if (!response && item.evidenceId !== "unsealed-blind-effect") {
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
          protectionScope: item.token.protectedRoots,
          responseCut: {
            ...(response?.responseCut ?? {
              id: "unsealed-blind-effect",
              version: 1 as const,
              documentId: pending.push.documentId,
              authorityId: pending.push.documentId,
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

      if (eligibleByRendering.size === 0) return null;
      const fallbackSweptIdentities = new Set(
        pending.lineageEvidence.items.length === 0
          ? pending.trail.changes.flatMap((change) =>
              change.writerProtection?.kind === "sweep" && change.beforeBlockIdentity
                ? [canonicalBlockKey(change.beforeBlockIdentity)]
                : [],
            )
          : [],
      );
      const affected = before.filter((block) => {
        if (block.renderedContent === undefined || !eligibleByRendering.has(renderingKey(block))) {
          return false;
        }
        if (fallbackSweptIdentities.size === 0) return true;
        if (block.clientID === undefined || block.clock === undefined) return false;
        return fallbackSweptIdentities.has(
          canonicalBlockKey({
            documentId: pending.push.documentId,
            clientID: block.clientID,
            clock: block.clock,
          }),
        );
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
              claim: pending.claim,
              joinVersion: pending.joinVersion,
            })
          : true;
        if (settled === false) throw new PendingLiveSettlementError(pending.push.id);
        if (cut) latest = cut.swept;

        const completion = await completeUnderFence({
          pending,
          liveDoc: inputSettlement.liveDoc,
          finalPrePush: materialized.doc,
          ingressGeneration,
        });
        if (completion === "applied" || completion === "already_applied") return latest;
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
    const legacyCandidates = input.pushStore.listRecoverableSettlementIds
      ? []
      : ((await input.pushStore.listPendingLiveSettlements?.()) ?? []);
    const recoverableIds = input.pushStore.listRecoverableSettlementIds
      ? await input.pushStore.listRecoverableSettlementIds()
      : legacyCandidates.map((row) => row.push.id);
    let recovered = 0;
    for (const pushId of recoverableIds) {
      recoveryInput?.signal?.throwIfAborted();
      let row: PendingLiveSettlement | null = null;
      try {
        row = input.pushStore.claimRecoverable
          ? await input.pushStore.claimRecoverable({
              pushId,
              token: randomUUID(),
            })
          : (legacyCandidates.find((candidate) => candidate.push.id === pushId) ?? null);
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
