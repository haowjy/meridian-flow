/** Durable-first work-draft to live push service for branch peers. */
import { randomUUID } from "node:crypto";
import { createAgentEditCodec } from "@meridian/agent-edit/integration";
import type { DocumentId, UserId } from "@meridian/contracts/runtime";
import { createCollabYDoc } from "@meridian/prosemirror-schema";
import * as Y from "yjs";
import type { BranchSnapshot } from "./branch-coordinator.js";
import { type BranchLockLease, createBranchCriticalSections } from "./branch-critical-sections.js";
import {
  type BranchJournalRow,
  BranchPushCommitConflictError,
  type BranchPushConflictEcho,
  type BranchPushExecutorInput,
  type BranchPushService,
  type PendingLiveSettlement,
  type PushLineageRow,
  type PushReceiptPayload,
  type PushSweptTrail,
  type PushToLiveResult,
} from "./branch-push-contracts.js";
import {
  assertNoPendingIntegration,
  assertRowsIntegrated,
  buildReceipt,
  conflictEchoFrom,
  stablePushIdempotencyKey,
  wholeBranchPushUpdate,
} from "./branch-push-plan.js";
import { preparePushUnderLiveLock } from "./branch-push-preparation.js";
import { createBranchPushTransition } from "./branch-push-transition.js";
import { createBranchReviewOperations } from "./branch-review-operations.js";
import { buildDurablePushTrail, projectPushSweep } from "./branch-trail-projection.js";
import type { DurableTrailRecord } from "./ports/change-trail-persistence.js";
import { createWorkPushPolicy } from "./work-push-policy.js";

