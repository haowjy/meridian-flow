/**
 * The reply's write lifecycle (D42): staged creates to discard, the commit
 * that saves every staged write in one transaction, and the rollback.
 */
import type {
  ConcurrentEditInfo,
  ResponseCommitWriteReceipt,
  ResponseStagedCreateOutcome,
} from "@meridian/agent-edit/integration";
import type { ModelResponseIdentity } from "@meridian/contracts";
import type { PermissionDeniedReason } from "@meridian/contracts/protocol";
import type { ContextPort } from "../../domains/context/ports/context-port.js";
import type { FileAccessDenied } from "../../domains/file-policy/index.js";
import type { ToolHandlerContext } from "../../domains/runtime/index.js";
import {
  deletedFileMessage,
  isPermissionDenial,
  permissionDeniedMessage,
} from "../file-access-denial-copy.js";
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
    ctx: Pick<ToolHandlerContext, "threadId" | "turnId">,
    beforeTransactionCommit?: (result: ResponseWriteLifecycleCommitResult) => Promise<void>,
  ): Promise<ResponseWriteLifecycleCommitResult>;
  rollbackResponse(
    responseIdentity: ModelResponseIdentity,
    ctx: Pick<ToolHandlerContext, "threadId" | "turnId">,
  ): Promise<void>;
}

type ResponseWriteLifecycleCommitResult =
  | {
      status: "committed";
      receipts: Array<{ documentId: string; receipt: ResponseCommitWriteReceipt }>;
      concurrentEdits: { documentId: string; concurrentEdits: ConcurrentEditInfo }[];
      /** Documents the save left out, with the copy their writes' results now carry (D29). */
      refused: Array<{ documentId: string; message: string; reason?: PermissionDeniedReason }>;
    }
  | { status: "branch_closed"; responseId: string; mode: "draft" };

/** Why the reply's save left out a document's changes (D29, D42). */
function refusedAtSave(denial: FileAccessDenied): {
  message: string;
  reason?: PermissionDeniedReason;
} {
  if (!isPermissionDenial(denial)) return { message: deletedFileMessage("save") };
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
}): Promise<void> {
  const retracted = await input.port.retractCreate(input.path, { documentId: input.documentId });
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
      await retractCreatedTrackedDocument(record);
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
      ctx: Pick<ToolHandlerContext, "threadId" | "turnId">,
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
          concurrentEdits: result.documents.flatMap((document) =>
            document.concurrentEdits
              ? [{ documentId: document.documentId, concurrentEdits: document.concurrentEdits }]
              : [],
          ),
          // A refusal with a reason is receipted write by write in `documents`.
          refused: result.refused.flatMap((refusal) =>
            "denial" in refusal
              ? [{ documentId: refusal.documentId, ...refusedAtSave(refusal.denial) }]
              : [],
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
