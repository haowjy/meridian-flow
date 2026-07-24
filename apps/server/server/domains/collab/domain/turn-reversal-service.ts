/** Turn reversal orchestration across live documents and work-draft branches. */
import { parseWriteHandle, type ReversalSelection } from "@meridian/agent-edit/integration";
import type { ReversalOutcome } from "@meridian/contracts/protocol";
import type { DocumentId, ProjectId, UserId } from "@meridian/contracts/runtime";
import {
  ReverseThreadContextError,
  type ReverseThreadContextInput,
  type TurnReversalAccess,
} from "../contracts.js";
import type { ThreadPeerAgentEditCore } from "./agent-edit-cores.js";
import type { BranchStore } from "./branch-coordinator.js";
import type { BranchJournalReadStore, BranchReviewService } from "./branch-push-contracts.js";
import {
  aggregateStatus,
  documentReversalResult,
  isSuccessfulReversal,
  type ReverseTurnDeps,
  reverseTurn,
} from "./turn-reversal.js";

export type ThreadContextReversalResolver = {
  requireThreadOwner(input: {
    threadId: string;
    userId: string;
  }): Promise<{ projectId: ProjectId }>;
  resolveContextDocument(input: {
    threadId: string;
    userId: string;
    uri: string;
  }): Promise<{ documentId?: string | null }>;
};

export type TurnReversalServiceDeps = {
  live: Required<ReverseTurnDeps>;
  agentEdit: Pick<ThreadPeerAgentEditCore, "reverse">;
  branchReview: BranchReviewService;
  branchJournal: Pick<BranchJournalReadStore, "listJournalRowsForTurn">;
  branches: Pick<BranchStore, "getBranch">;
  resolveDocumentUri(documentId: string): Promise<string | null>;
  listEditedDocumentsForTurn(
    threadId: string,
    turnId: string,
  ): Promise<Array<{ documentId: string }>>;
  documentAccess: {
    canAccessDocument(userId: UserId, documentId: string): Promise<boolean>;
    canAccessProjectDocument(
      userId: UserId,
      documentId: string,
      projectId: ProjectId,
    ): Promise<boolean>;
  };
  threadContext: ThreadContextReversalResolver;
};

export function createTurnReversalService(input: TurnReversalServiceDeps): TurnReversalAccess {
  const reverseTurnAcrossScopes = async (
    command: Parameters<TurnReversalAccess["reverseTurn"]>[0],
  ): Promise<ReversalOutcome> => {
    const liveOutcome = await reverseTurn(input.live, command);
    const statuses =
      command.direction === "undo" ? (["active"] as const) : (["discarded"] as const);
    const rows = await input.branchJournal.listJournalRowsForTurn({
      threadId: command.threadId,
      turnId: command.turnId,
      statuses,
    });
    const branchIds = [...new Set(rows.map((row) => row.branchId))];
    if (branchIds.length === 0) return liveOutcome;
    const documents = [...liveOutcome.documents];
    for (const branchId of branchIds) {
      const branch = await input.branches.getBranch(branchId);
      if (!branch) continue;
      const result = await input.branchReview.reverseBranchTurn({
        branchId,
        threadId: command.threadId,
        turnId: command.turnId,
        direction: command.direction,
        reviewedByUserId:
          command.actor.type === "user" ? (command.actor.userId as UserId) : undefined,
      });
      documents.push({
        uri: (await input.resolveDocumentUri(branch.documentId)) ?? branch.documentId,
        status: result.status,
      });
    }
    return {
      status: aggregateTurnReverseStatus(command.direction, documents),
      documents,
    };
  };

  return {
    reverseTurn: reverseTurnAcrossScopes,

    async reverseThreadContext(command) {
      validateThreadContextSelection(command);
      if (!command.uri) {
        const { projectId } = await input.threadContext.requireThreadOwner(command);
        const lineage = await input.listEditedDocumentsForTurn(command.threadId, command.turnId);
        const access = await Promise.all(
          lineage.map(async ({ documentId }) => {
            const [hasDocumentAccess, isProjectDocument] = await Promise.all([
              input.documentAccess.canAccessDocument(command.userId, documentId),
              input.documentAccess.canAccessProjectDocument(command.userId, documentId, projectId),
            ]);
            return { documentId, allowed: hasDocumentAccess && isProjectDocument };
          }),
        );
        const documentIds = access
          .filter((entry) => entry.allowed)
          .map((entry) => entry.documentId as DocumentId);
        return reverseTurnAcrossScopes({
          threadId: command.threadId,
          turnId: command.turnId,
          direction: command.direction,
          actor: { type: "user", userId: command.userId },
          documentIds: [...new Set(documentIds)],
        });
      }

      const selection = reversalSelection(command);
      const document = await input.threadContext.resolveContextDocument({
        threadId: command.threadId,
        userId: command.userId,
        uri: command.uri,
      });
      if (!document.documentId) {
        throw new ReverseThreadContextError("document_not_found", "Document not found");
      }
      const outcome = await input.agentEdit.reverse({
        docId: document.documentId,
        threadId: command.threadId,
        direction: command.direction,
        selection,
        actor: { type: "user", userId: command.userId },
      });
      if (isSuccessfulReversal(outcome)) {
        await input.live.refreshDocumentProjection({
          documentId: document.documentId as DocumentId,
          threadId: command.threadId,
        });
      }
      const documents = [
        await documentReversalResult({
          documentId: document.documentId,
          outcome,
          resolveDocumentUri: async () => command.uri ?? null,
        }),
      ];
      return { status: aggregateStatus(command.direction, documents), documents };
    },
  };
}

function validateThreadContextSelection(input: ReverseThreadContextInput): void {
  if (input.scope === "write" && !input.uri) {
    throw new ReverseThreadContextError("invalid_scope", "uri required for write scope");
  }
  if (input.scope === "thread" && !input.uri) {
    throw new ReverseThreadContextError("invalid_scope", "uri required for thread scope");
  }
  if (input.scope === "turn" && !input.selection) {
    throw new ReverseThreadContextError("invalid_scope", "target is required for turn scope");
  }
  if (input.scope === "thread" && input.selection !== undefined) {
    throw new ReverseThreadContextError("invalid_scope", "thread scope does not accept target");
  }
}

function reversalSelection(input: ReverseThreadContextInput): ReversalSelection {
  if (input.scope === "write") {
    if (input.selection === undefined) return { kind: "latest" };
    if (parseWriteHandle(input.selection) === undefined) {
      throw new ReverseThreadContextError("invalid_write", "invalid_write");
    }
    return { kind: "single", to: input.selection };
  }
  if (input.scope === "turn") return { kind: "turn", turnId: input.selection ?? "" };
  return { kind: "all" };
}

function aggregateTurnReverseStatus(
  direction: "undo" | "redo",
  documents: readonly { status: string }[],
): ReversalOutcome["status"] {
  const noOp = direction === "undo" ? "nothing_to_undo" : "nothing_to_redo";
  const success = direction === "undo" ? "reversed" : "reconciled";
  const statuses = documents.map((document) => document.status);
  if (statuses.length === 0 || statuses.every((status) => status === noOp)) return noOp;
  if (statuses.every((status) => status === success || status === noOp)) return success;
  if (statuses.includes("cant_undo_dependent")) return "cant_undo_dependent";
  return "partial";
}
