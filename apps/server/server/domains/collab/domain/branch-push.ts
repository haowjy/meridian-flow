/** Durable-first work-draft to live push service for branch peers. */
import { createHash } from "node:crypto";
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
  pushKind: "whole";
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
};

export type BranchPushInvalidation = {
  workId: WorkId | null;
  documentId: DocumentId;
  threadIds: ThreadId[];
};

export type PushToLiveResult =
  | {
      status: "pushed";
      push: PushLineageRow;
      update: Uint8Array;
      invalidation: BranchPushInvalidation;
      branchReset?: { branchId: string; fromGeneration: number };
    }
  | { status: "already_pushed"; push: PushLineageRow; invalidation?: BranchPushInvalidation };

export type BranchPushStore = {
  listActiveJournalRows(branchId: string, generation: number): Promise<BranchJournalRow[]>;
  latestPushForBranch?(branchId: string, generation: number): Promise<PushLineageRow | null>;
  commitPush(input: {
    branch: BranchSnapshot;
    journalRows: BranchJournalRow[];
    pushUpdate: Uint8Array;
    receiptPayload: PushReceiptPayload;
    idempotencyKey: string;
    markdownProjection: string;
    liveStateVector: Uint8Array;
    pushedByUserId?: UserId;
  }): Promise<{ status: "inserted" | "conflict"; push: PushLineageRow }>;
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

  async function compute(branchId: string): Promise<{
    branch: BranchSnapshot;
    rows: BranchJournalRow[];
    pushUpdate: Uint8Array;
    receipt: PushReceiptPayload;
    markdownProjection: string;
    liveStateVector: Uint8Array;
    idempotencyKey: string;
    invalidation: BranchPushInvalidation;
  }> {
    const branch = await input.branchStore.getBranch(branchId);
    if (!branch) throw new Error(`Branch ${branchId} does not exist`);
    if (branch.kind !== "work_draft" || branch.status !== "active") {
      throw new Error(`Branch ${branchId} is not an active work draft`);
    }
    const rows = await input.pushStore.listActiveJournalRows(branchId, branch.generation);
    if (rows.length === 0) {
      const existing = await input.pushStore.latestPushForBranch?.(branchId, branch.generation);
      if (existing) throw new NoActiveRowsExistingPush(existing);
    }
    const liveDoc = await loadLiveDoc(branch.documentId);
    const branchDoc = materializeBranch(branch);
    const pushUpdate = computePushUpdate({ branch, branchDoc, liveDoc });
    const afterDoc = createCollabYDoc({ gc: false });
    Y.applyUpdate(afterDoc, Y.encodeStateAsUpdate(liveDoc));
    Y.applyUpdate(afterDoc, pushUpdate);
    const receipt = buildReceipt({
      model: input.model,
      documentId: branch.documentId,
      branch,
      beforeDoc: liveDoc,
      afterDoc,
    });
    const markdownProjection = markdownFromDoc(input.model, input.codec, afterDoc);
    const liveStateVector = Y.encodeStateVector(afterDoc);
    const idempotencyKey = stablePushIdempotencyKey({
      branchId,
      generation: branch.generation,
      journalIds: rows.map((row) => row.id),
      pushKind: "whole",
    });
    return {
      branch,
      rows,
      pushUpdate,
      receipt,
      markdownProjection,
      liveStateVector,
      idempotencyKey,
      invalidation: invalidationFrom(branch, rows),
    };
  }

  async function resetAutoBranchIfDrained(
    branch: BranchSnapshot,
    liveAfterPush: Uint8Array,
  ): Promise<{ branchId: string; fromGeneration: number } | undefined> {
    if (branch.pushPolicy !== "auto" || !input.branchCoordinator) return undefined;
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
      schemaVersion: branch.schemaVersion,
    });
    return reset ? { branchId: branch.branchId, fromGeneration } : undefined;
  }

  async function pushToLive(inputPush: {
    branchId: string;
    pushedByUserId?: UserId;
  }): Promise<PushToLiveResult> {
    return mutex.run("live-push", async () => {
      // Phase 1: read-only compute. No branch coordinator lock and no live coordinator lock.
      let phase1: Awaited<ReturnType<typeof compute>>;
      try {
        phase1 = await compute(inputPush.branchId);
      } catch (cause) {
        if (cause instanceof NoActiveRowsExistingPush) {
          return { status: "already_pushed", push: cause.push };
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
        markdownProjection: phase1.markdownProjection,
        liveStateVector: phase1.liveStateVector,
        pushedByUserId: inputPush.pushedByUserId,
      });
      if (committed.status === "conflict") {
        return {
          status: "already_pushed",
          push: committed.push,
          invalidation: phase1.invalidation,
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

      const branchReset = await resetAutoBranchIfDrained(phase1.branch, liveAfterPush);

      return {
        status: "pushed",
        push: committed.push,
        update: phase1.pushUpdate,
        invalidation: phase1.invalidation,
        ...(branchReset ? { branchReset } : {}),
      };
    });
  }

  return {
    pushToLive,

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
      for (const branchId of await input.pushStore.listActiveWorkDraftBranchIdsForWork(
        policyInput.workId,
      )) {
        await pushToLive({ branchId, pushedByUserId: policyInput.pushedByUserId });
      }
      // Store update is intentionally last: a crash can leave manual with pushed rows, never auto with unpushed rows.
      await input.pushStore.updateWorkDraftPushPolicy(policyInput.workId, "auto");
      return { status: "updated", policy: "auto" };
    },

    async markFailedResponseRollbackPending(rollbackInput) {
      const rowsMarked = await input.pushStore.markRollbackPending(rollbackInput);
      return { status: "rollback_pending", rowsMarked };
    },
  };
}

class NoActiveRowsExistingPush extends Error {
  constructor(readonly push: PushLineageRow) {
    super("Branch has no active rows and already has a push lineage row");
  }
}

function invalidationFrom(
  branch: BranchSnapshot,
  rows: BranchJournalRow[],
): BranchPushInvalidation {
  const threadIds = [
    ...new Set(rows.map((row) => row.threadId).filter((id): id is ThreadId => id !== null)),
  ].sort();
  return { workId: branch.workId, documentId: branch.documentId, threadIds };
}

function wholeBranchPushUpdate(input: { branchDoc: Y.Doc; liveDoc: Y.Doc }): Uint8Array {
  return Y.encodeStateAsUpdate(input.branchDoc, Y.encodeStateVector(input.liveDoc));
}

function buildReceipt(input: {
  model: YProsemirrorDocumentModel;
  documentId: DocumentId;
  branch: BranchSnapshot;
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
    pushKind: "whole",
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
