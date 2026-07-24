/** Response commit/rollback finalization and post-durability awareness notices. */
import type { ResponseCommitSuccessResult, ReversalStore } from "@meridian/agent-edit/integration";
import type { DocumentId, ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { ResponseWriteCommitFinalizeResult, ResponseWriteFinalizer } from "../contracts.js";
import type { LiveAgentEditCore, ThreadPeerAgentEditCore } from "./agent-edit-cores.js";
import type { BranchCoordinator } from "./branch-coordinator.js";
import type { BranchJournalReadStore, BranchReviewService } from "./branch-push-contracts.js";
import type { DocumentProjectionRefreshService } from "./document-projection-refresher.js";
import type { ApplicationBranchStore } from "./ports/application-branch-store.js";
import type { PostDurabilityNoticeService } from "./reversal-notices.js";
import { type ReverseTurnDeps, reverseTurn } from "./turn-reversal.js";

export type ResponseBranchFinalization = {
  checkpointThreadPeer(documentId: DocumentId, threadId: ThreadId): Promise<void>;
  prepareFailedResponseRollback(input: {
    threadId: ThreadId;
    turnId: TurnId;
  }): Promise<() => Promise<void>>;
};

export function createResponseBranchFinalization(input: {
  branches: Pick<ApplicationBranchStore, "resolveThreadBranch" | "getBranch">;
  branchCoordinator: Pick<BranchCoordinator, "checkpointBranch">;
  branchJournal: Pick<BranchJournalReadStore, "listJournalRowsForTurn">;
  branchReview: Pick<BranchReviewService, "markFailedResponseRollbackPending">;
}): ResponseBranchFinalization {
  return {
    async checkpointThreadPeer(documentId, threadId) {
      const peer = await input.branches.resolveThreadBranch(documentId, threadId);
      try {
        // Thread peers push every write durably into the work draft; their own
        // snapshot is only a recovery checkpoint and is persisted at response commit.
        await input.branchCoordinator.checkpointBranch(peer.branchId);
      } finally {
        peer.doc.destroy();
      }
    },
    async prepareFailedResponseRollback({ threadId, turnId }) {
      const activeBranchRows = await input.branchJournal.listJournalRowsForTurn({
        threadId,
        turnId,
        statuses: ["active"],
      });
      return async () => {
        for (const branchId of [...new Set(activeBranchRows.map((row) => row.branchId))]) {
          const branch = await input.branches.getBranch(branchId);
          if (
            branch?.kind !== "work_draft" ||
            branch.status !== "active" ||
            !activeBranchRows.some(
              (row) => row.branchId === branchId && row.generation === branch.generation,
            )
          ) {
            continue;
          }
          await input.branchReview.markFailedResponseRollbackPending({
            branchId,
            threadId,
            turnId,
          });
        }
      };
    },
  };
}

export function createResponseWriteFinalizer(input: {
  agentEdit: ThreadPeerAgentEditCore;
  liveAgentEdit: LiveAgentEditCore;
  reversalStore: ReversalStore;
  liveReversal: Required<Pick<ReverseTurnDeps, "checkDependentLaterLiveRows">>;
  resolveDocumentUri(documentId: string): Promise<string | null>;
  branches: ResponseBranchFinalization;
  projections: DocumentProjectionRefreshService;
  notices: PostDurabilityNoticeService;
}): ResponseWriteFinalizer {
  const mapResult = (result: ResponseCommitSuccessResult): ResponseWriteCommitFinalizeResult => ({
    status: "committed",
    documents: result.documents,
    stagedCreates: result.stagedCreates,
    ...(result.awarenessDegraded ? { awarenessDegraded: true } : {}),
  });

  return {
    async finalizeResponseCommit(responseId, ctx, beforeTransactionCommit) {
      const result = await input.agentEdit.commitResponse(responseId, {
        beforeTransactionCommit: async (commitResult) => {
          await beforeTransactionCommit?.(mapResult(commitResult));
        },
      });
      if (result.awarenessDegraded) {
        const documentIds = result.documents.map((document) => document.documentId);
        await input.notices.recordAwarenessDegraded({
          threadId: ctx.threadId,
          responseId,
          documentIds,
        });
      }
      for (const document of result.documents) {
        const { lateSweep } = document;
        if (lateSweep) {
          await input.notices.recordLateSweep({
            threadId: ctx.threadId,
            responseId,
            documentId: document.documentId,
            lateSweep,
          });
        }
        await input.branches.checkpointThreadPeer(document.documentId as DocumentId, ctx.threadId);
        await input.projections.refresh(
          { documentId: document.documentId as DocumentId, threadId: ctx.threadId },
          "collab.response_finalize",
        );
      }
      return mapResult(result);
    },

    async finalizeResponseRollback(responseId, ctx) {
      const markRollbackPending = await input.branches.prepareFailedResponseRollback(ctx);
      const result = await input.agentEdit.rollbackResponse(responseId);
      await markRollbackPending();
      await reverseTurn(
        {
          reversalStore: input.reversalStore,
          agentEdit: input.liveAgentEdit,
          resolveDocumentUri: input.resolveDocumentUri,
          checkDependentLaterLiveRows: input.liveReversal.checkDependentLaterLiveRows,
          refreshDocumentProjection: (projection) => input.projections.refresh(projection),
        },
        {
          threadId: ctx.threadId,
          turnId: ctx.turnId,
          direction: "undo",
          actor: { type: "agent", responseId },
        },
      );
      return { stagedCreates: result.stagedCreates };
    },
  };
}
