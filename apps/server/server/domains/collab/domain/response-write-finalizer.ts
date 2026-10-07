/** Reply save and rollback across every destination, plus post-durability notices. */
import type { ReversalStore } from "@meridian/agent-edit/integration";
import type { DocumentId, ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { ResponseWriteCommitFinalizeResult, ResponseWriteFinalizer } from "../contracts.js";
import type {
  LiveAgentEditCore,
  ResponseSaveResult,
  ThreadPeerAgentEditCore,
} from "./agent-edit-cores.js";
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
  /** Queues a callback for after the ambient transaction commits; false when there is none. */
  deferUntilCommit?(callback: () => Promise<void>): boolean;
}): ResponseWriteFinalizer {
  const mapResult = (result: ResponseSaveResult): ResponseWriteCommitFinalizeResult => ({
    status: "committed",
    documents: result.documents,
    stagedCreates: result.stagedCreates,
    refused: result.refused,
    ...(result.awarenessDegraded ? { awarenessDegraded: true } : {}),
  });

  return {
    /** One save step for every reply, live and drafted documents together (D42). */
    async finalizeResponseCommit(responseId, ctx, beforeTransactionCommit) {
      const result = await input.agentEdit.commitResponse(responseId, {
        beforeTransactionCommit: async (saved) => {
          await beforeTransactionCommit?.(mapResult(saved));
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
      const drafted = new Set<string>(result.draftedDocumentIds);
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
        if (drafted.has(document.documentId)) {
          await input.branches.checkpointThreadPeer(
            document.documentId as DocumentId,
            ctx.threadId,
          );
        }
      }
      // The refresh reads the live document, which loads journal rows into
      // open rooms. Inside the save's transaction that would show open
      // editors a reply a later rollback never saves, so it waits for commit.
      const refresh = async () => {
        for (const document of result.documents) {
          await input.projections.refresh(
            { documentId: document.documentId as DocumentId, threadId: ctx.threadId },
            "collab.response_finalize",
          );
        }
      };
      if (!input.deferUntilCommit?.(refresh)) await refresh();
      return mapResult(result);
    },

    async finalizeResponseRollback(responseId, ctx) {
      // Only Work-draft branches carry rollback-pending state; live documents
      // are reversed by the cross-scope turn reversal below.
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
