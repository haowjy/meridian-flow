/** Durable response settlement with post-commit participants and per-part failed-response inverses. */
import { isResponseLifecycleError } from "@meridian/agent-edit/integration";
import type { DocumentId, ThreadId } from "@meridian/contracts/runtime";
import type { ResponseWriteCommitFinalizeResult, ResponseWriteFinalizer } from "../contracts.js";
import type { ResponseSaveResult, ThreadPeerAgentEditCore } from "./agent-edit-cores.js";
import type { BranchCoordinator } from "./branch-coordinator.js";
import type { DocumentProjectionRefreshService } from "./document-projection-refresher.js";
import type { ApplicationBranchStore } from "./ports/application-branch-store.js";
import { enlistResponseParticipant } from "./response-transaction.js";
import type { PostDurabilityNoticeService } from "./reversal-notices.js";

export type ResponseBranchFinalization = {
  checkpointThreadPeer(documentId: DocumentId, threadId: ThreadId): Promise<void>;
};

export function createResponseBranchFinalization(input: {
  branches: Pick<ApplicationBranchStore, "resolveThreadBranch">;
  branchCoordinator: Pick<BranchCoordinator, "checkpointBranch">;
}): ResponseBranchFinalization {
  return {
    async checkpointThreadPeer(documentId, threadId) {
      const peer = await input.branches.resolveThreadBranch(documentId, threadId);
      try {
        await input.branchCoordinator.checkpointBranch(peer.branchId);
      } finally {
        peer.doc.destroy();
      }
    },
  };
}

export function createResponseWriteFinalizer(input: {
  agentEdit: ThreadPeerAgentEditCore;
  rollback: Pick<import("./turn-inverse-service.js").TurnInverseService, "rollbackResponse">;
  branches: ResponseBranchFinalization;
  projections: DocumentProjectionRefreshService;
  notices: PostDurabilityNoticeService;
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
    async finalizeResponseCommit(responseIdentity, ctx, beforeTransactionCommit) {
      const result = await input.agentEdit.commitResponse(responseIdentity.editScopeId, {
        beforeTransactionCommit: async (saved) => {
          await beforeTransactionCommit?.(mapResult(saved));
          // These effects belong to a committed response, never to its save attempt.
          // Participant failures are diagnosed by the transaction owner after durability;
          // they cannot escape into the orchestrator's rollback-eligible response scope.
          enlistResponseParticipant({
            abort() {},
            async commit() {
              if (saved.awarenessDegraded) {
                await input.notices.recordAwarenessDegraded({
                  threadId: ctx.threadId,
                  responseId: responseIdentity.providerResponseId,
                  documentIds: saved.documents.map((document) => document.documentId),
                });
              }
              const drafted = new Set(saved.draftedDocumentIds);
              for (const document of saved.documents) {
                try {
                  if (drafted.has(document.documentId)) {
                    await input.branches.checkpointThreadPeer(
                      document.documentId as DocumentId,
                      ctx.threadId,
                    );
                  }
                } finally {
                  await input.projections.refresh(
                    { documentId: document.documentId as DocumentId, threadId: ctx.threadId },
                    "collab.response_finalize",
                  );
                }
              }
            },
          });
        },
      });
      return mapResult(result);
    },

    async finalizeResponseRollback(responseIdentity, ctx) {
      const result = await input.agentEdit
        .rollbackResponse(responseIdentity.editScopeId)
        .catch((cause: unknown) => {
          if (
            isResponseLifecycleError(cause) &&
            cause.detail.responseId === responseIdentity.editScopeId &&
            cause.detail.operation === "rollback" &&
            cause.detail.state === "rolledBack"
          )
            return { stagedCreates: { committed: [], discarded: [] } };
          throw cause;
        });
      await input.rollback.rollbackResponse({ ...ctx, responseIdentity });
      return { stagedCreates: result.stagedCreates };
    },
  };
}
