/**
 * The reply's write lifecycle (D42): staged creates to discard, the commit
 * that saves every staged write in one transaction, and the rollback.
 */
import type {
  FrontierLookup,
  ObservationFrontier,
  ResponseCommitWriteReceipt,
  ResponseStagedCreateOutcome,
} from "@meridian/agent-edit/integration";
import { removedWriteRefusal, type WriteRejection } from "@meridian/agent-edit/integration";
import type { ModelResponseIdentity } from "@meridian/contracts";
import type {
  DocumentRemovalRecord,
  PermissionDeniedReason,
  RetractionCause,
} from "@meridian/contracts/protocol";
import type { RefusedResponseDocument } from "../../domains/collab/index.js";
import type { ContextPort } from "../../domains/context/ports/context-port.js";
import type { ToolHandlerContext } from "../../domains/runtime/index.js";
import { isPermissionDenial, permissionDeniedMessage } from "../file-access-denial-copy.js";
import { contextErrorMessage, type ToolWiringDeps } from "./tool-context.js";

type StagedCreateCleanup = {
  responseId: string;
  port: ContextPort;
  path: string;
  documentId: string;
};

export interface AgentEditResponseWriteLifecycle {
  trackStagedCreate(input: StagedCreateCleanup): void;
  commitResponse(
    responseIdentity: ModelResponseIdentity,
    ctx: SaveContext,
    beforeTransactionCommit?: (result: ResponseWriteLifecycleCommitResult) => Promise<void>,
  ): Promise<ResponseWriteLifecycleCommitResult>;
  rollbackResponse(
    responseIdentity: ModelResponseIdentity,
    ctx: Pick<ToolHandlerContext, "threadId" | "turnId">,
  ): Promise<void>;
}

/** A save records each document's frontier, chained from the model's latest one (this lookup). */
type SaveContext = Pick<ToolHandlerContext, "threadId" | "turnId"> & {
  recordingFrontier?: FrontierLookup;
};

type ResponseWriteLifecycleCommitResult =
  | {
      status: "committed";
      receipts: Array<{ documentId: string; receipt: ResponseCommitWriteReceipt }>;
      /** Host-only: the saved documents' frontiers at the save's after-state, for those that recorded one. */
      frontiers: Array<{ documentId: string; frontier: ObservationFrontier }>;
      /** Documents the save left out, with the copy their writes' results now carry (D29). */
      refused: Array<{ documentId: string } & SaveRefusal>;
    }
  | { status: "branch_closed"; responseId: string; mode: "draft" };

/** A save refusal's copy, with the policy's reason or the removal's (`rejected`, `removal`). */
type SaveRefusal = {
  message: string;
  reason?: PermissionDeniedReason;
  rejected?: WriteRejection;
  removal?: DocumentRemovalRecord;
};

/** Why the reply's save left out a document's changes (D29, D42). */
function refusedAtSave(
  refusal: Exclude<RefusedResponseDocument, { reason: unknown }>,
): SaveRefusal {
  if ("removed" in refusal) return removedWriteRefusal(refusal.removed);
  const { denial } = refusal;
  // The fence turns every `not_found` into `removed`; only permission refusals remain here.
  if (!isPermissionDenial(denial)) return removedWriteRefusal(null);
  return { message: permissionDeniedMessage(denial), reason: denial.reason };
}

/**
 * Reverse a reply's create (contract §12.5): a live create is deleted; a drafted one ends
 * its branch's use of the document, unless another thread's committed text makes it stand.
 */
export async function retractCreatedTrackedDocument(input: {
  port: ContextPort;
  path: string;
  documentId: string;
  cause: RetractionCause;
}): Promise<void> {
  const retracted = await input.port.retractCreate(input.path, {
    documentId: input.documentId,
    cause: input.cause,
  });
  if (!retracted.ok) throw new Error(contextErrorMessage(retracted.error));
}

export function createAgentEditResponseWriteLifecycle(
  deps: Pick<ToolWiringDeps, "documentSync">,
): AgentEditResponseWriteLifecycle {
  const stagedCreates = new Map<string, StagedCreateCleanup[]>();

  async function cleanupDiscardedStagedCreates(
    responseId: string,
    discardedDocumentIds: ResponseStagedCreateOutcome["discarded"],
  ): Promise<void> {
    const records = stagedCreates.get(responseId) ?? [];
    const discarded = new Set(discardedDocumentIds);
    for (const record of records) {
      if (!discarded.has(record.documentId)) continue;
      await retractCreatedTrackedDocument({ ...record, cause: "reply_rolled_back" });
    }
  }

  return {
    trackStagedCreate(input: StagedCreateCleanup): void {
      const records = stagedCreates.get(input.responseId) ?? [];
      if (
        !records.some(
          (record) => record.path === input.path && record.documentId === input.documentId,
        )
      ) {
        records.push(input);
      }
      stagedCreates.set(input.responseId, records);
    },

    async commitResponse(
      responseIdentity: ModelResponseIdentity,
      ctx: SaveContext,
      beforeTransactionCommit?: (result: ResponseWriteLifecycleCommitResult) => Promise<void>,
    ): Promise<ResponseWriteLifecycleCommitResult> {
      const responseId = responseIdentity.editScopeId;
      const mapResult = (
        result: Awaited<ReturnType<typeof deps.documentSync.finalizeResponseCommit>>,
      ): ResponseWriteLifecycleCommitResult => {
        if (result.status === "branch_closed") {
          return { status: result.status, responseId: result.responseId, mode: result.mode };
        }
        return {
          status: "committed",
          receipts: result.documents.flatMap((document) =>
            document.receipts.map((receipt) => ({ documentId: document.documentId, receipt })),
          ),
          frontiers: result.documents.flatMap((document) =>
            document.frontier
              ? [{ documentId: document.documentId, frontier: document.frontier }]
              : [],
          ),
          // A refusal with a reason is receipted write by write in `documents`.
          refused: result.refused.flatMap((refusal) =>
            "reason" in refusal
              ? []
              : [{ documentId: refusal.documentId, ...refusedAtSave(refusal) }],
          ),
        };
      };
      const result = await deps.documentSync.finalizeResponseCommit(
        responseIdentity,
        ctx,
        async (commitResult) => beforeTransactionCommit?.(mapResult(commitResult)),
      );
      await cleanupDiscardedStagedCreates(responseId, result.stagedCreates.discarded);
      stagedCreates.delete(responseId);
      return mapResult(result);
    },

    async rollbackResponse(
      responseIdentity: ModelResponseIdentity,
      ctx: Pick<ToolHandlerContext, "threadId" | "turnId">,
    ): Promise<void> {
      const responseId = responseIdentity.editScopeId;
      const result = await deps.documentSync.finalizeResponseRollback(responseIdentity, ctx);
      try {
        await cleanupDiscardedStagedCreates(responseId, result.stagedCreates.discarded);
      } finally {
        stagedCreates.delete(responseId);
      }
    },
  };
}
