/** Selective Discard re-forks a Work draft from live and its surviving journal rows. */
import type { UpdateJournal } from "@meridian/agent-edit/integration";
import { createCollabYDoc } from "@meridian/prosemirror-schema";
import * as Y from "yjs";
import {
  type Attempt,
  type AttemptScope,
  NO_ATTEMPT_SCOPE,
  runBoundedAttempts,
} from "./branch-attempts.js";
import type { BranchCoordinator } from "./branch-coordinator.js";
import {
  type BranchJournalReadStore,
  type BranchJournalRow,
  BranchPushCommitConflictError,
  type BranchReviewService,
  DraftChangeRefusal,
  type PushCommitStore,
} from "./branch-push-contracts.js";
import { assertNoPendingIntegration } from "./branch-push-plan.js";
import type { BranchSnapshot, BranchStore } from "./branch-store.js";
import { documentEffectsEqual } from "./document-content.js";

type Dependencies = {
  branchStore: BranchStore;
  journalReadStore: BranchJournalReadStore;
  commitStore: PushCommitStore;
  branchCoordinator?: Partial<Pick<BranchCoordinator, "notifyReset">>;
  journal: UpdateJournal;
  /** Each attempt's rollback boundary: a root transaction, or a savepoint in an ambient one. */
  attemptScope?: AttemptScope;
};

export function createBranchReviewOperations(deps: Dependencies): BranchReviewService {
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

  /**
   * Attempts that re-read the branches and run again when a writer's frame or another
   * process moved one under us. Four attempts each finding the draft moved (a writer typing)
   * answer stale, as a selection made against an older draft does.
   */
  async function withActiveWorkDraftBranches<T>(
    branchIds: readonly string[],
    run: (branches: readonly BranchSnapshot[], attempt: Attempt) => Promise<T>,
  ): Promise<T> {
    if (branchIds.length === 0) throw new Error("A selected Discard names a branch");
    return runBoundedAttempts({
      bound: DISCARD_ATTEMPTS,
      scope: deps.attemptScope ?? NO_ATTEMPT_SCOPE,
      isMiss: (cause) => cause instanceof BranchPushCommitConflictError,
      run: async (attempt) => {
        const branches = await Promise.all(
          branchIds.map(async (branchId) =>
            assertActiveWorkDraftBranch(await deps.branchStore.getBranch(branchId), branchId),
          ),
        );
        return run(branches, attempt);
      },
      exhausted: () => {
        throw new DraftChangeRefusal("stale");
      },
    });
  }

  async function discardSelected(
    discardInput: Parameters<BranchReviewService["discardSelected"]>[0],
  ): ReturnType<BranchReviewService["discardSelected"]> {
    return withActiveWorkDraftBranches([discardInput.branchId], async ([branch], attempt) => {
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
        const itemDisposition = history.some((row) => row.status === "pushed")
          ? ("applied" as const)
          : ("discarded" as const);
        const outcome = { itemClosed, ...(itemClosed ? { itemDisposition } : {}) };
        // Computed above off every lock; the re-fork's one commit scope.
        await attempt.commit(() =>
          deps.commitStore.commitDiscard({
            ...(discardInput.command
              ? {
                  command: {
                    envelope: discardInput.command.envelope,
                    result: discardInput.command.result(outcome),
                  },
                }
              : {}),
            branch,
            journalRows: rows,
            survivors,
            retireSurvivors: itemClosed,
            expectedLiveRevision: selection.expectedLiveRevision,
            state: Y.encodeStateAsUpdate(itemClosed ? live : peer),
            reviewedByUserId: discardInput.reviewedByUserId,
          }),
        );
        attempt.own({
          transfer: () =>
            deps.branchCoordinator?.notifyReset?.({
              branchId: branch.branchId,
              generation: branch.generation + 1,
            }),
          dispose() {},
        });
        return {
          status: "discarded",
          branchId: branch.branchId,
          journalIds: [...selected].sort((a, b) => a - b),
          ...outcome,
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

const DISCARD_ATTEMPTS = 4;

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
