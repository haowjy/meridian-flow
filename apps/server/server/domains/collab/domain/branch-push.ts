/** Durable-first work-draft to live push service for branch peers. */
import { createHash, randomUUID } from "node:crypto";
import {
  type DocumentCoordinator,
  toDocHandle,
  type UpdateJournal,
  type YProsemirrorDocumentModel,
} from "@meridian/agent-edit";
import type { DocumentId, ThreadId, TurnId, UserId, WorkId } from "@meridian/contracts/runtime";
import type { MarkupCodec } from "@meridian/markup";
import { createCollabYDoc } from "@meridian/prosemirror-schema";
import * as Y from "yjs";
import { KeyedMutex } from "../../../shared/keyed-mutex.js";
import type { BranchCoordinator, BranchSnapshot, BranchStore } from "./branch-coordinator.js";

export type BranchJournalRow = {
  id: number;
  branchId: string;
  generation: number;
  wId: number | null;
  source: "agent" | "writer";
  threadId: ThreadId | null;
  turnId: TurnId | null;
  actorUserId: UserId | null;
  updateData: Uint8Array;
  status: "active" | "pushed" | "discarded" | "rollback_pending";
  updateMeta?: unknown;
};

export type ReceiptBlockChange = {
  blockId: string;
  beforeText: string | null;
  afterText: string | null;
  beforeWordCount: number;
  afterWordCount: number;
  wordDelta: number;
};

export type PushReceiptPayload = {
  version: 1;
  documentId: DocumentId;
  branchId: string;
  branchGeneration: number;
  pushKind: "whole" | "selective";
  changedBlocks: ReceiptBlockChange[];
  totalWordDelta: number;
};

export type PushLineageRow = {
  id: number;
  branchId: string | null;
  documentId: DocumentId;
  pushKind: "whole" | "selective";
  journalIds: number[];
  upstreamUpdateSeq: number | null;
  receiptPayload: PushReceiptPayload | null;
  idempotencyKey: string;
  receiptId?: string | null;
  threadId?: ThreadId | null;
  turnId?: TurnId | null;
};

export type BranchPushConflictEcho = {
  overlappingBlockIds: string[];
  current: Array<
    Pick<BranchJournalRow, "id" | "branchId" | "source" | "threadId" | "turnId" | "wId">
  >;
  concurrentPushes: Array<
    Pick<PushLineageRow, "id" | "branchId" | "threadId" | "turnId" | "journalIds">
  >;
};

export type PushToLiveResult =
  | {
      status: "pushed";
      push: PushLineageRow;
      update: Uint8Array;
      branchReset?: { branchId: string; fromGeneration: number };
      conflictEcho?: BranchPushConflictEcho;
    }
  | { status: "already_pushed"; push: PushLineageRow; conflictEcho?: BranchPushConflictEcho }
  | {
      status: "noop";
      branchId: string;
      documentId: DocumentId;
      branchGeneration: number;
      reason: "no_active_rows";
    };

export type PreparedPushCommit = {
  branch: BranchSnapshot;
  journalRows: BranchJournalRow[];
  pushUpdate: Uint8Array;
  receiptPayload: PushReceiptPayload;
  idempotencyKey: string;
  receiptId?: string;
  markdownProjection: string;
  liveStateVector: Uint8Array;
  liveState: Uint8Array;
  pushedByUserId?: UserId;
};

export type BranchPushStore = {
  listActiveJournalRows(branchId: string, generation: number): Promise<BranchJournalRow[]>;
  listConcurrentJournalRows(
    branchId: string,
    generation: number,
    options: { afterJournalId?: number; documentId: DocumentId },
  ): Promise<BranchJournalRow[]>;
  latestPushForBranch?(branchId: string, generation: number): Promise<PushLineageRow | null>;
  listPushesForDocument?(documentId: DocumentId): Promise<PushLineageRow[]>;
  commitPush(
    input: PreparedPushCommit,
  ): Promise<{ status: "inserted" | "conflict"; push: PushLineageRow }>;
  commitPushBatch?(input: { pushes: PreparedPushCommit[] }): Promise<{ pushes: PushLineageRow[] }>;
  countUnpushedRowsForWork(workId: WorkId): Promise<number>;
  listActiveWorkDraftBranchIdsForWork(workId: WorkId): Promise<string[]>;
  updateWorkDraftPushPolicy(workId: WorkId, policy: "manual" | "auto"): Promise<void>;
  markRollbackPending(input: {
    branchId: string;
    threadId: ThreadId;
    turnId: TurnId;
  }): Promise<number>;
};