export function createBranchPushExecutor(input: BranchPushExecutorInput): BranchPushService {
  const criticalSections = input.criticalSections ?? createBranchCriticalSections();
  const computePushUpdate = input.pushUpdateComputer ?? wholeBranchPushUpdate;
  const attributionCodec = createAgentEditCodec(input.codec);
  const transition = createBranchPushTransition({
    pushStore: input.pushStore,
    settlementStore: input.settlementStore,
    liveCoordinator: input.liveCoordinator,
    model: input.model,
    codec: attributionCodec,
    writerIngressBarrier: input.writerIngressBarrier,
  });

  async function loadLiveDoc(documentId: DocumentId): Promise<Y.Doc> {
    const snapshot = await input.journal.read(documentId);
    const doc = createCollabYDoc({ gc: false });
    if (snapshot.checkpoint) Y.applyUpdate(doc, snapshot.checkpoint);
    for (const row of snapshot.updates) Y.applyUpdate(doc, row.update);
    return doc;
  }

  function materializeBranch(branch: BranchSnapshot): Y.Doc {
    const doc = createCollabYDoc({ gc: false });
    Y.applyUpdate(doc, branch.state);
    return doc;
  }

  async function compute(
    branch: BranchSnapshot,
    options: {
      pushKind?: "whole" | "selective";
      selectRows?: (row: BranchJournalRow) => boolean;
    } = {},
  ): Promise<{
    branch: BranchSnapshot;
    rows: BranchJournalRow[];
    pushUpdate: Uint8Array;
    receipt: PushReceiptPayload;
    idempotencyKey: string;
    receiptId: string;
    baselineState: Uint8Array;
    rowBaselineStates: ReadonlyMap<number, Uint8Array>;
    conflictEcho?: BranchPushConflictEcho;
  }> {
    const reviewableRows = await listReviewableRows(branch.branchId, branch.generation);
    const rows = options.selectRows ? reviewableRows.filter(options.selectRows) : reviewableRows;
    if (rows.length === 0) {
      const existing = await input.pushStore.latestPushForBranch?.(
        branch.branchId,
        branch.generation,
      );
      if (existing) throw new NoActiveRowsExistingPush(existing);
      throw new NoActiveRowsNoop(branch);
    }
    const pushKind = options.pushKind ?? "whole";
    const baselineUpdateSeq = Math.min(...rows.map((row) => row.draftBaseUpdateSeq));
    const baselineSnapshots = new Map(
      await Promise.all(
        [...new Set(rows.map((row) => row.draftBaseUpdateSeq))].map(
          async (seq) =>
            [seq, await input.journal.read(branch.documentId, { until: seq })] as const,
        ),
      ),
    );
    const rowBaselineStates = new Map<number, Uint8Array>();
    for (const [seq, snapshot] of baselineSnapshots) {
      const doc = createCollabYDoc({ gc: false });
      if (snapshot.checkpoint) Y.applyUpdate(doc, snapshot.checkpoint);
      for (const journalRow of snapshot.updates) Y.applyUpdate(doc, journalRow.update);
      rowBaselineStates.set(seq, Y.encodeStateAsUpdate(doc));
      doc.destroy();
    }
    const baselineDoc = createCollabYDoc({ gc: false });
    Y.applyUpdate(baselineDoc, rowBaselineStates.get(baselineUpdateSeq) as Uint8Array);
    const liveDoc = await loadLiveDoc(branch.documentId);
    const afterDoc = createCollabYDoc({ gc: false });
    let branchDoc: Y.Doc | null = null;
    try {
      if (pushKind === "selective") {
        Y.applyUpdate(afterDoc, Y.encodeStateAsUpdate(liveDoc));
        for (const row of rows) Y.applyUpdate(afterDoc, row.updateData);
        assertNoPendingIntegration(
          afterDoc,
          "selective_push_peer",
          rows.map((row) => row.id),
        );
        assertRowsIntegrated(afterDoc, rows, "selective_push_peer");
      } else {
        branchDoc = materializeBranch(branch);
        const wholeUpdate = computePushUpdate({ branch, branchDoc, liveDoc });
        Y.applyUpdate(afterDoc, Y.encodeStateAsUpdate(liveDoc));
        Y.applyUpdate(afterDoc, wholeUpdate);
      }
      const pushUpdate =
        pushKind === "selective"
          ? Y.encodeStateAsUpdate(afterDoc, Y.encodeStateVector(liveDoc))
          : computePushUpdate({ branch, branchDoc: branchDoc as Y.Doc, liveDoc });
      const receipt = buildReceipt({
        model: input.model,
        documentId: branch.documentId,
        branch,
        pushKind,
        beforeDoc: liveDoc,
        afterDoc,
      });
      const idempotencyKey = stablePushIdempotencyKey({
        branchId: branch.branchId,
        generation: branch.generation,
        journalIds: rows.map((row) => row.id),
        pushKind,
      });
      return {
        branch,
        rows,
        pushUpdate,
        receipt,
        idempotencyKey,
        receiptId: randomUUID(),
        baselineState: Y.encodeStateAsUpdate(baselineDoc),
        rowBaselineStates,
        conflictEcho:
          pushKind === "whole"
            ? conflictEchoFrom({
                currentBranch: branch,
                currentRows: rows,
                currentReceipt: receipt,
                priorPushes: await input.pushStore.listPushesForDocument?.(branch.documentId),
              })
            : undefined,
      };
    } finally {
      branchDoc?.destroy();
      afterDoc.destroy();
      liveDoc.destroy();
      baselineDoc.destroy();
    }
  }

  type ComputedPush = Awaited<ReturnType<typeof compute>>;

  const preparePush = (phase: ComputedPush, lockCutUpdate: Uint8Array, receiptId?: string) =>
    preparePushUnderLiveLock(
      { journal: input.journal, model: input.model, attributionCodec },
      phase,
      lockCutUpdate,
      receiptId,
    );

  function pendingLiveSettlement(
    prepared: Awaited<ReturnType<typeof preparePush>>,
    documentTitle: string,
    trail: DurableTrailRecord,
  ): Omit<PendingLiveSettlement, "push"> {
    return transition.prepare({
      documentTitle,
      provenanceView: [],
      lockCutUpdate: prepared.lockCutUpdate,
      pushUpdate: prepared.prepared.pushUpdate,
      beforeContentRef: prepared.beforeContentRef,
      trail,
    });
  }

  async function listReviewableRows(
    branchId: string,
    generation: number,
  ): Promise<BranchJournalRow[]> {
    return (input.pushStore.listReviewableJournalRows ?? input.pushStore.listActiveJournalRows)(
      branchId,
      generation,
    );
  }

  async function withActiveWorkDraftBranchLock<T>(
    branchIds: readonly string[],
    run: (branches: readonly BranchSnapshot[], lease: BranchLockLease) => Promise<T>,
  ): Promise<T> {
    const retryBranchId = branchIds[0];
    if (!retryBranchId) throw new Error("active work draft lock requires at least one branch");
    for (let attempt = 0; attempt <= maxCasRetries; attempt += 1) {
      try {
        return await criticalSections.withBranches(branchIds, async (lease) => {
          const branches = await Promise.all(branchIds.map(loadActiveWorkDraftBranch));
          return run(branches, lease);
        });
      } catch (cause) {
        if (cause instanceof BranchPushCommitConflictError) {
          if (attempt >= maxCasRetries) {
            throw new BranchPushRetryExhaustedError(cause.branchId, maxCasRetries, cause);
          }
          continue;
        }
        throw cause;
      }
    }
    throw new BranchPushRetryExhaustedError(retryBranchId, maxCasRetries);
  }

  async function loadActiveWorkDraftBranch(branchId: string): Promise<BranchSnapshot> {
    return assertActiveWorkDraftBranch(await input.branchStore.getBranch(branchId), branchId);
  }

  function mapNoActiveRows(cause: unknown): PushToLiveResult | null {
    if (cause instanceof NoActiveRowsExistingPush) {
      return { status: "already_pushed", push: cause.push };
    }
    if (cause instanceof NoActiveRowsNoop) {
      return {
        status: "noop",
        branchId: cause.branch.branchId,
        documentId: cause.branch.documentId,
        branchGeneration: cause.branch.generation,
        reason: "no_active_rows",
      };
    }
    return null;
  }

  async function resetAutoBranchIfDrained(
    lease: BranchLockLease,
    branch: BranchSnapshot,
    liveAfterPush: Uint8Array,
    targetPolicy: "manual" | "auto" = branch.pushPolicy,
  ): Promise<{ branchId: string; fromGeneration: number } | undefined> {
    if (targetPolicy !== "auto" || !input.branchCoordinator) return undefined;
    const activeRows = await input.pushStore.listActiveJournalRows(
      branch.branchId,
      branch.generation,
    );
    if (activeRows.length > 0) return undefined;
    const fromGeneration = branch.generation;
    const liveDoc = createCollabYDoc({ gc: false });
    Y.applyUpdate(liveDoc, liveAfterPush);
    const reset = await input.branchCoordinator.resetFromDocIfUnchangedWithLease(lease, {
      branchId: branch.branchId,
      upstream: liveDoc,
      expectedGeneration: branch.generation,
      expectedStateVector: branch.stateVector,
      expectedState: branch.state,
      schemaVersion: branch.schemaVersion,
    });
    return reset ? { branchId: branch.branchId, fromGeneration } : undefined;
  }

  async function executeWhole(inputPush: {
    branchId: string;
    pushedByUserId?: UserId;
    resetPolicy?: "manual" | "auto";
    signal?: AbortSignal;
    overlapPolicy?: "refuse" | "apply_and_trail";
  }): Promise<PushToLiveResult> {
    return withActiveWorkDraftBranchLock<PushToLiveResult>(
      [inputPush.branchId],
      async ([branch], lease) => {
        if (!branch) throw new Error("active work draft lock did not provide its branch");
        // Phase 1: read-only compute. No branch coordinator lock and no live coordinator lock.
        let phase1: Awaited<ReturnType<typeof compute>>;
        try {
          phase1 = await compute(branch);
        } catch (cause) {
          const mapped = mapNoActiveRows(cause);
          if (mapped) return mapped;
          throw cause;
        }

        const locked = await transition.execute<
          | PushToLiveResult
          | {
              kind: "committed";
              committed: PushLineageRow;
              liveAfterPush: Uint8Array;
              swept?: PushSweptTrail;
            }
        >({
          documentIds: [phase1.branch.documentId],
          signal: inputPush.signal,
          prepare: async ({ docs, lockCuts }) => {
            const liveDoc = docs.get(phase1.branch.documentId);
            if (!liveDoc) throw new Error("live push lock did not provide its document");
            const gated = await preparePush(
              phase1,
              lockCuts.get(phase1.branch.documentId) as Uint8Array,
            );
            if (
              gated.conflictedBlocks.length > 0 &&
              inputPush.overlapPolicy !== "apply_and_trail"
            ) {
              return {
                kind: "return" as const,
                value: {
                  status: "push_concurrent_conflict" as const,
                  reason: "draft_base_divergence" as const,
                  conflictedBlocks: gated.conflictedBlocks,
                  conflicts: gated.conflicts,
                },
              };
            }
            const needsSweptTrail =
              inputPush.overlapPolicy === "apply_and_trail" &&
              gated.blindConflictedBlocks.length > 0;
            if (needsSweptTrail && !input.notices) {
              throw new Error("apply_and_trail requires a durable notice recorder");
            }
            const swept = needsSweptTrail ? await projectPushSweep(gated) : undefined;
            const trailDocumentName = await resolveDocumentTitle(phase1.branch.documentId);
            const trail = buildDurablePushTrail({
              prepared: gated,
              documentTitle: trailDocumentName,
              swept,
            });
            const pendingSettlement = pendingLiveSettlement(gated, trailDocumentName, trail);
            return {
              kind: "push" as const,
              pushes: [
                {
                  ...gated.prepared,
                  pushedByUserId: inputPush.pushedByUserId,
                  trail,
                  pendingLiveSettlement: pendingSettlement,
                },
              ],
              afterDurableCommit: input.hooks?.afterDurableCommit,
              onConflict: (push: PushLineageRow) => ({
                status: "already_pushed" as const,
                push,
                ...(phase1.conflictEcho ? { conflictEcho: phase1.conflictEcho } : {}),
              }),
              finish: ({ pushes, swept: lateSweeps, docs: completedDocs }) => ({
                kind: "committed" as const,
                committed: pushes[0] as PushLineageRow,
                liveAfterPush: Y.encodeStateAsUpdate(
                  completedDocs.get(phase1.branch.documentId) as Y.Doc,
                ),
                swept: lateSweeps[0] ?? swept,
              }),
            };
          },
        });
        if (!("kind" in locked) || locked.kind !== "committed") {
          return locked as PushToLiveResult;
        }
        const completed = locked as {
          kind: "committed";
          committed: PushLineageRow;
          liveAfterPush: Uint8Array;
          swept?: PushSweptTrail;
        };

        const branchReset = await resetAutoBranchIfDrained(
          lease,
          phase1.branch,
          completed.liveAfterPush,
          inputPush.resetPolicy,
        );

        return {
          status: "pushed",
          push: completed.committed,
          update: phase1.pushUpdate,
          ...(phase1.conflictEcho ? { conflictEcho: phase1.conflictEcho } : {}),
          ...(branchReset ? { branchReset } : {}),
          ...(completed.swept ? { swept: completed.swept } : {}),
        };
      },
    );
  }

  async function executeCompanion(inputPush: {
    branchId: string;
    manifestBranchId: string;
    manifestEntryDocumentId: DocumentId;
    contentJournalIds?: readonly number[];
    pushedByUserId?: UserId;
    signal?: AbortSignal;
    overlapPolicy?: "refuse" | "apply_and_trail";
  }): Promise<PushToLiveResult> {
    if (!input.pushStore.commitPushBatch) {
      throw new Error("Branch push store does not support atomic companion pushes");
    }
    // A4.2 J4: companion candidate production is routed through the aggregate's
    // batched staged-push transition when settlement/outbox ownership moves.
    return withActiveWorkDraftBranchLock<PushToLiveResult>(
      [inputPush.branchId, inputPush.manifestBranchId],
      async ([contentBranch, manifestBranch]) => {
        if (!contentBranch || !manifestBranch) {
          throw new Error("active work draft locks did not provide both branches");
        }
        let content: Awaited<ReturnType<typeof compute>>;
        try {
          const contentJournalIds = inputPush.contentJournalIds
            ? new Set(inputPush.contentJournalIds)
            : null;
          content = await compute(
            contentBranch,
            contentJournalIds
              ? {
                  pushKind: "selective",
                  selectRows: (row) => contentJournalIds.has(row.id),
                }
              : undefined,
          );
          if (contentJournalIds && content.rows.length !== contentJournalIds.size) {
            throw new BranchPushCommitConflictError(inputPush.branchId);
          }
        } catch (cause) {
          const mapped = mapNoActiveRows(cause);
          if (mapped) return mapped;
          throw cause;
        }

        let manifest: Awaited<ReturnType<typeof compute>> | null = null;
        try {
          manifest = await compute(manifestBranch, {
            pushKind: "selective",
            selectRows: (row) =>
              manifestMembershipRowDocumentId(row) === inputPush.manifestEntryDocumentId,
          });
        } catch (cause) {
          if (
            !(cause instanceof NoActiveRowsNoop) &&
            !(cause instanceof NoActiveRowsExistingPush)
          ) {
            throw cause;
          }
        }

        const phases = [content, ...(manifest ? [manifest] : [])];
        const locked = await transition.execute<
          | PushToLiveResult
          | {
              kind: "committed";
              committed: readonly PushLineageRow[];
              swept?: PushSweptTrail;
            }
        >({
          documentIds: phases.map((phase) => phase.branch.documentId),
          signal: inputPush.signal,
          prepare: async ({ docs, lockCuts }) => {
            // One receipt identifies the entire companion transaction. Prepare trail
            // identities from that receipt rather than each phase's provisional ID.
            const receiptId = randomUUID();
            const gated = [];
            for (const [phaseIndex, phase] of phases.entries()) {
              const liveDoc = docs.get(phase.branch.documentId);
              if (!liveDoc) throw new Error("live batch push lock did not provide its document");
              const prepared = await preparePush(
                phase,
                lockCuts.get(phase.branch.documentId) as Uint8Array,
                receiptId,
              );
              if (
                prepared.conflictedBlocks.length > 0 &&
                (phaseIndex !== 0 || inputPush.overlapPolicy !== "apply_and_trail")
              ) {
                return {
                  kind: "return" as const,
                  value: {
                    status: "push_concurrent_conflict" as const,
                    reason: "draft_base_divergence" as const,
                    conflictedBlocks: prepared.conflictedBlocks,
                    conflicts: prepared.conflicts,
                  },
                };
              }
              gated.push(prepared);
            }
            const titles = await Promise.all(
              phases.map((phase) => resolveDocumentTitle(phase.branch.documentId)),
            );
            const swept =
              inputPush.overlapPolicy === "apply_and_trail" &&
              (gated[0]?.blindConflictedBlocks.length ?? 0) > 0
                ? await projectPushSweep(gated[0] as (typeof gated)[number])
                : undefined;
            const pushes = gated.map((gatedPush, index) => {
              const documentTitle = titles[index] ?? "Untitled document";
              const trail = buildDurablePushTrail({
                prepared: gatedPush,
                documentTitle,
                ...(index === 0 && swept ? { swept } : {}),
              });
              return {
                ...gatedPush.prepared,
                receiptId,
                pushedByUserId: inputPush.pushedByUserId,
                trail,
                pendingLiveSettlement: pendingLiveSettlement(gatedPush, documentTitle, trail),
              };
            });
            return {
              kind: "push" as const,
              pushes,
              afterDurableCommit: input.hooks?.afterDurableCommit,
              onConflict: () => {
                throw new BranchPushCommitConflictError(pushes[0]?.branch.branchId ?? "unknown");
              },
              finish: ({ pushes: committed, swept: lateSweeps }) => ({
                kind: "committed" as const,
                committed,
                swept: lateSweeps[0] ?? swept,
              }),
            };
          },
        });
        if (!("kind" in locked) || locked.kind !== "committed") {
          return locked as PushToLiveResult;
        }
        const completed = locked as {
          kind: "committed";
          committed: readonly PushLineageRow[];
          swept?: PushSweptTrail;
        };

        return {
          status: "pushed",
          push: completed.committed[0] as PushLineageRow,
          update: content.pushUpdate,
          ...(content.conflictEcho ? { conflictEcho: content.conflictEcho } : {}),
          ...(completed.swept ? { swept: completed.swept } : {}),
        };
      },
    );
  }

  async function executeSelective(inputPush: {
    branchId: string;
    journalIds: readonly number[];
    pushedByUserId?: UserId;
    signal?: AbortSignal;
  }): Promise<PushToLiveResult> {
    const selected = new Set(inputPush.journalIds);
    if (selected.size === 0) {
      throw new Error("selective_push_requires_rows");
    }
    return withActiveWorkDraftBranchLock([inputPush.branchId], async ([branch]) => {
      const phase1 = await compute(branch, {
        pushKind: "selective",
        selectRows: (row) => selected.has(row.id),
      });
      if (phase1.rows.length !== selected.size) {
        throw new BranchPushCommitConflictError(inputPush.branchId);
      }
      return transition.execute<PushToLiveResult>({
        documentIds: [phase1.branch.documentId],
        signal: inputPush.signal,
        prepare: async ({ docs, lockCuts }) => {
          const liveDoc = docs.get(phase1.branch.documentId);
          if (!liveDoc) throw new Error("live selective push lock did not provide its document");
          const gated = await preparePush(
            phase1,
            lockCuts.get(phase1.branch.documentId) as Uint8Array,
          );
          if (gated.conflictedBlocks.length > 0) {
            return {
              kind: "return" as const,
              value: {
                status: "push_concurrent_conflict" as const,
                reason: "draft_base_divergence" as const,
                conflictedBlocks: gated.conflictedBlocks,
                conflicts: gated.conflicts,
              },
            };
          }
          const trailDocumentName = await resolveDocumentTitle(phase1.branch.documentId);
          const trail = buildDurablePushTrail({
            prepared: gated,
            documentTitle: trailDocumentName,
          });
          const pendingSettlement = pendingLiveSettlement(gated, trailDocumentName, trail);
          return {
            kind: "push" as const,
            pushes: [
              {
                ...gated.prepared,
                pushedByUserId: inputPush.pushedByUserId,
                trail,
                pendingLiveSettlement: pendingSettlement,
              },
            ],
            afterDurableCommit: input.hooks?.afterDurableCommit,
            onConflict: (push: PushLineageRow) => ({
              status: "already_pushed" as const,
              push,
            }),
            finish: ({ pushes, swept }) => ({
              status: "pushed" as const,
              push: pushes[0] as PushLineageRow,
              update: phase1.pushUpdate,
              ...(swept[0] ? { swept: swept[0] } : {}),
            }),
          };
        },
      });
    });
  }

  type PushExecutionSpec =
    | {
        kind: "whole";
        input: Parameters<BranchPushService["pushToLive"]>[0] & { resetPolicy?: "manual" | "auto" };
      }
    | { kind: "selective"; input: Parameters<BranchPushService["pushSelectedToLive"]>[0] }
    | { kind: "companion"; input: Parameters<BranchPushService["pushToLiveWithManifestEntry"]>[0] };

  async function execute(spec: PushExecutionSpec): Promise<PushToLiveResult> {
    switch (spec.kind) {
      case "whole":
        return executeWhole(spec.input);
      case "selective":
        return executeSelective(spec.input);
      case "companion":
        return executeCompanion(spec.input);
    }
  }

  const pushToLive: BranchPushService["pushToLive"] = (inputPush) =>
    execute({ kind: "whole", input: inputPush });
  const pushSelectedToLive: BranchPushService["pushSelectedToLive"] = (inputPush) =>
    execute({ kind: "selective", input: inputPush });
  const pushToLiveWithManifestEntry: BranchPushService["pushToLiveWithManifestEntry"] = (
    inputPush,
  ) => execute({ kind: "companion", input: inputPush });

  const { discardSelected, reverseBranchTurn } = createBranchReviewOperations({
    pushStore: input.pushStore,
    broadcastUpdate: input.branchCoordinator?.broadcastUpdate,
    withActiveWorkDraftBranchLock,
    listReviewableRows,
    loadLiveDoc,
    materializeBranch,
  });

  async function resolveDocumentTitle(documentId: DocumentId): Promise<string> {
    const resolved = (await input.resolveDocumentTitle?.(documentId))?.trim();
    return resolved || "Untitled document";
  }

  const workPushPolicy = createWorkPushPolicy({
    branchStore: input.branchStore,
    pushStore: input.pushStore,
    pushToLive,
  });

  return {
    pushToLive,
    pushSelectedToLive,
    discardSelected,
    reverseBranchTurn,
    pushToLiveWithManifestEntry,
    recoverPendingLiveSettlements: transition.recover,

    ...workPushPolicy,

    async markFailedResponseRollbackPending(rollbackInput) {
      if (input.pushStore.listJournalRowsForTurn && input.pushStore.commitDiscard) {
        const reversed = await reverseBranchTurn({
          ...rollbackInput,
          direction: "undo",
        });
        if (reversed.status === "reversed") {
          return {
            status: "discarded",
            branchId: reversed.branchId,
            journalIds: reversed.journalIds,
          };
        }
      }
      const branch = await input.branchStore.getBranch(rollbackInput.branchId);
      if (!branch) throw new Error(`Branch ${rollbackInput.branchId} does not exist`);
      const rowsMarked = await input.pushStore.markRollbackPending({
        ...rollbackInput,
        generation: branch.generation,
      });
      return { status: "rollback_pending", rowsMarked };
    },
  };
}

