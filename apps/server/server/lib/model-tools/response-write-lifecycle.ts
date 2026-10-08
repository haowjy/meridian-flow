/**
 * The reply's write lifecycle (D42): staged creates to discard, moves and
 * deletes to reverse, the commit that saves every staged write in one
 * transaction, and the rollback. Rollback alone forgets handles.
 */
import type {
  ConcurrentEditInfo,
  ResponseCommitWriteReceipt,
  ResponseStagedCreateOutcome,
} from "@meridian/agent-edit/integration";
import type { PermissionDeniedReason } from "@meridian/contracts/protocol";
import type { NamespaceChangeRecord } from "../../domains/collab/index.js";
import type { ContextError, ContextPort } from "../../domains/context/ports/context-port.js";
import type { FileAccessDenied } from "../../domains/file-policy/index.js";
import { emitEvent, unknownToEventPayload } from "../../domains/observability/index.js";
import type { ToolHandlerContext } from "../../domains/runtime/index.js";
import {
  deletedFileMessage,
  isPermissionDenial,
  permissionDeniedMessage,
} from "../file-access-denial-copy.js";
import { namespaceTree } from "../namespace-tree.js";
import { contextErrorMessage, type ToolWiringDeps } from "./tool-context.js";

function isContextError(value: unknown): value is ContextError {
  return typeof value === "object" && value !== null && "code" in value && "uri" in value;
}

type StagedCreateCleanup = {
  responseId: string;
  port: ContextPort;
  /** Where the document is now: a move in the same reply carries it along. */
  path: string;
  documentId: string;
  /** The create's handle, forgotten with the document; none in a draft. */
  createId?: number;
};

/**
 * A move or delete committed when the tool was called (D66), reversed if its
 * reply rolls back. `port` writes live, the version the change landed in.
 */
type StagedNamespaceChange = {
  responseId: string;
  port: ContextPort;
  change: NamespaceChangeRecord;
};

