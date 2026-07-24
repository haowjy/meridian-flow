/** Turn reversal orchestration across live documents and work-draft branches. */
import type { ReversalOutcome } from "@meridian/contracts/protocol";
import type { UserId } from "@meridian/contracts/runtime";
import type { TurnReversalAccess } from "../contracts.js";
import type { BranchStore } from "./branch-coordinator.js";
import type { BranchJournalReadStore, BranchReviewService } from "./branch-push-contracts.js";
import { type ReverseTurnDeps, reverseTurn } from "./turn-reversal.js";

export function createTurnReversalService(input: {
  live: Required<ReverseTurnDeps>;
  branchReview: BranchReviewService;
  branchJournal: Pick<BranchJournalReadStore, "listJournalRowsForTurn">;
  branches: Pick<BranchStore, "getBranch">;
  resolveDocumentUri(documentId: string): Promise<string | null>;
}): TurnReversalAccess {
  return {
    async reverseTurn(command) {
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
    },
  };
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