class NoActiveRowsExistingPush extends Error {
  constructor(readonly push: PushLineageRow) {
    super("Branch has no active rows and already has a push lineage row");
  }
}

class NoActiveRowsNoop extends Error {
  constructor(readonly branch: BranchSnapshot) {
    super("Branch has no active rows and no prior lineage");
  }
}

function assertActiveWorkDraftBranch(
  branch: BranchSnapshot | null | undefined,
  branchId: string,
): BranchSnapshot {
  if (!branch) throw new Error(`Branch ${branchId} does not exist`);
  if (branch.kind !== "work_draft" || branch.status !== "active") {
    throw new Error(`Branch ${branchId} is not an active work draft`);
  }
  return branch;
}

const maxCasRetries = 3;
export class BranchPushRetryExhaustedError extends Error {
  constructor(
    readonly branchId: string,
    readonly maxRetries: number,
    cause?: unknown,
  ) {
    super(`Branch ${branchId} push did not commit after ${maxRetries} CAS retries`, { cause });
    this.name = "BranchPushRetryExhaustedError";
  }
}

function manifestMembershipRowDocumentId(row: BranchJournalRow): DocumentId | null {
  const meta = row.updateMeta;
  if (typeof meta !== "object" || meta === null) return null;
  const record = meta as { kind?: unknown; documentId?: unknown };
  return record.kind === "manifest_membership" && typeof record.documentId === "string"
    ? (record.documentId as DocumentId)
    : null;
}

export { BranchPeerIntegrationError } from "./branch-push-plan.js";
export { PendingLiveSettlementError } from "./branch-push-transition.js";
