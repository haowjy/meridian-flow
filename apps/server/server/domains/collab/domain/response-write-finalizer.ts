/** Durable response settlement with post-commit participants and per-part failed-response inverses. */
import { isResponseLifecycleError } from "@meridian/agent-edit/integration";
import type { DocumentId } from "@meridian/contracts/runtime";
import type { ResponseWriteCommitFinalizeResult, ResponseWriteFinalizer } from "../contracts.js";
import type { ResponseSaveResult, ThreadPeerAgentEditCore } from "./agent-edit-cores.js";
import type { DocumentProjectionRefreshService } from "./document-projection-refresher.js";
import { enlistResponseParticipant } from "./response-transaction.js";
import type { PostDurabilityNoticeService } from "./reversal-notices.js";

export function createResponseWriteFinalizer(input: {
  agentEdit: ThreadPeerAgentEditCore;
  rollback: Pick<import("./turn-inverse-service.js").TurnInverseService, "rollbackResponse">;
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
        ...(ctx.planningFrontier ? { planningFrontier: ctx.planningFrontier } : {}),
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
              // The save already checkpointed every drafted peer.
              // Refreshes are independent: one document's failure skips no other.
              const failures: unknown[] = [];
              for (const document of saved.documents) {
                try {
                  await input.projections.refresh(
                    { documentId: document.documentId as DocumentId, threadId: ctx.threadId },
                    "collab.response_finalize",
                  );
                } catch (cause) {
                  failures.push(cause);
                }
              }
              if (failures.length === 1) throw failures[0];
              if (failures.length > 1)
                throw new AggregateError(failures, "Response finalize refreshes failed");
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
