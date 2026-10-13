/** Selective Discard re-forks a Work draft from live and its surviving journal rows. */
import type { UpdateJournal } from "@meridian/agent-edit/integration";
import { createCollabYDoc } from "@meridian/prosemirror-schema";
import * as Y from "yjs";
import type { BranchCoordinator, BranchSnapshot, BranchStore } from "./branch-coordinator.js";
import {
  type BranchCriticalSections,
  createBranchCriticalSections,
} from "./branch-critical-sections.js";
import {
  type BranchJournalReadStore,
  type BranchJournalRow,
  BranchPushCommitConflictError,
  BranchPushRetryExhaustedError,
  type BranchReviewService,
  type PushCommitStore,
} from "./branch-push-contracts.js";
import { assertNoPendingIntegration } from "./branch-push-plan.js";
import { documentEffectsEqual } from "./document-content.js";

type Dependencies = {
  branchStore: BranchStore;
  journalReadStore: BranchJournalReadStore;
  commitStore: PushCommitStore;
  branchCoordinator?: Partial<Pick<BranchCoordinator, "notifyReset">>;
  journal: UpdateJournal;
  criticalSections?: BranchCriticalSections;
};

export function createBranchReviewOperations(deps: Dependencies): BranchReviewService {
  const criticalSections = deps.criticalSections ?? createBranchCriticalSections();

  async function listReviewableRows(
    branchId: string,
    generation: number,
  ): Promise<BranchJournalRow[]> {
    return deps.journalReadStore.listReviewableJournalRows(branchId, generation);
  }

  async function loadLiveDoc(documentId: BranchSnapshot["documentId"]): Promise<Y.Doc> {
    const snapshot = await deps.journal.read(documentId);
    const doc = createCollabYDoc({ gc: false });
    if (snapshot.checkpoint) Y.applyUpdate(doc, snapshot.checkpoint);
    for (const row of snapshot.updates) Y.applyUpdate(doc, row.update);
    return doc;
  }

  async function withActiveWorkDraftBranchLock<T>(
    branchIds: readonly string[],
    run: (branches: readonly BranchSnapshot[]) => Promise<T>,
  ): Promise<T> {
    if (branchIds.length === 0) throw new Error("active work draft lock requires a branch");
    return criticalSections.withBranches(branchIds, () => retryingCas(branchIds, run));
  }

  /** Re-reads the branches and runs again when another process moved one under us. */
  async function retryingCas<T>(
    branchIds: readonly string[],
    run: (branches: readonly BranchSnapshot[]) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        const branches = await Promise.all(
          branchIds.map(async (branchId) =>
            assertActiveWorkDraftBranch(await deps.branchStore.getBranch(branchId), branchId),
          ),
        );
        return await run(branches);
      } catch (cause) {
        if (!(cause instanceof BranchPushCommitConflictError)) throw cause;
        if (attempt >= maxCasRetries) {
          throw new BranchPushRetryExhaustedError(cause.branchId, maxCasRetries, cause);
        }
      }
    }
  }

  async function discardSelected(
    discardInput: Parameters<BranchReviewService["discardSelected"]>[0],
  ): ReturnType<BranchReviewService["discardSelected"]> {
    return withActiveWorkDraftBranchLock([discardInput.branchId], async ([branch]) => {
      const reviewableRows = await listReviewableRows(branch.branchId, branch.generation);
      const selection = await discardInput.selectRows(branch, reviewableRows);
      const selected = new Set(selection.journalIds);
      if (selected.size === 0) throw new Error("selective_discard_requires_rows");
      const rows = reviewableRows.filter((row) => selected.has(row.id));
      if (rows.length !== selected.size) {
        return {
          status: "nothing_to_undo" as const,
          branchId: branch.branchId,
          journalIds: [...selected].sort((a, b) => a - b),
        };
      }
      const history = await deps.journalReadStore.listJournalRowsForBranch({
        branchId: branch.branchId,
        generation: branch.generation,
      });
      const survivors = history.filter(
        (row) => row.status !== "discarded" && !selected.has(row.id),
      );
      const peer = await loadLiveDoc(branch.documentId);
      const live = new Y.Doc({ gc: false });
      Y.applyUpdate(live, Y.encodeStateAsUpdate(peer));
      try {
        for (const row of survivors) Y.applyUpdate(peer, row.updateData);
        assertNoPendingIntegration(
          peer,
          "selective_discard_refork",
          survivors.map((row) => row.id),
        );
        const itemClosed = documentEffectsEqual(live, peer);
        await deps.commitStore.commitDiscard({
          branch,
          journalRows: rows,
          survivors,
          retireSurvivors: itemClosed,
          expectedLiveRevision: selection.expectedLiveRevision,
          state: Y.encodeStateAsUpdate(itemClosed ? live : peer),
          stateVector: Y.encodeStateVector(itemClosed ? live : peer),
          reviewedByUserId: discardInput.reviewedByUserId,
        });
        deps.branchCoordinator?.notifyReset?.({
          branchId: branch.branchId,
          generation: branch.generation + 1,
        });
        return {
          status: "discarded",
          branchId: branch.branchId,
          journalIds: [...selected].sort((a, b) => a - b),
          itemClosed,
          ...(itemClosed
            ? {
                itemDisposition: history.some((row) => row.status === "pushed")
                  ? ("applied" as const)
                  : ("discarded" as const),
              }
            : {}),
        };
      } finally {
        live.destroy();
        peer.destroy();
      }
    });
  }

  return {
    discardSelected,
  };
}

const maxCasRetries = 3;

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