export type PushUpdateComputer = (input: {
  branch: BranchSnapshot;
  branchDoc: Y.Doc;
  liveDoc: Y.Doc;
}) => Uint8Array;

export type AutoPushAfterThreadPeerWriteInput = {
  workDraftBranchId: string;
  pushedByUserId?: UserId;
};

export type AutoPushAfterThreadPeerWriteResult =
  | PushToLiveResult
  | { status: "skipped"; reason: "manual_policy" | "not_active_work_draft" };

export type BranchPushService = {
  pushToLive(input: { branchId: string; pushedByUserId?: UserId }): Promise<PushToLiveResult>;
  pushSelectedToLive(input: {
    branchId: string;
    journalIds: readonly number[];
    pushedByUserId?: UserId;
  }): Promise<PushToLiveResult>;
  pushToLiveWithManifestEntry(input: {
    branchId: string;
    manifestBranchId: string;
    manifestEntryDocumentId: DocumentId;
    pushedByUserId?: UserId;
  }): Promise<PushToLiveResult>;
  pushAutoBranchAfterThreadPeerWrite(
    input: AutoPushAfterThreadPeerWriteInput,
  ): Promise<AutoPushAfterThreadPeerWriteResult>;
  setWorkPushPolicy(input: {
    workId: WorkId;
    policy: "manual" | "auto";
    confirmedPush?: boolean;
    pushedByUserId?: UserId;
  }): Promise<
    | { status: "updated"; policy: "manual" | "auto" }
    | { status: "confirmation_required"; unpushedCount: number; reason: string }
  >;
  markFailedResponseRollbackPending(input: {
    branchId: string;
    threadId: ThreadId;
    turnId: TurnId;
  }): Promise<{ status: "rollback_pending"; rowsMarked: number }>;
};

