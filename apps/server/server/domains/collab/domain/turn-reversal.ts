/** Turn-level reversal orchestration across every document a thread turn touched. */
import { renderAgentEditResult, type WriteOutcome } from "@meridian/agent-edit/integration";
import type { DocumentReversalResult } from "@meridian/contracts/protocol";

/** One document's reversal status and the text the agent would see for it. */
type DocumentReversalOutcome = Pick<DocumentReversalResult, "status" | "text">;

export function documentReversalOutcome(outcome: WriteOutcome): DocumentReversalOutcome {
  return { status: outcome.status, text: renderAgentEditResult(outcome.result) };
}

export async function documentReversalResult(input: {
  documentId: string;
  outcome: DocumentReversalOutcome;
  resolveDocumentUri: (documentId: string) => Promise<string | null>;
}): Promise<DocumentReversalResult> {
  return {
    uri: (await input.resolveDocumentUri(input.documentId)) ?? input.documentId,
    status: input.outcome.status,
    ...(input.outcome.text ? { text: input.outcome.text } : {}),
  };
}

export function aggregateStatus(
  direction: "undo" | "redo",
  documents: readonly Pick<DocumentReversalResult, "status">[],
): DocumentReversalResult["status"] {
  const statuses = documents.map((document) => document.status);
  const noOp = direction === "undo" ? "nothing_to_undo" : "nothing_to_redo";
  const successes = new Set(["reversed", "reconciled"]);

  if (statuses.every((status) => status === noOp)) return noOp;
  if (statuses.every((status) => status === "permission_denied")) return "permission_denied";
  if (statuses.every((status) => successes.has(status))) {
    return statuses.includes("reconciled") ? "reconciled" : "reversed";
  }
  if (statuses.includes("cant_undo_dependent")) return "cant_undo_dependent";
  if (statuses.every((status) => status === "expired")) return "expired";
  return "partial";
}

export function isSuccessfulReversal(outcome: Pick<WriteOutcome, "status">): boolean {
  return outcome.status === "reversed" || outcome.status === "reconciled";
}
