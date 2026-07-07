/** Turn-level reversal orchestration across every document a thread turn touched. */
import type { ReversalActor, ReversalStore, WriteOutcome } from "@meridian/agent-edit";
import type { DocumentReversalResult, ReversalOutcome } from "@meridian/contracts/protocol";
import type { DocumentId, ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { LiveAgentEditCore } from "./agent-edit-cores.js";

export interface ReverseTurnInput {
  threadId: ThreadId;
  turnId: TurnId;
  direction: "undo" | "redo";
  actor: ReversalActor;
  documentIds?: DocumentId[];
}

export interface ReverseTurnDeps {
  reversalStore: ReversalStore;
  agentEdit: Pick<LiveAgentEditCore, "reverse">;
  resolveDocumentUri(documentId: string): Promise<string | null>;
  refreshDocumentProjection?(input: { documentId: DocumentId; threadId: ThreadId }): Promise<void>;
}

export async function reverseTurn(
  deps: ReverseTurnDeps,
  input: ReverseTurnInput,
): Promise<ReversalOutcome> {
  const documentIds =
    input.documentIds ?? (await deps.reversalStore.documentsForTurn(input.threadId, input.turnId));
  if (documentIds.length === 0) {
    return {
      status: input.direction === "undo" ? "nothing_to_undo" : "nothing_to_redo",
      documents: [],
    };
  }

  const documents: DocumentReversalResult[] = [];
  for (const documentId of documentIds) {
    const outcome = await reverseDocumentForTurn(deps, input, documentId);
    if (isSuccessfulReversal(outcome)) {
      await deps.refreshDocumentProjection?.({
        documentId: documentId as DocumentId,
        threadId: input.threadId,
      });
    }
    documents.push(
      await documentReversalResult({
        documentId,
        outcome,
        resolveDocumentUri: deps.resolveDocumentUri,
      }),
    );
  }

  return { status: aggregateStatus(input.direction, documents), documents };
}

async function reverseDocumentForTurn(
  deps: ReverseTurnDeps,
  input: ReverseTurnInput,
  documentId: DocumentId,
): Promise<Pick<WriteOutcome, "status" | "text">> {
  return deps.agentEdit.reverse({
    docId: documentId,
    threadId: input.threadId,
    direction: input.direction,
    selection: { kind: "turn", turnId: input.turnId },
    actor: input.actor,
  });
}

export async function documentReversalResult(input: {
  documentId: string;
  outcome: Pick<WriteOutcome, "status" | "text">;
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
  const success = direction === "undo" ? "reversed" : "reconciled";
  const noOp = direction === "undo" ? "nothing_to_undo" : "nothing_to_redo";

  if (statuses.every((status) => status === noOp)) return noOp;
  if (statuses.every((status) => status === success || status === noOp)) return success;
  if (statuses.every((status) => status === "reversed" || status === noOp)) return "reversed";
  if (statuses.every((status) => status === "expired")) return "expired";
  return "partial";
}

export function isSuccessfulReversal(outcome: Pick<WriteOutcome, "status">): boolean {
  return outcome.status === "reversed" || outcome.status === "reconciled";
}