export function createBranchPushService(input: {
  branchStore: BranchStore;
  pushStore: BranchPushStore;
  branchCoordinator?: Pick<BranchCoordinator, "resetFromDocIfUnchanged">;
  journal: UpdateJournal;
  liveCoordinator: DocumentCoordinator;
  model: YProsemirrorDocumentModel;
  codec: MarkupCodec;
  pushUpdateComputer?: PushUpdateComputer;
  mutex?: KeyedMutex;
}): BranchPushService {
  const mutex = input.mutex ?? new KeyedMutex();
  const computePushUpdate = input.pushUpdateComputer ?? wholeBranchPushUpdate;

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
    branchId: string,
    options: {
      pushKind?: "whole" | "selective";
      selectRows?: (row: BranchJournalRow) => boolean;
    } = {},
  ): Promise<{
    branch: BranchSnapshot;
    rows: BranchJournalRow[];
    pushUpdate: Uint8Array;
    receipt: PushReceiptPayload;
    markdownProjection: string;
    liveStateVector: Uint8Array;
    liveState: Uint8Array;
    idempotencyKey: string;
    receiptId: string;
    conflictEcho?: BranchPushConflictEcho;
  }> {
    const branch = await input.branchStore.getBranch(branchId);
    if (!branch) throw new Error(`Branch ${branchId} does not exist`);
    if (branch.kind !== "work_draft" || branch.status !== "active") {
      throw new Error(`Branch ${branchId} is not an active work draft`);
    }
    const activeRows = await input.pushStore.listActiveJournalRows(branchId, branch.generation);
    const rows = options.selectRows ? activeRows.filter(options.selectRows) : activeRows;
    if (rows.length === 0) {
      const existing = await input.pushStore.latestPushForBranch?.(branchId, branch.generation);
      if (existing) throw new NoActiveRowsExistingPush(existing);
      throw new NoActiveRowsNoop(branch);
    }
    const pushKind = options.pushKind ?? "whole";
    const liveDoc = await loadLiveDoc(branch.documentId);
    const afterDoc = createCollabYDoc({ gc: false });
    let branchDoc: Y.Doc | null = null;
    try {
      if (pushKind === "selective") {
        Y.applyUpdate(afterDoc, Y.encodeStateAsUpdate(liveDoc));
        for (const row of rows) Y.applyUpdate(afterDoc, row.updateData);
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
      const markdownProjection = markdownFromDoc(input.model, input.codec, afterDoc);
      const liveState = Y.encodeStateAsUpdate(afterDoc);
      const liveStateVector = Y.encodeStateVector(afterDoc);
      const idempotencyKey = stablePushIdempotencyKey({
        branchId,
        generation: branch.generation,
        journalIds: rows.map((row) => row.id),
        pushKind,
      });
      return {
        branch,
        rows,
        pushUpdate,
        receipt,
        markdownProjection,
        liveStateVector,
        liveState,
        idempotencyKey,
        receiptId: randomUUID(),
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
    }
  }

  async function resetAutoBranchIfDrained(
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
    const reset = await input.branchCoordinator.resetFromDocIfUnchanged({
      branchId: branch.branchId,
      upstream: liveDoc,
      expectedGeneration: branch.generation,
      expectedStateVector: branch.stateVector,
      expectedState: branch.state,
      schemaVersion: branch.schemaVersion,
    });
    return reset ? { branchId: branch.branchId, fromGeneration } : undefined;
  }

  async function pushToLive(inputPush: {
    branchId: string;
    pushedByUserId?: UserId;
    resetPolicy?: "manual" | "auto";
  }): Promise<PushToLiveResult> {
    for (let attempt = 0; attempt <= maxCasRetries; attempt += 1) {
      try {
        const branchForLock = await input.branchStore.getBranch(inputPush.branchId);
        const lockKey = branchForLock?.documentId ?? inputPush.branchId;
        return await mutex.run(`live-push:${lockKey}`, async () => {
          // Phase 1: read-only compute. No branch coordinator lock and no live coordinator lock.
          let phase1: Awaited<ReturnType<typeof compute>>;
          try {
            phase1 = await compute(inputPush.branchId);
          } catch (cause) {
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
            throw cause;
          }

          // Phase 2: durable commit. The live journal row and lineage commit before live memory moves.
          const committed = await input.pushStore.commitPush({
            branch: phase1.branch,
            journalRows: phase1.rows,
            pushUpdate: phase1.pushUpdate,
            receiptPayload: phase1.receipt,
            idempotencyKey: phase1.idempotencyKey,
            receiptId: phase1.receiptId,
            markdownProjection: phase1.markdownProjection,
            liveStateVector: phase1.liveStateVector,
            liveState: phase1.liveState,
            pushedByUserId: inputPush.pushedByUserId,
          });
          if (committed.status === "conflict") {
            return {
              status: "already_pushed",
              push: committed.push,
              conflictEcho: phase1.conflictEcho,
            };
          }

          // Phase 3: apply the committed bytes under the live lock after durability.
          const liveAfterPush = await input.liveCoordinator.withDocument(
            phase1.branch.documentId,
            async (liveDoc) => {
              Y.applyUpdate(liveDoc, phase1.pushUpdate);
              return Y.encodeStateAsUpdate(liveDoc);
            },
          );

          const branchReset = await resetAutoBranchIfDrained(
            phase1.branch,
            liveAfterPush,
            inputPush.resetPolicy,
          );

          return {
            status: "pushed",
            push: committed.push,
            update: phase1.pushUpdate,
            ...(phase1.conflictEcho ? { conflictEcho: phase1.conflictEcho } : {}),
            ...(branchReset ? { branchReset } : {}),
          };
        });
      } catch (cause) {
        if (cause instanceof BranchPushCommitConflictError) {
          if (attempt >= maxCasRetries) {
            throw new BranchPushRetryExhaustedError(inputPush.branchId, maxCasRetries, cause);
          }
          continue;
        }
        throw cause;
      }
    }
    throw new BranchPushRetryExhaustedError(inputPush.branchId, maxCasRetries);
  }

  async function pushToLiveWithManifestEntry(inputPush: {
    branchId: string;
    manifestBranchId: string;
    manifestEntryDocumentId: DocumentId;
    pushedByUserId?: UserId;
  }): Promise<PushToLiveResult> {
    if (!input.pushStore.commitPushBatch) {
      throw new Error("Branch push store does not support atomic companion pushes");
    }
    for (let attempt = 0; attempt <= maxCasRetries; attempt += 1) {
      try {
        const [contentBranch, manifestBranch] = await Promise.all([
          input.branchStore.getBranch(inputPush.branchId),
          input.branchStore.getBranch(inputPush.manifestBranchId),
        ]);
        const lockKeys = [
          contentBranch?.documentId ?? inputPush.branchId,
          manifestBranch?.documentId ?? inputPush.manifestBranchId,
        ]
          .map((key) => `live-push:${key}`)
          .sort();
        return await mutex.run(lockKeys[0] as string, () =>
          mutex.run(lockKeys[1] as string, async () => {
            let content: Awaited<ReturnType<typeof compute>>;
            try {
              content = await compute(inputPush.branchId);
            } catch (cause) {
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
              throw cause;
            }

            let manifest: Awaited<ReturnType<typeof compute>> | null = null;
            try {
              manifest = await compute(inputPush.manifestBranchId, {
                pushKind: "selective",
                selectRows: (row) =>
                  manifestMembershipRowDocumentId(row) === inputPush.manifestEntryDocumentId,
              });
            } catch (cause) {
              if (
                !(cause instanceof NoActiveRowsNoop) &&
                !(cause instanceof NoActiveRowsExistingPush)
              )
                throw cause;
            }

            const receiptId = randomUUID();
            const pushes = [content, ...(manifest ? [manifest] : [])].map((phase) => ({
              branch: phase.branch,
              journalRows: phase.rows,
              pushUpdate: phase.pushUpdate,
              receiptPayload: phase.receipt,
              idempotencyKey: phase.idempotencyKey,
              receiptId,
              markdownProjection: phase.markdownProjection,
              liveStateVector: phase.liveStateVector,
              liveState: phase.liveState,
              pushedByUserId: inputPush.pushedByUserId,
            }));
            const committed =
              pushes.length === 1
                ? {
                    pushes: [
                      (await input.pushStore.commitPush(pushes[0] as PreparedPushCommit)).push,
                    ],
                  }
                : await input.pushStore.commitPushBatch?.({
                    pushes: pushes as PreparedPushCommit[],
                  });
            if (!committed) throw new Error("Branch push batch did not commit");

            for (const phase of [content, ...(manifest ? [manifest] : [])]) {
              await input.liveCoordinator.withDocument(phase.branch.documentId, async (liveDoc) => {
                Y.applyUpdate(liveDoc, phase.pushUpdate);
              });
            }

            return {
              status: "pushed",
              push: committed.pushes[0] as PushLineageRow,
              update: content.pushUpdate,
              ...(content.conflictEcho ? { conflictEcho: content.conflictEcho } : {}),
            };
          }),
        );
      } catch (cause) {
        if (cause instanceof BranchPushCommitConflictError) {
          if (attempt >= maxCasRetries) {
            throw new BranchPushRetryExhaustedError(inputPush.branchId, maxCasRetries, cause);
          }
          continue;
        }
        throw cause;
      }
    }
    throw new BranchPushRetryExhaustedError(inputPush.branchId, maxCasRetries);
  }

  async function pushSelectedToLive(inputPush: {
    branchId: string;
    journalIds: readonly number[];
    pushedByUserId?: UserId;
  }): Promise<PushToLiveResult> {
    const selected = new Set(inputPush.journalIds);
    if (selected.size === 0) {
      throw new Error("selective_push_requires_rows");
    }
    for (let attempt = 0; attempt <= maxCasRetries; attempt += 1) {
      try {
        const branchForLock = await input.branchStore.getBranch(inputPush.branchId);
        const lockKey = branchForLock?.documentId ?? inputPush.branchId;
        return await mutex.run(`live-push:${lockKey}`, async () => {
          const phase1 = await compute(inputPush.branchId, {
            pushKind: "selective",
            selectRows: (row) => selected.has(row.id),
          });
          if (phase1.rows.length !== selected.size) {
            throw new BranchPushCommitConflictError(inputPush.branchId);
          }
          const committed = await input.pushStore.commitPush({
            branch: phase1.branch,
            journalRows: phase1.rows,
            pushUpdate: phase1.pushUpdate,
            receiptPayload: phase1.receipt,
            idempotencyKey: phase1.idempotencyKey,
            receiptId: phase1.receiptId,
            markdownProjection: phase1.markdownProjection,
            liveStateVector: phase1.liveStateVector,
            liveState: phase1.liveState,
            pushedByUserId: inputPush.pushedByUserId,
          });
          if (committed.status === "conflict")
            return { status: "already_pushed", push: committed.push };
          await input.liveCoordinator.withDocument(phase1.branch.documentId, async (liveDoc) => {
            Y.applyUpdate(liveDoc, phase1.pushUpdate);
          });
          return { status: "pushed", push: committed.push, update: phase1.pushUpdate };
        });
      } catch (cause) {
        if (cause instanceof BranchPushCommitConflictError) {
          if (attempt >= maxCasRetries) {
            throw new BranchPushRetryExhaustedError(inputPush.branchId, maxCasRetries, cause);
          }
          continue;
        }
        throw cause;
      }
    }
    throw new BranchPushRetryExhaustedError(inputPush.branchId, maxCasRetries);
  }

  return {
    pushToLive,
    pushSelectedToLive,
    pushToLiveWithManifestEntry,

    async pushAutoBranchAfterThreadPeerWrite(autoInput) {
      const branch = await input.branchStore.getBranch(autoInput.workDraftBranchId);
      if (branch?.kind !== "work_draft" || branch.status !== "active") {
        return { status: "skipped", reason: "not_active_work_draft" };
      }
      if (branch.pushPolicy !== "auto") return { status: "skipped", reason: "manual_policy" };
      return pushToLive({
        branchId: autoInput.workDraftBranchId,
        pushedByUserId: autoInput.pushedByUserId,
      });
    },

    async setWorkPushPolicy(policyInput) {
      if (policyInput.policy === "manual") {
        await input.pushStore.updateWorkDraftPushPolicy(policyInput.workId, "manual");
        return { status: "updated", policy: "manual" };
      }
      const unpushedCount = await input.pushStore.countUnpushedRowsForWork(policyInput.workId);
      if (unpushedCount > 0 && !policyInput.confirmedPush) {
        return {
          status: "confirmation_required",
          unpushedCount,
          reason: `Switching to Auto-apply will apply ${unpushedCount} pending changes.`,
        };
      }
      if (unpushedCount > 0) {
        for (const branchId of await input.pushStore.listActiveWorkDraftBranchIdsForWork(
          policyInput.workId,
        )) {
          await pushToLive({
            branchId,
            pushedByUserId: policyInput.pushedByUserId,
            resetPolicy: "auto",
          });
        }
      }
      await input.pushStore.updateWorkDraftPushPolicy(policyInput.workId, "auto");
      return { status: "updated", policy: "auto" };
    },

    async markFailedResponseRollbackPending(rollbackInput) {
      const rowsMarked = await input.pushStore.markRollbackPending(rollbackInput);
      return { status: "rollback_pending", rowsMarked };
    },
  };
}

export class BranchPushCommitConflictError extends Error {
  constructor(readonly branchId: string) {
    super(`Branch ${branchId} changed before its push could commit`);
    this.name = "BranchPushCommitConflictError";
  }
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

function conflictEchoFrom(input: {
  currentBranch: BranchSnapshot;
  currentRows: BranchJournalRow[];
  currentReceipt: PushReceiptPayload;
  priorPushes?: PushLineageRow[];
}): BranchPushConflictEcho | undefined {
  const currentChanged = new Set(input.currentReceipt.changedBlocks.map((block) => block.blockId));
  if (currentChanged.size === 0) return undefined;
  const concurrentPushes: BranchPushConflictEcho["concurrentPushes"] = [];
  const overlapping = new Set<string>();
  for (const push of input.priorPushes ?? []) {
    if (push.branchId === input.currentBranch.branchId) continue;
    const priorReceipt = push.receiptPayload;
    if (!priorReceipt) continue;
    const priorGeneration = priorReceipt.branchGeneration;
    if (
      push.branchId === input.currentBranch.upstreamBranchId &&
      priorGeneration <= input.currentBranch.generation
    ) {
      continue;
    }
    const overlap = priorReceipt.changedBlocks
      .filter(
        (block) =>
          currentChanged.has(block.blockId) &&
          !priorBlockIsInCurrentBase(
            block,
            priorReceipt,
            input.currentBranch,
            input.currentReceipt,
          ),
      )
      .map((block) => block.blockId);
    if (overlap.length === 0) continue;
    for (const blockId of overlap) overlapping.add(blockId);
    concurrentPushes.push({
      id: push.id,
      branchId: push.branchId,
      threadId: push.threadId ?? null,
      turnId: push.turnId ?? null,
      journalIds: push.journalIds,
    });
  }
  if (overlapping.size === 0) return undefined;
  return {
    overlappingBlockIds: [...overlapping].sort(),
    current: input.currentRows.map((row) => ({
      id: row.id,
      branchId: row.branchId,
      source: row.source,
      threadId: row.threadId,
      turnId: row.turnId,
      wId: row.wId,
    })),
    concurrentPushes,
  };
}

function priorBlockIsInCurrentBase(
  priorBlock: ReceiptBlockChange,
  priorReceipt: PushReceiptPayload,
  currentBranch: BranchSnapshot,
  currentReceipt: PushReceiptPayload,
): boolean {
  if (priorReceipt.branchGeneration >= currentBranch.generation) return false;
  const currentBlock = currentReceipt.changedBlocks.find(
    (block) => block.blockId === priorBlock.blockId,
  );
  return currentBlock ? priorBlock.afterText === currentBlock.beforeText : false;
}

function wholeBranchPushUpdate(input: { branchDoc: Y.Doc; liveDoc: Y.Doc }): Uint8Array {
  return Y.encodeStateAsUpdate(input.branchDoc, Y.encodeStateVector(input.liveDoc));
}

function buildReceipt(input: {
  model: YProsemirrorDocumentModel;
  documentId: DocumentId;
  branch: BranchSnapshot;
  pushKind: "whole" | "selective";
  beforeDoc: Y.Doc;
  afterDoc: Y.Doc;
}): PushReceiptPayload {
  const before = blockTextMap(input.model, input.beforeDoc);
  const after = blockTextMap(input.model, input.afterDoc);
  const blockIds = new Set([...before.keys(), ...after.keys()]);
  const changedBlocks = [...blockIds]
    .filter((blockId) => before.get(blockId) !== after.get(blockId))
    .sort()
    .map((blockId) => {
      const beforeText = before.get(blockId) ?? null;
      const afterText = after.get(blockId) ?? null;
      const beforeWordCount = wordCount(beforeText ?? "");
      const afterWordCount = wordCount(afterText ?? "");
      return {
        blockId,
        beforeText,
        afterText,
        beforeWordCount,
        afterWordCount,
        wordDelta: afterWordCount - beforeWordCount,
      };
    });
  return {
    version: 1,
    documentId: input.documentId,
    branchId: input.branch.branchId,
    branchGeneration: input.branch.generation,
    pushKind: input.pushKind,
    changedBlocks,
    totalWordDelta: changedBlocks.reduce((sum, row) => sum + row.wordDelta, 0),
  };
}

function blockTextMap(model: YProsemirrorDocumentModel, doc: Y.Doc): Map<string, string> {
  const result = new Map<string, string>();
  for (const block of model.getBlocks(toDocHandle(doc))) {
    result.set(model.getBlockId(block), model.getText(block));
  }
  return result;
}

function markdownFromDoc(model: YProsemirrorDocumentModel, codec: MarkupCodec, doc: Y.Doc): string {
  const blocks = model.getBlocks(toDocHandle(doc));
  return blocks.length === 0 ? "" : codec.serialize(model.projectBlocks(toDocHandle(doc)));
}

function wordCount(text: string): number {
  return text.trim() ? (text.trim().match(/\S+/g) ?? []).length : 0;
}

function stablePushIdempotencyKey(input: {
  branchId: string;
  generation: number;
  journalIds: number[];
  pushKind: "whole" | "selective";
}): string {
  return createHash("sha256")
    .update(input.branchId)
    .update("\0")
    .update(String(input.generation))
    .update("\0")
    .update(input.pushKind)
    .update("\0")
    .update([...input.journalIds].sort((a, b) => a - b).join(","))
    .digest("hex");
}

function manifestMembershipRowDocumentId(row: BranchJournalRow): DocumentId | null {
  const meta = row.updateMeta;
  if (typeof meta !== "object" || meta === null) return null;
  const record = meta as { kind?: unknown; documentId?: unknown };
  return record.kind === "manifest_membership" && typeof record.documentId === "string"
    ? (record.documentId as DocumentId)
    : null;
}