export interface AgentEditResponseWriteLifecycle {
  trackStagedCreate(input: StagedCreateCleanup): void;
  trackStagedNamespaceChange(input: StagedNamespaceChange): void;
  commitResponse(
    responseId: string,
    ctx: Pick<ToolHandlerContext, "threadId" | "turnId">,
    beforeTransactionCommit?: (result: ResponseWriteLifecycleCommitResult) => Promise<void>,
  ): Promise<ResponseWriteLifecycleCommitResult>;
  rollbackResponse(
    responseId: string,
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
  | { status: "draft_closed"; responseId: string; mode: "draft" };

/** Why the reply's save left out a document's changes (D29, D42). */
function refusedAtSave(denial: FileAccessDenied): {
  message: string;
  reason?: PermissionDeniedReason;
} {
  if (!isPermissionDenial(denial)) return { message: deletedFileMessage("save") };
  return { message: permissionDeniedMessage(denial), reason: denial.reason };
}

export async function deleteCreatedTrackedDocument(input: {
  port: ContextPort;
  path: string;
  documentId: string;
}): Promise<void> {
  const deleted = await input.port.delete(input.path, {
    expected: { kind: "file", documentId: input.documentId },
  });
  // An archived Work changes nothing, so a create refused there stays until it's unarchived.
  const gone = ["not_found", "stale_target", "context_unavailable"];
  if (!deleted.ok && !gone.includes(deleted.error.code)) {
    throw new Error(contextErrorMessage(deleted.error));
  }
}

export function createAgentEditResponseWriteLifecycle(
  deps: Pick<ToolWiringDeps, "documentSync" | "eventSink">,
): AgentEditResponseWriteLifecycle {
  const { namespaceChanges } = deps.documentSync;
  const stagedCreates = new Map<string, StagedCreateCleanup[]>();
  const stagedNamespaceChanges = new Map<string, StagedNamespaceChange[]>();

  /** A staged create's document follows its moves, so its cleanup finds it (by id, wherever it is). */
  function relocateStagedCreate(responseId: string, documentId: string, uri: string): void {
    for (const record of stagedCreates.get(responseId) ?? []) {
      if (record.documentId === documentId) record.path = uri;
    }
  }

  /**
   * Newest first, so a document moved twice in one reply walks back to where
   * it began. Every change gets its turn: one that can't go back (the writer
   * took its old path, say) stays and is logged, and the rest still reverse.
   * Every handle of the reply is forgotten, since the reply never happened.
   */
  async function reverseStagedNamespaceChanges(
    responseId: string,
    ctx: Pick<ToolHandlerContext, "threadId" | "turnId">,
  ): Promise<void> {
    const staged = stagedNamespaceChanges.get(responseId) ?? [];
    for (const { port, change } of [...staged].reverse()) {
      let failure: unknown;
      try {
        const reversed = await namespaceChanges.reverse(namespaceTree(port), change, "undo");
        // The writer may have restored a delete already; only a change still in effect goes back.
        if (!reversed.ok && reversed.error.code !== "claimed") failure = reversed.error;
      } catch (cause) {
        failure = cause;
      }
      if (failure === undefined) {
        if (change.kind === "move") {
          relocateStagedCreate(responseId, change.documentId, change.fromUri);
        }
        continue;
      }
      emitEvent(deps.eventSink, {
        level: "warn",
        source: "lib.model-tools",
        name: "response_rollback.failed",
        correlation: { threadId: ctx.threadId, turnId: ctx.turnId ?? undefined },
        payload: {
          responseId,
          documentId: change.documentId,
          change: change.kind,
          writeId: change.wId,
          ...(isContextError(failure)
            ? { reason: contextErrorMessage(failure) }
            : unknownToEventPayload(failure)),
        },
      });
    }
    await namespaceChanges.discard(staged.map(({ change }) => change.id));
  }

  async function cleanupDiscardedStagedCreates(
    responseId: string,
    discardedDocumentIds: ResponseStagedCreateOutcome["discarded"],
  ): Promise<void> {
    const records = stagedCreates.get(responseId) ?? [];
    const discarded = new Set(discardedDocumentIds);
    // A discarded document's handles go with it.
    await namespaceChanges.discard([
      ...records.flatMap((record) =>
        discarded.has(record.documentId) && record.createId !== undefined ? [record.createId] : [],
      ),
      ...(stagedNamespaceChanges.get(responseId) ?? []).flatMap(({ change }) =>
        discarded.has(change.documentId) ? [change.id] : [],
      ),
    ]);
    for (const record of records) {
      if (!discarded.has(record.documentId)) continue;
      await deleteCreatedTrackedDocument(record);
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

    trackStagedNamespaceChange(input: StagedNamespaceChange): void {
      const { change } = input;
      if (change.kind === "move")
        relocateStagedCreate(input.responseId, change.documentId, change.toUri);
      const changes = stagedNamespaceChanges.get(input.responseId) ?? [];
      changes.push(input);
      stagedNamespaceChanges.set(input.responseId, changes);
    },

    async commitResponse(
      responseId: string,
      ctx: Pick<ToolHandlerContext, "threadId" | "turnId">,
      beforeTransactionCommit?: (result: ResponseWriteLifecycleCommitResult) => Promise<void>,
    ): Promise<ResponseWriteLifecycleCommitResult> {
      const mapResult = (
        result: Awaited<ReturnType<typeof deps.documentSync.finalizeResponseCommit>>,
      ): ResponseWriteLifecycleCommitResult => {
        if (result.status === "draft_closed") {
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
          refused: result.refused.map((refusal) => ({
            documentId: refusal.documentId,
            ...refusedAtSave(refusal.denial),
          })),
        };
      };
      const result = await deps.documentSync.finalizeResponseCommit(
        responseId,
        ctx,
        async (commitResult) => beforeTransactionCommit?.(mapResult(commitResult)),
      );
      await cleanupDiscardedStagedCreates(responseId, result.stagedCreates.discarded);
      stagedCreates.delete(responseId);
      stagedNamespaceChanges.delete(responseId);
      return mapResult(result);
    },

    async rollbackResponse(
      responseId: string,
      ctx: Pick<ToolHandlerContext, "threadId" | "turnId">,
    ): Promise<void> {
      const result = await deps.documentSync.finalizeResponseRollback(responseId, ctx);
      try {
        // Before the creates: a document created then moved is discarded from where it began.
        await reverseStagedNamespaceChanges(responseId, ctx);
      } finally {
        stagedNamespaceChanges.delete(responseId);
        try {
          await cleanupDiscardedStagedCreates(responseId, result.stagedCreates.discarded);
        } finally {
          stagedCreates.delete(responseId);
        }
      }
    },
  };
}
